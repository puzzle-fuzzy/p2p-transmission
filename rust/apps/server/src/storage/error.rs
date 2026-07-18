use p2p_domain::{RoomError, RoomRestoreError};
use sqlx::migrate::MigrateError;
use thiserror::Error;

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

pub(super) fn map_write_error(error: sqlx::Error) -> StorageError {
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
