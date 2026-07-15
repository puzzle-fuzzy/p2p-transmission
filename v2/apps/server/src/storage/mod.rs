use std::{path::Path, time::Duration};

use p2p_domain::{
    DisplayName, EpochMillis, JoinRequestState, MembershipRole, MembershipState, PeerId, RequestId,
    Revision, Room, RoomCode, RoomCommand, RoomCommandOutcome, RoomError, RoomId,
    RoomJoinRequestSnapshot, RoomMembershipSnapshot, RoomRestoreError, RoomState, Session,
    SessionId, SessionState,
};
use sqlx::{
    Row, SqliteConnection, SqlitePool,
    migrate::MigrateError,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous},
};
use thiserror::Error;

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
            let code_text: String = row.try_get("code")?;
            let code = RoomCode::parse(&code_text)
                .map_err(|error| corrupt("rooms.code", code_text, error))?;
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
            let code_text: String = row.try_get("room_code")?;
            let code = RoomCode::parse(&code_text)
                .map_err(|error| corrupt("rooms.code", code_text, error))?;
            let request_text: String = row.try_get("request_id")?;
            let request_id = RequestId::parse(request_text.clone())
                .map_err(|error| corrupt("join_requests.id", request_text, error))?;
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

    let room_id_text: String = row.try_get("id")?;
    let room_id = RoomId::parse(room_id_text.clone())
        .map_err(|error| corrupt("rooms.id", room_id_text, error))?;
    let room_code_text: String = row.try_get("code")?;
    let room_code = RoomCode::parse(&room_code_text)
        .map_err(|error| corrupt("rooms.code", room_code_text, error))?;
    let owner_text: String = row.try_get("owner_session_id")?;
    let owner = SessionId::parse(owner_text.clone())
        .map_err(|error| corrupt("rooms.owner_session_id", owner_text, error))?;
    let state = parse_room_state(row.try_get("state")?)?;
    let revision = Revision::new(unsigned_sql_integer(
        row.try_get("revision")?,
        "rooms.revision",
    )?);
    let expires_at = EpochMillis::new(unsigned_sql_integer(
        row.try_get("expires_at_ms")?,
        "rooms.expires_at_ms",
    )?);

    let member_rows = sqlx::query(
        r#"
        SELECT session_id, role, state, peer_id
        FROM room_members
        WHERE room_id = ?
        ORDER BY session_id
        "#,
    )
    .bind(room_id.as_str())
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
    .bind(room_id.as_str())
    .fetch_all(&mut *connection)
    .await?;
    let requests = request_rows
        .into_iter()
        .map(|row| decode_join_request(&row))
        .collect::<Result<Vec<_>, _>>()?;

    Room::restore(
        room_id,
        room_code,
        owner,
        expires_at,
        state,
        revision,
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

fn decode_session(row: sqlx::sqlite::SqliteRow) -> Result<Session, StorageError> {
    let id_text: String = row.try_get("id")?;
    let id = SessionId::parse(id_text.clone())
        .map_err(|error| corrupt("sessions.id", id_text, error))?;
    let display_name_text: String = row.try_get("display_name")?;
    let display_name = DisplayName::parse(&display_name_text)
        .map_err(|error| corrupt("sessions.display_name", display_name_text, error))?;
    let state = parse_session_state(row.try_get("state")?)?;
    let expires_at = EpochMillis::new(unsigned_sql_integer(
        row.try_get("expires_at_ms")?,
        "sessions.expires_at_ms",
    )?);
    Ok(Session::restore(id, display_name, expires_at, state))
}

fn decode_membership(
    row: &sqlx::sqlite::SqliteRow,
) -> Result<RoomMembershipSnapshot, StorageError> {
    let session_text: String = row.try_get("session_id")?;
    let session_id = SessionId::parse(session_text.clone())
        .map_err(|error| corrupt("room_members.session_id", session_text, error))?;
    let role = parse_membership_role(row.try_get("role")?)?;
    let state_text: String = row.try_get("state")?;
    let peer_text: Option<String> = row.try_get("peer_id")?;
    let state = match (state_text.as_str(), peer_text) {
        ("offline", None) => MembershipState::Offline,
        ("left", None) => MembershipState::Left,
        ("online", Some(peer_id)) => MembershipState::Online {
            peer_id: PeerId::parse(peer_id.clone())
                .map_err(|error| corrupt("room_members.peer_id", peer_id, error))?,
        },
        _ => {
            return Err(StorageError::CorruptData(
                "room_members state/peer_id combination is invalid".to_owned(),
            ));
        }
    };
    Ok(RoomMembershipSnapshot {
        session_id,
        role,
        state,
    })
}

fn decode_join_request(
    row: &sqlx::sqlite::SqliteRow,
) -> Result<RoomJoinRequestSnapshot, StorageError> {
    let request_text: String = row.try_get("id")?;
    let request_id = RequestId::parse(request_text.clone())
        .map_err(|error| corrupt("join_requests.id", request_text, error))?;
    let session_text: String = row.try_get("session_id")?;
    let session_id = SessionId::parse(session_text.clone())
        .map_err(|error| corrupt("join_requests.session_id", session_text, error))?;
    let state = parse_join_request_state(row.try_get("state")?)?;
    let expires_at = EpochMillis::new(unsigned_sql_integer(
        row.try_get("expires_at_ms")?,
        "join_requests.expires_at_ms",
    )?);
    Ok(RoomJoinRequestSnapshot {
        request_id,
        session_id,
        expires_at,
        state,
    })
}

fn session_state_text(state: SessionState) -> &'static str {
    match state {
        SessionState::Active => "active",
        SessionState::Expired => "expired",
    }
}

