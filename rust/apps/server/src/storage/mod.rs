use std::{path::Path, time::Duration};

use p2p_domain::{
    EpochMillis, RequestId, Revision, Room, RoomCode, RoomCommand, RoomCommandOutcome, RoomId,
    Session, SessionId,
};
use sqlx::{
    SqliteConnection, SqlitePool,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous},
};

mod codec;
mod error;

use codec::{
    corrupt, decode_join_request, decode_membership, decode_request_id, decode_room,
    decode_room_code, decode_session, join_request_state_text, membership_role_text,
    membership_state_parts, room_state_text, session_state_text, sql_integer, unsigned_sql_integer,
};
pub use error::StorageError;
use error::map_write_error;

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

const DEFAULT_MAX_CONNECTIONS: u32 = 8;
const DEFAULT_BUSY_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Debug)]
pub struct Storage {
    pool: SqlitePool,
}

impl Storage {
    pub async fn connect(path: impl AsRef<Path>) -> Result<Self, StorageError> {
        let path = path.as_ref();
        if let Some(parent) = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            std::fs::create_dir_all(parent).map_err(StorageError::CreateDirectory)?;
        }

        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .foreign_keys(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Normal)
            .busy_timeout(DEFAULT_BUSY_TIMEOUT);
        let pool = SqlitePoolOptions::new()
            .max_connections(DEFAULT_MAX_CONNECTIONS)
            .connect_with(options)
            .await?;
        MIGRATOR.run(&pool).await?;

