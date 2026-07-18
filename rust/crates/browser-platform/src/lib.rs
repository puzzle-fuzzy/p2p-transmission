#![forbid(unsafe_code)]

mod api;
mod capabilities;
mod lifecycle;
mod navigation;
mod realtime;
mod rtc;
mod session_storage;
#[cfg(target_arch = "wasm32")]
mod source_storage;
#[cfg(target_arch = "wasm32")]
mod stream_recovery;
mod stream_storage;
mod ui;

use std::fmt;

use p2p_protocol::{ApiErrorCode, ServerRealtimeMessage};
use thiserror::Error;

pub use api::{
    bootstrap_room, create_invite, create_room, create_session, decide_join, fetch_rtc_config,
    join_request_status, leave_room, request_join,
};
pub use capabilities::{
    copy_text, epoch_millis, monotonic_millis, prime_notification_permission, send_notification,
    sleep_ms,
};
pub use lifecycle::{
    BrowserLifecycle, BrowserLifecycleEvent, SLEEP_RESUME_GAP_MS, connect_browser_lifecycle,
};
pub use navigation::{build_invite_url, take_launch_intent};
pub use realtime::{RealtimeConnection, connect_realtime, new_client_id};
pub use rtc::{
    BrowserFile, OfferStart, RtcConfigLease, RtcConnectionPhase, RtcEvent, RtcPeer,
    SignalAcceptance, TransferDirection, TransferFile, browser_files_from_input,
    choose_persistent_source_files, persistent_source_file_support,
};
pub use session_storage::{clear_room_session, load_room_session, save_room_session};
pub use stream_storage::{
    StreamingFileWriter, StreamingStorageSupport, choose_stream_file, choose_stream_files,
    streaming_batch_storage_supported, streaming_storage_support,
};
pub use ui::{
    activate_app_mount, close_modal_dialog, focus_text_input, mark_app_interactive,
    show_modal_dialog,
};

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
    #[error("response could not be decoded: {0}")]
    Decode(String),
    #[error("RTC connection configuration has expired")]
    RtcConfigExpired,
    #[error("realtime message could not be encoded: {0}")]
    RealtimeEncode(String),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LaunchIntent {
    JoinRoom {
        room_code: String,
        capability: String,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RealtimeEvent {
    Open,
    Message(ServerRealtimeMessage),
    Error(String),
    Closed { code: u16, reason: String },
}

#[cfg(test)]
mod tests {
    use super::BrowserStorageErrorKind;

    #[test]
    fn maps_recoverable_dom_storage_errors() {
        assert_eq!(
            BrowserStorageErrorKind::from_dom_exception_name(Some("NotAllowedError")),
            BrowserStorageErrorKind::PermissionDenied
        );
        assert_eq!(
            BrowserStorageErrorKind::from_dom_exception_name(Some("SecurityError")),
            BrowserStorageErrorKind::PermissionDenied
        );
        assert_eq!(
            BrowserStorageErrorKind::from_dom_exception_name(Some("QuotaExceededError")),
            BrowserStorageErrorKind::QuotaExceeded
        );
        assert_eq!(
            BrowserStorageErrorKind::from_dom_exception_name(Some("NotFoundError")),
            BrowserStorageErrorKind::NotFound
        );
        assert_eq!(
            BrowserStorageErrorKind::from_dom_exception_name(Some("InvalidStateError")),
            BrowserStorageErrorKind::InvalidState
        );
        assert_eq!(
            BrowserStorageErrorKind::from_dom_exception_name(Some("NoModificationAllowedError")),
            BrowserStorageErrorKind::InvalidState
        );
    }

    #[test]
    fn keeps_unknown_dom_storage_errors_typed() {
        assert_eq!(
            BrowserStorageErrorKind::from_dom_exception_name(Some("OperationError")),
            BrowserStorageErrorKind::Unknown
        );
        assert_eq!(
            BrowserStorageErrorKind::from_dom_exception_name(None),
            BrowserStorageErrorKind::Unknown
        );
    }
}