fn parse_session_state(value: String) -> Result<SessionState, StorageError> {
    match value.as_str() {
        "active" => Ok(SessionState::Active),
        "expired" => Ok(SessionState::Expired),
        _ => Err(StorageError::CorruptData(format!(
            "sessions.state contains {value:?}"
        ))),
    }
}

fn room_state_text(state: RoomState) -> &'static str {
    match state {
        RoomState::Active => "active",
        RoomState::Expired => "expired",
    }
}

fn parse_room_state(value: String) -> Result<RoomState, StorageError> {
    match value.as_str() {
        "active" => Ok(RoomState::Active),
        "expired" => Ok(RoomState::Expired),
        _ => Err(StorageError::CorruptData(format!(
            "rooms.state contains {value:?}"
        ))),
    }
}

fn membership_role_text(role: MembershipRole) -> &'static str {
    match role {
        MembershipRole::Owner => "owner",
        MembershipRole::Receiver => "receiver",
    }
}

fn parse_membership_role(value: String) -> Result<MembershipRole, StorageError> {
    match value.as_str() {
        "owner" => Ok(MembershipRole::Owner),
        "receiver" => Ok(MembershipRole::Receiver),
        _ => Err(StorageError::CorruptData(format!(
            "room_members.role contains {value:?}"
        ))),
    }
}

fn membership_state_parts(state: &MembershipState) -> (&'static str, Option<&str>) {
    match state {
        MembershipState::Offline => ("offline", None),
        MembershipState::Online { peer_id } => ("online", Some(peer_id.as_str())),
        MembershipState::Left => ("left", None),
    }
}

fn join_request_state_text(state: JoinRequestState) -> &'static str {
    match state {
        JoinRequestState::Pending => "pending",
        JoinRequestState::Approved => "approved",
        JoinRequestState::Rejected => "rejected",
        JoinRequestState::Cancelled => "cancelled",
        JoinRequestState::Expired => "expired",
    }
}

