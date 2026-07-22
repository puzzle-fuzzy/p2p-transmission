#![forbid(unsafe_code)]

mod api;
mod capabilities;
mod error;
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

use p2p_protocol::ServerRealtimeMessage;

pub use api::{
    bootstrap_room, create_invite, create_room, create_session, decide_join, fetch_build_info,
    fetch_rtc_config, join_request_status, leave_room, request_join,
};
pub use capabilities::{
    begin_copy_text, copy_text, epoch_millis, monotonic_millis, prime_notification_permission,
    send_notification, sleep_ms,
};
pub use error::{BrowserPlatformError, BrowserStorageErrorKind, BrowserStorageOperation};
pub use lifecycle::{
    BrowserLifecycle, BrowserLifecycleEvent, SLEEP_RESUME_GAP_MS, connect_browser_lifecycle,
};
pub use navigation::{build_invite_url, take_launch_intent};
pub use realtime::{RealtimeConnection, connect_realtime, new_client_id};
pub use rtc::{
    BrowserFile, OfferStart, RtcConfigLease, RtcConnectionPhase, RtcEvent, RtcPeer,
    RtcPeerRegistry, SignalAcceptance, TransferDirection, TransferFile, browser_files_from_input,
    choose_persistent_source_files, persistent_source_file_support,
};
pub use session_storage::{clear_room_session, load_room_session, save_room_session};
pub use stream_storage::{
    StreamingFileWriter, StreamingStorageSupport, choose_stream_file, choose_stream_files,
    streaming_batch_storage_supported, streaming_storage_support,
};
pub use ui::{
    activate_app_mount, click_element_by_id, close_modal_dialog, focus_text_input,
    load_ui_preference, mark_app_interactive, save_ui_preference, set_document_attribute,
    show_modal_dialog,
};

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
    UpgradeRequired,
    Error(String),
    Closed { code: u16, reason: String },
}
