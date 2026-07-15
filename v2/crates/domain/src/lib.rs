#![forbid(unsafe_code)]

pub mod ids;
pub mod room;
pub mod session;
pub mod time;
pub mod transfer;

use std::fmt;

use thiserror::Error;

pub const PRODUCT_NAME: &str = "P2P Transmission";

pub use ids::{FileId, PeerId, RequestId, RoomCode, RoomId, SessionId, TransferId};
pub use room::{
    JoinDecision, JoinRequestState, MembershipRole, MembershipState, Room, RoomCommand,
    RoomCommandOutcome, RoomError, RoomEvent, RoomExpiryReason, RoomInvariantError,
    RoomJoinRequestSnapshot, RoomMembershipSnapshot, RoomRestoreError, RoomState,
};
pub use session::{DisplayName, Session, SessionError, SessionState};
pub use time::{Clock, DurationMillis, EpochMillis, IdGenerator, RandomSource, Revision};
pub use transfer::{
    CancelledBy, FailureCode, FileName, FileSpec, ReceiverCommand, ReceiverEvent, ReceiverTransfer,
    ReceiverTransferState, ReceiverTransition, SenderTransfer, TransferError, TransferManifest,
    TransferSummary,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProductVersion(String);

impl ProductVersion {
    pub fn parse(value: impl Into<String>) -> Result<Self, ProductVersionError> {
        let value = value.into();
        if value.trim().is_empty() || value.len() > 64 {
            return Err(ProductVersionError::Invalid);
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ProductVersion {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
pub enum ProductVersionError {
    #[error("product version must contain between 1 and 64 characters")]
    Invalid,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn product_version_rejects_empty_values() {
        assert_eq!(ProductVersion::parse(""), Err(ProductVersionError::Invalid));
    }

    #[test]
    fn product_version_preserves_valid_values() {
        let version = ProductVersion::parse("2.0.0-alpha.1").expect("valid version");
        assert_eq!(version.as_str(), "2.0.0-alpha.1");
    }
}
