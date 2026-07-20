use std::fmt;

use p2p_protocol::{ApiErrorCode, ProtocolVersion};
use thiserror::Error;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BrowserStorageOperation {
    ChooseSource,
    ChooseDestination,
    RequestPermission,
    ReadSource,
    ReadDestination,
    OpenDestination,
    WriteDestination,
    CommitDestination,
    ReopenDestination,
    CloseDestination,
    AbortDestination,
}

impl fmt::Display for BrowserStorageOperation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::ChooseSource => "choose source file",
            Self::ChooseDestination => "choose destination",
            Self::RequestPermission => "request file permission",
            Self::ReadSource => "read source file",
            Self::ReadDestination => "read destination checkpoint",
            Self::OpenDestination => "open destination",
            Self::WriteDestination => "write destination",
            Self::CommitDestination => "commit destination checkpoint",
            Self::ReopenDestination => "reopen destination",
            Self::CloseDestination => "close destination",
            Self::AbortDestination => "abort destination write",
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BrowserStorageErrorKind {
    PermissionDenied,
    QuotaExceeded,
    NotFound,
    InvalidState,
    Unknown,
}

impl BrowserStorageErrorKind {
    #[cfg(any(target_arch = "wasm32", test))]
    pub(crate) fn from_dom_exception_name(name: Option<&str>) -> Self {
        match name {
            Some("NotAllowedError" | "SecurityError") => Self::PermissionDenied,
            Some("QuotaExceededError") => Self::QuotaExceeded,
            Some("NotFoundError") => Self::NotFound,
            Some("InvalidStateError" | "NoModificationAllowedError") => Self::InvalidState,
            _ => Self::Unknown,
        }
    }
}

impl fmt::Display for BrowserStorageErrorKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::PermissionDenied => "permission denied",
            Self::QuotaExceeded => "storage quota exceeded",
            Self::NotFound => "file or directory not found",
            Self::InvalidState => "invalid file system state",
            Self::Unknown => "unknown storage failure",
        })
    }
}

#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum BrowserPlatformError {
    #[error("browser platform API is only available on wasm32")]
    UnsupportedTarget,
    #[error("browser window is unavailable")]
    MissingWindow,
    #[error("browser operation was cancelled by the user")]
    UserCancelled,
    #[error("browser storage failed while trying to {operation}: {kind}: {message}")]
    Storage {
        operation: BrowserStorageOperation,
        kind: BrowserStorageErrorKind,
        message: String,
    },
    #[error("browser API failed: {0}")]
    Browser(String),
    #[error("request failed: {0}")]
    Request(String),
    #[error("API returned HTTP {status}: {message}")]
    Api {
        status: u16,
        code: ApiErrorCode,
        message: String,
        retryable: bool,
    },
    #[error(
        "client upgrade required: client protocol {expected_major}.{expected_minor}, server protocol {received_major}.{received_minor}"
    )]
    UpgradeRequired {
        expected_major: u16,
        expected_minor: u16,
        received_major: u16,
        received_minor: u16,
    },
    #[error("client upgrade required: server capability set is incomplete")]
    MissingCapabilities,
    #[error("response could not be decoded: {0}")]
    Decode(String),
    #[error("RTC connection configuration has expired")]
    RtcConfigExpired,
    #[error("realtime message could not be encoded: {0}")]
    RealtimeEncode(String),
}

impl BrowserPlatformError {
    pub fn upgrade_required(expected: ProtocolVersion, received: ProtocolVersion) -> Self {
        Self::UpgradeRequired {
            expected_major: expected.major,
            expected_minor: expected.minor,
            received_major: received.major,
            received_minor: received.minor,
        }
    }

    pub fn missing_capabilities() -> Self {
        Self::MissingCapabilities
    }

    pub fn requires_upgrade(&self) -> bool {
        matches!(
            self,
            Self::UpgradeRequired { .. } | Self::MissingCapabilities
        )
    }
}

#[cfg(test)]
mod tests {
    use super::BrowserStorageErrorKind;

    #[test]
    fn maps_recoverable_dom_storage_errors() {
        for name in ["NotAllowedError", "SecurityError"] {
            assert_eq!(
                BrowserStorageErrorKind::from_dom_exception_name(Some(name)),
                BrowserStorageErrorKind::PermissionDenied
            );
        }
        assert_eq!(
            BrowserStorageErrorKind::from_dom_exception_name(Some("QuotaExceededError")),
            BrowserStorageErrorKind::QuotaExceeded
        );
        assert_eq!(
            BrowserStorageErrorKind::from_dom_exception_name(Some("NotFoundError")),
            BrowserStorageErrorKind::NotFound
        );
        for name in ["InvalidStateError", "NoModificationAllowedError"] {
            assert_eq!(
                BrowserStorageErrorKind::from_dom_exception_name(Some(name)),
                BrowserStorageErrorKind::InvalidState
            );
        }
    }

    #[test]
    fn keeps_unknown_dom_storage_errors_typed() {
        for name in [Some("OperationError"), None] {
            assert_eq!(
                BrowserStorageErrorKind::from_dom_exception_name(name),
                BrowserStorageErrorKind::Unknown
            );
        }
    }
}