        let storage = Self { pool };
        storage.verify_configuration().await?;
        Ok(storage)
    }

    pub fn pool(&self) -> &SqlitePool {
        &self.pool
    }

    pub async fn close(&self) {
        self.pool.close().await;
    }

    pub async fn ready(&self) -> Result<(), StorageError> {
        sqlx::query("SELECT 1").execute(&self.pool).await?;
        Ok(())
    }

    async fn verify_configuration(&self) -> Result<(), StorageError> {
        let foreign_keys: i64 = sqlx::query_scalar("PRAGMA foreign_keys")
            .fetch_one(&self.pool)
            .await?;
        if foreign_keys != 1 {
            return Err(StorageError::InvalidConfiguration(
                "SQLite foreign_keys pragma is disabled",
            ));
        }

        let journal_mode: String = sqlx::query_scalar("PRAGMA journal_mode")
            .fetch_one(&self.pool)
            .await?;
        if !journal_mode.eq_ignore_ascii_case("wal") {
            return Err(StorageError::InvalidConfiguration(
                "SQLite journal_mode is not WAL",
            ));
        }
        Ok(())
    }

    pub async fn insert_session(
        &self,
        session: &Session,
        now: EpochMillis,
    ) -> Result<(), StorageError> {
        sqlx::query(
            r#"
            INSERT INTO sessions (
                id, display_name, state, created_at_ms, expires_at_ms, updated_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(session.id().as_str())
        .bind(session.display_name().as_str())
        .bind(session_state_text(session.state()))
        .bind(sql_integer(now.value())?)
        .bind(sql_integer(session.expires_at().value())?)
        .bind(sql_integer(now.value())?)
        .execute(&self.pool)
        .await
        .map_err(map_write_error)?;
        Ok(())
    }

    pub async fn find_session(
        &self,
        session_id: &SessionId,
    ) -> Result<Option<Session>, StorageError> {
        let row =
            sqlx::query("SELECT id, display_name, state, expires_at_ms FROM sessions WHERE id = ?")
                .bind(session_id.as_str())
                .fetch_optional(&self.pool)
                .await?;

        row.map(decode_session).transpose()
    }

    pub async fn insert_room(
        &self,
        room: &Room,
        create_request_id: &RequestId,
        now: EpochMillis,
    ) -> Result<(), StorageError> {
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        sqlx::query(
            r#"
            INSERT INTO rooms (
                id, code, owner_session_id, create_request_id, state, revision,
                created_at_ms, expires_at_ms, updated_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(room.id().as_str())
        .bind(room.code().as_str())
        .bind(room.owner().as_str())
        .bind(create_request_id.as_str())
        .bind(room_state_text(room.state()))
        .bind(sql_integer(room.revision().value())?)
        .bind(sql_integer(now.value())?)
        .bind(sql_integer(room.expires_at().value())?)
        .bind(sql_integer(now.value())?)
        .execute(&mut *transaction)
        .await
        .map_err(map_write_error)?;

        persist_room_children(&mut transaction, room, now).await?;
        transaction.commit().await?;
        Ok(())
    }

    pub async fn find_room_by_create_request(
        &self,
        owner: &SessionId,
        request_id: &RequestId,
    ) -> Result<Option<Room>, StorageError> {
        let code: Option<String> = sqlx::query_scalar(
            "SELECT code FROM rooms WHERE owner_session_id = ? AND create_request_id = ?",
        )
        .bind(owner.as_str())
        .bind(request_id.as_str())
        .fetch_optional(&self.pool)
        .await?;
        let Some(code) = code else {
            return Ok(None);
        };
        let parsed =
            RoomCode::parse(&code).map_err(|error| corrupt("rooms.code", code.clone(), error))?;
        self.find_room_by_code(&parsed).await
    }

    pub async fn find_room_by_code(&self, code: &RoomCode) -> Result<Option<Room>, StorageError> {
        let mut connection = self.pool.acquire().await?;
        load_room_on(&mut connection, code).await
    }

    pub async fn apply_room_command(
        &self,
        code: &RoomCode,
        expected_revision: Option<Revision>,
        command: RoomCommand,
        now: EpochMillis,
    ) -> Result<RoomMutation, StorageError> {
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let mut room = load_room_on(&mut transaction, code)
            .await?
            .ok_or(StorageError::RoomNotFound)?;
        let before = room.revision();

        if let Some(expected) = expected_revision.filter(|expected| *expected != before) {
            return Err(StorageError::RevisionConflict {
                expected: expected.value(),
                actual: before.value(),
            });
        }

        let outcome = room.handle(command)?;
        if outcome.changed() {
            let result = sqlx::query(
                r#"
                UPDATE rooms
                SET state = ?, revision = ?, expires_at_ms = ?, updated_at_ms = ?
                WHERE id = ? AND revision = ?
                "#,
            )
            .bind(room_state_text(room.state()))
            .bind(sql_integer(room.revision().value())?)
            .bind(sql_integer(room.expires_at().value())?)
            .bind(sql_integer(now.value())?)
            .bind(room.id().as_str())
            .bind(sql_integer(before.value())?)
            .execute(&mut *transaction)
            .await?;

            if result.rows_affected() != 1 {
                return Err(StorageError::RevisionConflict {
                    expected: before.value(),
                    actual: current_revision(&mut transaction, room.id()).await?,
                });
            }
            persist_room_children(&mut transaction, &room, now).await?;
        }

        transaction.commit().await?;
        Ok(RoomMutation { room, outcome })
    }

    pub async fn expire_due_sessions(
        &self,
        now: EpochMillis,
        limit: u32,
    ) -> Result<u64, StorageError> {
        let result = sqlx::query(
            r#"
            UPDATE sessions
            SET state = 'expired', updated_at_ms = ?
            WHERE id IN (
                SELECT id FROM sessions
                WHERE state = 'active' AND expires_at_ms <= ?
                ORDER BY expires_at_ms
                LIMIT ?
            )
            "#,
        )
        .bind(sql_integer(now.value())?)
        .bind(sql_integer(now.value())?)
        .bind(i64::from(limit))
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected())
    }

    pub async fn expire_due_rooms(
        &self,
        now: EpochMillis,
        limit: u32,
    ) -> Result<Vec<RoomMutation>, StorageError> {
        let rows = sqlx::query(
            r#"
            SELECT code FROM rooms
            WHERE state = 'active' AND expires_at_ms <= ?
            ORDER BY expires_at_ms
            LIMIT ?
            "#,
        )
        .bind(sql_integer(now.value())?)
        .bind(i64::from(limit))
        .fetch_all(&self.pool)
        .await?;
        let mut mutations = Vec::with_capacity(rows.len());
        for row in rows {
            let code = decode_room_code(&row, "code")?;
            let mutation = self
                .apply_room_command(&code, None, RoomCommand::Expire { now }, now)
                .await?;
            if mutation.outcome.changed() {
                mutations.push(mutation);
            }
        }
        Ok(mutations)
    }

    pub async fn expire_due_join_requests(
        &self,
        now: EpochMillis,
        limit: u32,
    ) -> Result<Vec<RoomMutation>, StorageError> {
        let rows = sqlx::query(
            r#"
            SELECT rooms.code AS room_code, join_requests.id AS request_id
            FROM join_requests
            JOIN rooms ON rooms.id = join_requests.room_id
            WHERE join_requests.state = 'pending'
              AND join_requests.expires_at_ms <= ?
              AND rooms.state = 'active'
              AND rooms.expires_at_ms > ?
            ORDER BY join_requests.expires_at_ms
            LIMIT ?
            "#,
        )
        .bind(sql_integer(now.value())?)
        .bind(sql_integer(now.value())?)
        .bind(i64::from(limit))
        .fetch_all(&self.pool)
        .await?;
        let mut mutations = Vec::with_capacity(rows.len());
        for row in rows {
            let code = decode_room_code(&row, "room_code")?;
            let request_id = decode_request_id(&row, "request_id")?;
            let mutation = self
                .apply_room_command(
                    &code,
                    None,
                    RoomCommand::ExpireJoinRequest { request_id, now },
                    now,
                )
                .await?;
            if mutation.outcome.changed() {
                mutations.push(mutation);
            }
        }
        Ok(mutations)
    }

    pub async fn insert_invite_capability(
        &self,
        capability_id: &str,
        room_id: &RoomId,
        request_id: &RequestId,
        capability_hash: &[u8; 32],
        now: EpochMillis,
        expires_at: EpochMillis,
    ) -> Result<(), StorageError> {
        sqlx::query(
            r#"
            INSERT INTO invite_capabilities (
                id, room_id, request_id, capability_hash,
                created_at_ms, expires_at_ms, consumed_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, NULL)
            "#,
        )
        .bind(capability_id)
        .bind(room_id.as_str())
        .bind(request_id.as_str())
        .bind(capability_hash.as_slice())
        .bind(sql_integer(now.value())?)
        .bind(sql_integer(expires_at.value())?)
        .execute(&self.pool)
        .await
        .map_err(map_write_error)?;
        Ok(())
    }

    pub async fn find_invite_expiry(
        &self,
        room_id: &RoomId,
        request_id: &RequestId,
    ) -> Result<Option<EpochMillis>, StorageError> {
        let expiry: Option<i64> = sqlx::query_scalar(
            "SELECT expires_at_ms FROM invite_capabilities WHERE room_id = ? AND request_id = ?",
        )
        .bind(room_id.as_str())
        .bind(request_id.as_str())
        .fetch_optional(&self.pool)
        .await?;
        expiry
            .map(|value| {
                unsigned_sql_integer(value, "invite_capabilities.expires_at_ms")
                    .map(EpochMillis::new)
            })
            .transpose()
    }

    pub async fn validate_invite_capability(
        &self,
        room_id: &RoomId,
        capability_hash: &[u8; 32],
        now: EpochMillis,
    ) -> Result<bool, StorageError> {
        let exists: i64 = sqlx::query_scalar(
            r#"
            SELECT EXISTS (
                SELECT 1 FROM invite_capabilities
                WHERE room_id = ?
                  AND capability_hash = ?
                  AND expires_at_ms > ?
                  AND consumed_at_ms IS NULL
            )
            "#,
        )
        .bind(room_id.as_str())
        .bind(capability_hash.as_slice())
        .bind(sql_integer(now.value())?)
        .fetch_one(&self.pool)
        .await?;
        Ok(exists == 1)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RoomMutation {
    pub room: Room,
    pub outcome: RoomCommandOutcome,
}

async fn load_room_on(
    connection: &mut SqliteConnection,
    code: &RoomCode,
) -> Result<Option<Room>, StorageError> {
    let Some(row) = sqlx::query(
        r#"
        SELECT id, code, owner_session_id, state, revision, expires_at_ms
        FROM rooms
        WHERE code = ?
        "#,
    )
    .bind(code.as_str())
    .fetch_optional(&mut *connection)
    .await?
    else {
        return Ok(None);
    };

    let decoded = decode_room(&row)?;

    let member_rows = sqlx::query(
        r#"
        SELECT session_id, role, state, peer_id
        FROM room_members
        WHERE room_id = ?
        ORDER BY session_id
        "#,
    )
    .bind(decoded.id.as_str())
    .fetch_all(&mut *connection)
    .await?;
    let memberships = member_rows
        .into_iter()
        .map(|row| decode_membership(&row))
        .collect::<Result<Vec<_>, _>>()?;

    let request_rows = sqlx::query(
        r#"
        SELECT id, session_id, state, expires_at_ms
        FROM join_requests
        WHERE room_id = ?
        ORDER BY id
        "#,
    )
    .bind(decoded.id.as_str())
    .fetch_all(&mut *connection)
    .await?;
    let requests = request_rows
        .into_iter()
        .map(|row| decode_join_request(&row))
        .collect::<Result<Vec<_>, _>>()?;

    Room::restore(
        decoded.id,
        decoded.code,
        decoded.owner,
        decoded.expires_at,
        decoded.state,
        decoded.revision,
        memberships,
        requests,
    )
    .map(Some)
    .map_err(StorageError::CorruptRoom)
}

async fn persist_room_children(
    transaction: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    room: &Room,
    now: EpochMillis,
) -> Result<(), StorageError> {
    for membership in room.membership_snapshots() {
        let (state, peer_id) = membership_state_parts(&membership.state);
        sqlx::query(
            r#"
            INSERT INTO room_members (
                room_id, session_id, role, state, peer_id, created_at_ms, updated_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(room_id, session_id) DO UPDATE SET
                role = excluded.role,
                state = excluded.state,
                peer_id = excluded.peer_id,
                updated_at_ms = excluded.updated_at_ms
            "#,
        )
        .bind(room.id().as_str())
        .bind(membership.session_id.as_str())
        .bind(membership_role_text(membership.role))
        .bind(state)
        .bind(peer_id)
        .bind(sql_integer(now.value())?)
        .bind(sql_integer(now.value())?)
        .execute(&mut **transaction)
        .await
        .map_err(map_write_error)?;
    }

    for request in room.join_request_snapshots() {
        let insert_created_at = now
            .value()
            .min(request.expires_at.value().saturating_sub(1));
        sqlx::query(
            r#"
            INSERT INTO join_requests (
                id, room_id, session_id, state, created_at_ms, expires_at_ms, updated_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                state = excluded.state,
                expires_at_ms = excluded.expires_at_ms,
                updated_at_ms = excluded.updated_at_ms
            "#,
        )
        .bind(request.request_id.as_str())
        .bind(room.id().as_str())
        .bind(request.session_id.as_str())
        .bind(join_request_state_text(request.state))
        .bind(sql_integer(insert_created_at)?)
        .bind(sql_integer(request.expires_at.value())?)
        .bind(sql_integer(now.value())?)
        .execute(&mut **transaction)
        .await
        .map_err(map_write_error)?;
    }
    Ok(())
}

async fn current_revision(
    transaction: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    room_id: &RoomId,
) -> Result<u64, StorageError> {
    let revision: i64 = sqlx::query_scalar("SELECT revision FROM rooms WHERE id = ?")
        .bind(room_id.as_str())
        .fetch_one(&mut **transaction)
        .await?;
    unsigned_sql_integer(revision, "rooms.revision")
}

#[cfg(test)]
mod tests;