fn parse_join_request_state(value: String) -> Result<JoinRequestState, StorageError> {
    match value.as_str() {
        "pending" => Ok(JoinRequestState::Pending),
        "approved" => Ok(JoinRequestState::Approved),
        "rejected" => Ok(JoinRequestState::Rejected),
        "cancelled" => Ok(JoinRequestState::Cancelled),
        "expired" => Ok(JoinRequestState::Expired),
        _ => Err(StorageError::CorruptData(format!(
            "join_requests.state contains {value:?}"
        ))),
    }
}

fn sql_integer(value: u64) -> Result<i64, StorageError> {
    i64::try_from(value).map_err(|_| StorageError::IntegerOutOfRange(value))
}

fn unsigned_sql_integer(value: i64, field: &'static str) -> Result<u64, StorageError> {
    u64::try_from(value)
        .map_err(|_| StorageError::CorruptData(format!("{field} contains negative value {value}")))
}

fn corrupt(field: &'static str, value: String, error: impl std::fmt::Display) -> StorageError {
    StorageError::CorruptData(format!("{field} contains {value:?}: {error}"))
}

fn map_write_error(error: sqlx::Error) -> StorageError {
    if error
        .as_database_error()
        .is_some_and(sqlx::error::DatabaseError::is_unique_violation)
    {
        StorageError::UniqueConflict
    } else if error
        .as_database_error()
        .is_some_and(sqlx::error::DatabaseError::is_foreign_key_violation)
    {
        StorageError::ForeignKeyViolation
    } else {
        StorageError::Database(error)
    }
}

