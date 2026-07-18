//! Stable socket error classification and infrastructure error mapping.

use p2p_domain::RoomError;
use tracing::warn;

use crate::{realtime::hub::HubError, storage::StorageError};

pub(super) fn map_storage_error(error: StorageError) -> SocketCommandError {
    match error {
        StorageError::RoomNotFound => SocketCommandError::not_found(),
        StorageError::Room(
            RoomError::MembershipNotFound | RoomError::MembershipLeft | RoomError::Unauthorized,
        ) => SocketCommandError::forbidden(),
        StorageError::Room(RoomError::Inactive | RoomError::RequestExpired) => {
            SocketCommandError::expired()
        }
        _ => {
            warn!(%error, "realtime storage command failed");
            SocketCommandError::unavailable()
        }
    }
}

pub(super) fn map_hub_error(error: HubError) -> SocketCommandError {
    match error {
        HubError::NotAttached => SocketCommandError::attach_required(),
        HubError::TargetNotFound | HubError::CannotSignalSelf => SocketCommandError::forbidden(),
        HubError::SlowConsumer => SocketCommandError {
            code: "slow_consumer",
            message: "realtime outbound queue is full",
            retryable: true,
            fatal: true,
        },
        HubError::ConnectionNotFound => SocketCommandError {
            code: "connection_closed",
            message: "realtime connection is no longer active",
            retryable: true,
            fatal: true,
        },
    }
}

#[derive(Clone, Copy, Debug)]
pub(in crate::realtime::socket) struct SocketCommandError {
    pub(in crate::realtime::socket) code: &'static str,
    pub(in crate::realtime::socket) message: &'static str,
    pub(in crate::realtime::socket) retryable: bool,
    pub(in crate::realtime::socket) fatal: bool,
}

impl SocketCommandError {
    pub(super) fn invalid() -> Self {
        Self {
            code: "invalid_message",
            message: "realtime message contains an invalid value",
            retryable: false,
            fatal: false,
        }
    }

    pub(super) fn forbidden() -> Self {
        Self {
            code: "signal_forbidden",
            message: "peer is not authorized for this realtime operation",
            retryable: false,
            fatal: false,
        }
    }

    fn not_found() -> Self {
        Self {
            code: "room_not_found",
            message: "room does not exist",
            retryable: false,
            fatal: true,
        }
    }

    fn expired() -> Self {
        Self {
            code: "room_expired",
            message: "room has expired",
            retryable: false,
            fatal: true,
        }
    }

    pub(super) fn unavailable() -> Self {
        Self {
            code: "realtime_unavailable",
            message: "realtime service is temporarily unavailable",
            retryable: true,
            fatal: false,
        }
    }

    fn attach_required() -> Self {
        Self {
            code: "attach_required",
            message: "connection must attach a room first",
            retryable: false,
            fatal: false,
        }
    }

    pub(super) fn join_resolved() -> Self {
        Self {
            code: "join_request_resolved",
            message: "join request is no longer pending",
            retryable: false,
            fatal: true,
        }
    }

    pub(super) fn rate_limited() -> Self {
        Self {
            code: "rate_limited",
            message: "signaling rate limit exceeded",
            retryable: true,
            fatal: false,
        }
    }
}
