use std::path::PathBuf;

use p2p_domain::{DisplayName, JoinDecision, JoinRequestState, MembershipState, RoomState};
use uuid::Uuid;

use super::*;

struct TestDatabase {
    storage: Storage,
    directory: PathBuf,
    path: PathBuf,
}

impl TestDatabase {
    async fn create() -> Self {
        let directory = std::env::temp_dir().join(format!("p2p-db-{}", Uuid::new_v4()));
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
    let active: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions WHERE state = 'active'")
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