#[derive(Debug, Error)]
pub enum StorageError {
    #[error("failed to create SQLite parent directory: {0}")]
    CreateDirectory(std::io::Error),
    #[error("SQLite operation failed: {0}")]
    Database(#[from] sqlx::Error),
    #[error("SQLite migration failed: {0}")]
    Migration(#[from] MigrateError),
    #[error("SQLite configuration invalid: {0}")]
    InvalidConfiguration(&'static str),
    #[error("value {0} cannot be represented by SQLite INTEGER")]
    IntegerOutOfRange(u64),
    #[error("stored data is invalid: {0}")]
    CorruptData(String),
    #[error("stored room is invalid: {0}")]
    CorruptRoom(#[from] RoomRestoreError),
    #[error("room does not exist")]
    RoomNotFound,
    #[error("unique constraint conflict")]
    UniqueConflict,
    #[error("foreign key constraint violation")]
    ForeignKeyViolation,
    #[error("room revision conflict: expected {expected}, actual {actual}")]
    RevisionConflict { expected: u64, actual: u64 },
    #[error("room command failed: {0}")]
    Room(#[from] RoomError),
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use p2p_domain::JoinDecision;
    use uuid::Uuid;

    use super::*;

    struct TestDatabase {
        storage: Storage,
        directory: PathBuf,
        path: PathBuf,
    }

    impl TestDatabase {
        async fn create() -> Self {
            let directory = std::env::temp_dir().join(format!("p2p-v2-db-{}", Uuid::new_v4()));
            let path = directory.join("control.sqlite3");
            let storage = Storage::connect(&path)
                .await
                .expect("connect test database");
            Self {
                storage,
                directory,
                path,
            }
        }

        async fn cleanup(self) {
            self.storage.close().await;
            std::fs::remove_dir_all(self.directory).expect("remove test database directory");
        }
    }

    fn id<T>(value: &str) -> T
    where
        T: std::str::FromStr,
        T::Err: std::fmt::Debug,
    {
        value.parse().expect("valid id")
    }

    fn session(id_value: &str, name: &str) -> Session {
        Session::create(
            id(id_value),
            DisplayName::parse(name).expect("display name"),
            EpochMillis::new(100),
            EpochMillis::new(10_000),
        )
        .expect("session")
    }

    fn room(owner: &Session) -> Room {
        Room::create(
            id("room_1"),
            id("ABC123"),
            owner.id().clone(),
            EpochMillis::new(100),
            EpochMillis::new(9_000),
        )
        .expect("room")
        .0
    }

    async fn seed_room(database: &TestDatabase, receivers: &[Session]) -> Room {
        let owner = session("owner_1", "Owner");
        database
            .storage
            .insert_session(&owner, EpochMillis::new(100))
            .await
            .expect("insert owner");
        for receiver in receivers {
            database
                .storage
                .insert_session(receiver, EpochMillis::new(100))
                .await
                .expect("insert receiver");
        }
        let room = room(&owner);
        database
            .storage
            .insert_room(&room, &id("create_1"), EpochMillis::new(100))
            .await
            .expect("insert room");
        room
    }

    #[tokio::test]
    async fn migrations_are_reopenable_and_sqlite_guards_are_enabled() {
        let database = TestDatabase::create().await;
        let migration_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM _sqlx_migrations")
            .fetch_one(database.storage.pool())
            .await
            .expect("migration count");
        assert_eq!(migration_count, 1);
        database.storage.ready().await.expect("database ready");

        database.storage.close().await;
        let reopened = Storage::connect(&database.path)
            .await
            .expect("reopen migrated database");
        let table_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name = 'rooms'",
        )
        .fetch_one(reopened.pool())
        .await
        .expect("rooms table count");
        assert_eq!(table_count, 1);
        reopened.close().await;
        std::fs::remove_dir_all(database.directory).expect("remove test database directory");
    }

    #[tokio::test]
    async fn room_commands_are_transactional_persisted_and_idempotent() {
        let database = TestDatabase::create().await;
        let receiver = session("receiver_1", "Receiver");
        let room = seed_room(&database, std::slice::from_ref(&receiver)).await;
        let code = room.code().clone();
        let request = RoomCommand::RequestJoin {
            request_id: id("request_1"),
            session_id: receiver.id().clone(),
            now: EpochMillis::new(200),
            expires_at: EpochMillis::new(8_000),
        };

        let requested = database
            .storage
            .apply_room_command(
                &code,
                Some(Revision::new(1)),
                request.clone(),
                EpochMillis::new(200),
            )
            .await
            .expect("request join");
        assert_eq!(requested.room.revision().value(), 2);
        assert!(requested.outcome.changed());

        let replay = database
            .storage
            .apply_room_command(
                &code,
                Some(Revision::new(2)),
                request,
                EpochMillis::new(201),
            )
            .await
            .expect("replay request");
        assert!(!replay.outcome.changed());
        assert_eq!(replay.room.revision().value(), 2);

        let approved = database
            .storage
            .apply_room_command(
                &code,
                Some(Revision::new(2)),
                RoomCommand::DecideJoin {
                    actor: id("owner_1"),
                    request_id: id("request_1"),
                    decision: JoinDecision::Approve,
                    now: EpochMillis::new(300),
                },
                EpochMillis::new(300),
            )
            .await
            .expect("approve request");
        assert_eq!(approved.room.revision().value(), 3);

        let restored = database
            .storage
            .find_room_by_code(&code)
            .await
            .expect("load room")
            .expect("room exists");
        assert_eq!(restored, approved.room);
        assert_eq!(
            restored.membership_state(receiver.id()),
            Some(&MembershipState::Offline)
        );
        assert_eq!(
            restored.join_request_state(&id("request_1")),
            Some(JoinRequestState::Approved)
        );
        database.cleanup().await;
    }

    #[tokio::test]
    async fn concurrent_commands_with_one_expected_revision_have_one_winner() {
        let database = TestDatabase::create().await;
        let first = session("receiver_1", "First");
        let second = session("receiver_2", "Second");
        let room = seed_room(&database, &[first.clone(), second.clone()]).await;
        let code = room.code().clone();

        let first_storage = database.storage.clone();
        let first_code = code.clone();
        let first_task = tokio::spawn(async move {
            first_storage
                .apply_room_command(
                    &first_code,
                    Some(Revision::new(1)),
                    RoomCommand::RequestJoin {
                        request_id: id("request_1"),
                        session_id: first.id().clone(),
                        now: EpochMillis::new(200),
                        expires_at: EpochMillis::new(8_000),
                    },
                    EpochMillis::new(200),
                )
                .await
        });
        let second_storage = database.storage.clone();
        let second_code = code.clone();
        let second_task = tokio::spawn(async move {
            second_storage
                .apply_room_command(
                    &second_code,
                    Some(Revision::new(1)),
                    RoomCommand::RequestJoin {
                        request_id: id("request_2"),
                        session_id: second.id().clone(),
                        now: EpochMillis::new(200),
                        expires_at: EpochMillis::new(8_000),
                    },
                    EpochMillis::new(200),
                )
                .await
        });

        let results = [
            first_task.await.expect("first task"),
            second_task.await.expect("second task"),
        ];
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter(|result| matches!(result, Err(StorageError::RevisionConflict { .. })))
                .count(),
            1
        );
        let restored = database
            .storage
            .find_room_by_code(&code)
            .await
            .expect("load room")
            .expect("room exists");
        assert_eq!(restored.revision().value(), 2);
        assert_eq!(restored.join_request_snapshots().len(), 1);
        database.cleanup().await;
    }

    #[tokio::test]
    async fn maintenance_expires_sessions_in_bounded_batches() {
        let database = TestDatabase::create().await;
        for index in 0..3 {
            let session = Session::create(
                id(&format!("session_{index}")),
                DisplayName::parse(format!("User {index}")).expect("display name"),
                EpochMillis::new(100),
                EpochMillis::new(200 + index),
            )
            .expect("session");
            database
                .storage
                .insert_session(&session, EpochMillis::new(100))
                .await
                .expect("insert session");
        }

        assert_eq!(
            database
                .storage
                .expire_due_sessions(EpochMillis::new(1_000), 2)
                .await
                .expect("expire first batch"),
            2
        );
        assert_eq!(
            database
                .storage
                .expire_due_sessions(EpochMillis::new(1_000), 2)
                .await
                .expect("expire second batch"),
            1
        );
        let active: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM sessions WHERE state = 'active'")
                .fetch_one(database.storage.pool())
                .await
                .expect("active count");
        assert_eq!(active, 0);
        database.cleanup().await;
    }

    #[tokio::test]
    async fn maintenance_expires_requests_and_rooms_through_domain_commands() {
        let database = TestDatabase::create().await;
        let receiver = session("receiver_1", "Receiver");
        let room = seed_room(&database, std::slice::from_ref(&receiver)).await;
        database
            .storage
            .apply_room_command(
                room.code(),
                Some(Revision::new(1)),
                RoomCommand::RequestJoin {
                    request_id: id("request_1"),
                    session_id: receiver.id().clone(),
                    now: EpochMillis::new(200),
                    expires_at: EpochMillis::new(8_000),
                },
                EpochMillis::new(200),
            )
            .await
            .expect("create expiring request");

        let request_mutations = database
            .storage
            .expire_due_join_requests(EpochMillis::new(8_000), 10)
            .await
            .expect("expire requests");
        assert_eq!(request_mutations.len(), 1);
        assert_eq!(request_mutations[0].room.revision().value(), 3);
        assert_eq!(
            request_mutations[0]
                .room
                .join_request_state(&id("request_1")),
            Some(JoinRequestState::Expired)
        );

        let room_mutations = database
            .storage
            .expire_due_rooms(EpochMillis::new(9_000), 10)
            .await
            .expect("expire rooms");
        assert_eq!(room_mutations.len(), 1);
        assert_eq!(room_mutations[0].room.state(), RoomState::Expired);
        assert_eq!(room_mutations[0].room.revision().value(), 4);
        assert!(
            database
                .storage
                .expire_due_rooms(EpochMillis::new(9_001), 10)
                .await
                .expect("expiry replay")
                .is_empty()
        );
        database.cleanup().await;
    }
}
