#![forbid(unsafe_code)]

mod lifecycle;
mod rtc;
#[cfg(target_arch = "wasm32")]
mod source_storage;
#[cfg(target_arch = "wasm32")]
mod stream_recovery;
mod stream_storage;

use std::fmt;

use p2p_protocol::{
    ApiErrorCode, CURRENT_PROTOCOL, ClientRealtimeMessage, CreateInviteRequest,
    CreateInviteResponse, CreateRoomRequest, CreateRoomResponse, CreateSessionRequest,
    DecideJoinRequest, HealthResponse, JoinDecisionRequest, JoinRequestResponse, LeaveRoomRequest,
    RequestJoinRequest, RoomBootstrapResponse, RoomMutationResponse, RtcConfigResponse,
    ServerRealtimeMessage, SessionResponse,
};
use serde::{Serialize, de::DeserializeOwned};
use thiserror::Error;

pub use lifecycle::{
    BrowserLifecycle, BrowserLifecycleEvent, SLEEP_RESUME_GAP_MS, connect_browser_lifecycle,
};
pub use rtc::{
    BrowserFile, RtcConnectionPhase, RtcEvent, RtcPeer, TransferDirection, TransferFile,
    browser_file_from_input, browser_files_from_input, choose_persistent_source_files,
    persistent_source_file_support,
};
pub use stream_storage::{
    StreamingFileWriter, StreamingStorageSupport, choose_stream_file, choose_stream_files,
    streaming_batch_storage_supported, streaming_storage_support,
};

#[cfg(target_arch = "wasm32")]
use p2p_protocol::ErrorEnvelope;

#[cfg(target_arch = "wasm32")]
const ROOM_SESSION_STORAGE_KEY: &str = "p2p_v2_room_session";

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
    #[error("realtime message could not be encoded: {0}")]
    RealtimeEncode(String),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InviteIntent {
    pub room_code: String,
    pub capability: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RealtimeEvent {
    Open,
    Message(ServerRealtimeMessage),
    Error(String),
    Closed { code: u16, reason: String },
}

pub async fn fetch_readiness() -> Result<HealthResponse, BrowserPlatformError> {
    request_json::<(), HealthResponse>("GET", "/health/ready", None).await
}

pub async fn fetch_rtc_config() -> Result<RtcConfigResponse, BrowserPlatformError> {
    request_json::<(), RtcConfigResponse>("GET", "/api/rtc/config", None).await
}

pub async fn create_session(display_name: &str) -> Result<SessionResponse, BrowserPlatformError> {
    request_json(
        "POST",
        "/api/session",
        Some(&CreateSessionRequest {
            version: CURRENT_PROTOCOL,
            display_name: display_name.to_owned(),
        }),
    )
    .await
}

pub async fn create_room(request_id: &str) -> Result<CreateRoomResponse, BrowserPlatformError> {
    request_json(
        "POST",
        "/api/rooms",
        Some(&CreateRoomRequest {
            version: CURRENT_PROTOCOL,
            request_id: request_id.to_owned(),
        }),
    )
    .await
}

pub async fn create_invite(
    room_code: &str,
    request_id: &str,
) -> Result<CreateInviteResponse, BrowserPlatformError> {
    request_json(
        "POST",
        &format!("/api/rooms/{room_code}/invite-capabilities"),
        Some(&CreateInviteRequest {
            version: CURRENT_PROTOCOL,
            request_id: request_id.to_owned(),
        }),
    )
    .await
}

pub async fn request_join(
    room_code: &str,
    request_id: &str,
    expected_revision: Option<u64>,
    invite_capability: Option<String>,
) -> Result<JoinRequestResponse, BrowserPlatformError> {
    request_json(
        "POST",
        &format!("/api/rooms/{room_code}/join-requests"),
        Some(&RequestJoinRequest {
            version: CURRENT_PROTOCOL,
            request_id: request_id.to_owned(),
            room_code: room_code.to_owned(),
            expected_revision,
            invite_capability,
        }),
    )
    .await
}

pub async fn join_request_status(
    room_code: &str,
    request_id: &str,
) -> Result<JoinRequestResponse, BrowserPlatformError> {
    request_json::<(), JoinRequestResponse>(
        "GET",
        &format!("/api/rooms/{room_code}/join-requests/{request_id}"),
        None,
    )
    .await
}

pub async fn bootstrap_room(
    room_code: &str,
) -> Result<RoomBootstrapResponse, BrowserPlatformError> {
    request_json::<(), RoomBootstrapResponse>(
        "GET",
        &format!("/api/rooms/{room_code}/bootstrap"),
        None,
    )
    .await
}

pub async fn decide_join(
    room_code: &str,
    request_id: &str,
    decision: JoinDecisionRequest,
    expected_revision: Option<u64>,
) -> Result<RoomMutationResponse, BrowserPlatformError> {
    request_json(
        "POST",
        &format!("/api/rooms/{room_code}/join-requests/{request_id}/decision"),
        Some(&DecideJoinRequest {
            version: CURRENT_PROTOCOL,
            request_id: request_id.to_owned(),
            decision,
            expected_revision,
        }),
    )
    .await
}

pub async fn leave_room(
    room_code: &str,
    request_id: &str,
    expected_revision: Option<u64>,
) -> Result<RoomMutationResponse, BrowserPlatformError> {
    request_json(
        "POST",
        &format!("/api/rooms/{room_code}/leave"),
        Some(&LeaveRoomRequest {
            version: CURRENT_PROTOCOL,
            request_id: request_id.to_owned(),
            expected_revision,
        }),
    )
    .await
}

#[cfg(target_arch = "wasm32")]
async fn request_json<RequestBody, ResponseBody>(
    method: &str,
    path: &str,
    body: Option<&RequestBody>,
) -> Result<ResponseBody, BrowserPlatformError>
where
    RequestBody: Serialize,
    ResponseBody: DeserializeOwned,
{
    use wasm_bindgen::{JsCast, JsValue};
    use wasm_bindgen_futures::JsFuture;
    use web_sys::{Request, RequestCredentials, RequestInit, RequestMode, Response};

    let options = RequestInit::new();
    options.set_method(method);
    options.set_mode(RequestMode::SameOrigin);
    options.set_credentials(RequestCredentials::SameOrigin);
    if let Some(body) = body {
        let json = serde_json::to_string(body)
            .map_err(|error| BrowserPlatformError::Request(error.to_string()))?;
        options.set_body(&JsValue::from_str(&json));
    }
    let request = Request::new_with_str_and_init(path, &options)
        .map_err(|error| BrowserPlatformError::Request(format!("{error:?}")))?;
    if body.is_some() {
        request
            .headers()
            .set("Content-Type", "application/json")
            .map_err(|error| BrowserPlatformError::Request(format!("{error:?}")))?;
    }

    let window = web_sys::window().ok_or(BrowserPlatformError::MissingWindow)?;
    let value = JsFuture::from(window.fetch_with_request(&request))
        .await
        .map_err(|error| BrowserPlatformError::Request(format!("{error:?}")))?;
    let response = value
        .dyn_into::<Response>()
        .map_err(|error| BrowserPlatformError::Request(format!("{error:?}")))?;
    let status = response.status();
    let text = response
        .text()
        .map_err(|error| BrowserPlatformError::Decode(format!("{error:?}")))?;
    let text = JsFuture::from(text)
        .await
        .map_err(|error| BrowserPlatformError::Decode(format!("{error:?}")))?
        .as_string()
        .ok_or_else(|| BrowserPlatformError::Decode("response body is not text".to_owned()))?;

    if !response.ok() {
        let envelope = serde_json::from_str::<ErrorEnvelope>(&text)
            .map_err(|error| BrowserPlatformError::Decode(error.to_string()))?;
        return Err(BrowserPlatformError::Api {
            status,
            code: envelope.error.code,
            message: envelope.error.message,
            retryable: envelope.error.retryable,
        });
    }
    serde_json::from_str(&text).map_err(|error| BrowserPlatformError::Decode(error.to_string()))
}

#[cfg(not(target_arch = "wasm32"))]
async fn request_json<RequestBody, ResponseBody>(
    _method: &str,
    _path: &str,
    _body: Option<&RequestBody>,
) -> Result<ResponseBody, BrowserPlatformError>
where
    RequestBody: Serialize,
    ResponseBody: DeserializeOwned,
{
    Err(BrowserPlatformError::UnsupportedTarget)
}

#[cfg(target_arch = "wasm32")]
pub struct RealtimeConnection {
    socket: web_sys::WebSocket,
    _heartbeat: gloo_timers::callback::Interval,
    _open: wasm_bindgen::closure::Closure<dyn FnMut(web_sys::Event)>,
    _message: wasm_bindgen::closure::Closure<dyn FnMut(web_sys::MessageEvent)>,
    _error: wasm_bindgen::closure::Closure<dyn FnMut(web_sys::Event)>,
    _close: wasm_bindgen::closure::Closure<dyn FnMut(web_sys::CloseEvent)>,
}

#[cfg(target_arch = "wasm32")]
impl RealtimeConnection {
    pub fn send(&self, message: &ClientRealtimeMessage) -> Result<(), BrowserPlatformError> {
        let json = serde_json::to_string(message)
            .map_err(|error| BrowserPlatformError::RealtimeEncode(error.to_string()))?;
        self.socket
            .send_with_str(&json)
            .map_err(|error| BrowserPlatformError::Browser(format!("{error:?}")))
    }
}

#[cfg(target_arch = "wasm32")]
impl Drop for RealtimeConnection {
    fn drop(&mut self) {
        self.socket.set_onopen(None);
        self.socket.set_onmessage(None);
        self.socket.set_onerror(None);
        self.socket.set_onclose(None);
        let _ = self.socket.close();
    }
}

#[cfg(not(target_arch = "wasm32"))]
pub struct RealtimeConnection;

#[cfg(not(target_arch = "wasm32"))]
impl RealtimeConnection {
    pub fn send(&self, _message: &ClientRealtimeMessage) -> Result<(), BrowserPlatformError> {
        Err(BrowserPlatformError::UnsupportedTarget)
    }
}

#[cfg(target_arch = "wasm32")]
pub fn connect_realtime(
    initial_message: ClientRealtimeMessage,
    on_event: impl FnMut(RealtimeEvent) + 'static,
) -> Result<RealtimeConnection, BrowserPlatformError> {
    use std::{
        cell::{Cell, RefCell},
        rc::Rc,
    };

    use wasm_bindgen::{JsCast, closure::Closure};

    let window = web_sys::window().ok_or(BrowserPlatformError::MissingWindow)?;
    let location = window.location();
    let scheme = if location
        .protocol()
        .map_err(|error| BrowserPlatformError::Browser(format!("{error:?}")))?
        == "https:"
    {
        "wss"
    } else {
        "ws"
    };
    let host = location
        .host()
        .map_err(|error| BrowserPlatformError::Browser(format!("{error:?}")))?;
    let socket = web_sys::WebSocket::new(&format!("{scheme}://{host}/realtime"))
        .map_err(|error| BrowserPlatformError::Browser(format!("{error:?}")))?;
    let callback = Rc::new(RefCell::new(on_event));
    let initial_json = serde_json::to_string(&initial_message)
        .map_err(|error| BrowserPlatformError::RealtimeEncode(error.to_string()))?;

    let open_socket = socket.clone();
    let open_callback = Rc::clone(&callback);
    let open = Closure::wrap(Box::new(move |_event: web_sys::Event| {
        if let Err(error) = open_socket.send_with_str(&initial_json) {
            open_callback.borrow_mut()(RealtimeEvent::Error(format!("{error:?}")));
            return;
        }
        open_callback.borrow_mut()(RealtimeEvent::Open);
    }) as Box<dyn FnMut(_)>);
    socket.set_onopen(Some(open.as_ref().unchecked_ref()));

    let message_callback = Rc::clone(&callback);
    let message = Closure::wrap(Box::new(move |event: web_sys::MessageEvent| {
        let Some(text) = event.data().as_string() else {
            message_callback.borrow_mut()(RealtimeEvent::Error(
                "realtime server sent a non-text frame".to_owned(),
            ));
            return;
        };
        match serde_json::from_str::<ServerRealtimeMessage>(&text) {
            Ok(message) => message_callback.borrow_mut()(RealtimeEvent::Message(message)),
            Err(error) => message_callback.borrow_mut()(RealtimeEvent::Error(error.to_string())),
        }
    }) as Box<dyn FnMut(_)>);
    socket.set_onmessage(Some(message.as_ref().unchecked_ref()));

    let error_callback = Rc::clone(&callback);
    let error = Closure::wrap(Box::new(move |_event: web_sys::Event| {
        error_callback.borrow_mut()(RealtimeEvent::Error(
            "realtime connection failed".to_owned(),
        ));
    }) as Box<dyn FnMut(_)>);
    socket.set_onerror(Some(error.as_ref().unchecked_ref()));

    let close_callback = callback;
    let close = Closure::wrap(Box::new(move |event: web_sys::CloseEvent| {
        close_callback.borrow_mut()(RealtimeEvent::Closed {
            code: event.code(),
            reason: event.reason(),
        });
    }) as Box<dyn FnMut(_)>);
    socket.set_onclose(Some(close.as_ref().unchecked_ref()));

    let heartbeat_socket = socket.clone();
    let heartbeat_sequence = Rc::new(Cell::new(0_u64));
    let heartbeat = gloo_timers::callback::Interval::new(30_000, move || {
        if heartbeat_socket.ready_state() != web_sys::WebSocket::OPEN {
            return;
        }
        let sequence = heartbeat_sequence.get().saturating_add(1);
        heartbeat_sequence.set(sequence);
        let message = ClientRealtimeMessage::Heartbeat {
            version: CURRENT_PROTOCOL,
            nonce: format!("heartbeat_{sequence:x}"),
        };
        if let Ok(json) = serde_json::to_string(&message) {
            let _ = heartbeat_socket.send_with_str(&json);
        }
    });

    Ok(RealtimeConnection {
        socket,
        _heartbeat: heartbeat,
        _open: open,
        _message: message,
        _error: error,
        _close: close,
    })
}

#[cfg(not(target_arch = "wasm32"))]
pub fn connect_realtime(
    _initial_message: ClientRealtimeMessage,
    _on_event: impl FnMut(RealtimeEvent) + 'static,
) -> Result<RealtimeConnection, BrowserPlatformError> {
    Err(BrowserPlatformError::UnsupportedTarget)
}

#[cfg(target_arch = "wasm32")]
pub fn new_client_id(prefix: &str) -> String {
    let timestamp = js_sys::Date::now() as u64;
    let random = (js_sys::Math::random() * u32::MAX as f64) as u32;
    format!("{prefix}_{timestamp:x}{random:08x}")
}

#[cfg(not(target_arch = "wasm32"))]
pub fn new_client_id(prefix: &str) -> String {
    format!("{prefix}_unsupported")
}

#[cfg(target_arch = "wasm32")]
pub fn take_invite_intent() -> Result<Option<InviteIntent>, BrowserPlatformError> {
    use wasm_bindgen::JsValue;

    let window = web_sys::window().ok_or(BrowserPlatformError::MissingWindow)?;
    let location = window.location();
    let hash = location
        .hash()
        .map_err(|error| BrowserPlatformError::Browser(format!("{error:?}")))?;
    let mut room_code = None;
    let mut capability = None;
    for pair in hash.trim_start_matches('#').split('&') {
        if let Some((name, value)) = pair.split_once('=') {
            match name {
                "room" => room_code = Some(value.to_ascii_uppercase()),
                "capability" => capability = Some(value.to_owned()),
                _ => {}
            }
        }
    }
    let intent = room_code
        .zip(capability)
        .map(|(room_code, capability)| InviteIntent {
            room_code,
            capability,
        });
    if intent.is_some() {
        let path = format!(
            "{}{}",
            location
                .pathname()
                .map_err(|error| BrowserPlatformError::Browser(format!("{error:?}")))?,
            location
                .search()
                .map_err(|error| BrowserPlatformError::Browser(format!("{error:?}")))?
        );
        window
            .history()
            .map_err(|error| BrowserPlatformError::Browser(format!("{error:?}")))?
            .replace_state_with_url(&JsValue::NULL, "", Some(&path))
            .map_err(|error| BrowserPlatformError::Browser(format!("{error:?}")))?;
    }
    Ok(intent)
}

#[cfg(not(target_arch = "wasm32"))]
pub fn take_invite_intent() -> Result<Option<InviteIntent>, BrowserPlatformError> {
    Err(BrowserPlatformError::UnsupportedTarget)
}

#[cfg(target_arch = "wasm32")]
pub fn build_invite_url(room_code: &str, capability: &str) -> Result<String, BrowserPlatformError> {
    let location = web_sys::window()
        .ok_or(BrowserPlatformError::MissingWindow)?
        .location();
    let origin = location
        .origin()
        .map_err(|error| BrowserPlatformError::Browser(format!("{error:?}")))?;
    let pathname = location
        .pathname()
        .map_err(|error| BrowserPlatformError::Browser(format!("{error:?}")))?;
    Ok(format!(
        "{origin}{pathname}#room={room_code}&capability={capability}"
    ))
}

#[cfg(not(target_arch = "wasm32"))]
pub fn build_invite_url(
    _room_code: &str,
    _capability: &str,
) -> Result<String, BrowserPlatformError> {
    Err(BrowserPlatformError::UnsupportedTarget)
}

#[cfg(target_arch = "wasm32")]
fn modal_dialog(id: &str) -> Result<web_sys::HtmlDialogElement, BrowserPlatformError> {
    use wasm_bindgen::JsCast;

    web_sys::window()
        .ok_or(BrowserPlatformError::MissingWindow)?
        .document()
        .ok_or_else(|| BrowserPlatformError::Browser("browser document is unavailable".to_owned()))?
        .get_element_by_id(id)
        .ok_or_else(|| BrowserPlatformError::Browser(format!("dialog #{id} is unavailable")))?
        .dyn_into::<web_sys::HtmlDialogElement>()
        .map_err(|_| BrowserPlatformError::Browser(format!("element #{id} is not a dialog")))
}

#[cfg(target_arch = "wasm32")]
pub fn show_modal_dialog(id: &str) -> Result<(), BrowserPlatformError> {
    let dialog = modal_dialog(id)?;
    if !dialog.open() {
        dialog
            .show_modal()
            .map_err(|error| BrowserPlatformError::Browser(format!("{error:?}")))?;
    }
    Ok(())
}

#[cfg(not(target_arch = "wasm32"))]
pub fn show_modal_dialog(_id: &str) -> Result<(), BrowserPlatformError> {
    Err(BrowserPlatformError::UnsupportedTarget)
}

#[cfg(target_arch = "wasm32")]
pub fn close_modal_dialog(id: &str) -> Result<(), BrowserPlatformError> {
    let dialog = modal_dialog(id)?;
    if dialog.open() {
        dialog.close();
    }
    Ok(())
}

#[cfg(not(target_arch = "wasm32"))]
pub fn close_modal_dialog(_id: &str) -> Result<(), BrowserPlatformError> {
    Err(BrowserPlatformError::UnsupportedTarget)
}

#[cfg(target_arch = "wasm32")]
pub fn remove_boot_fallback() {
    if let Some(fallback) = web_sys::window()
        .and_then(|window| window.document())
        .and_then(|document| document.get_element_by_id("boot-fallback"))
    {
        fallback.remove();
    }
}

#[cfg(not(target_arch = "wasm32"))]
pub fn remove_boot_fallback() {}

#[cfg(target_arch = "wasm32")]
pub async fn copy_text(value: &str) -> Result<(), BrowserPlatformError> {
    use wasm_bindgen_futures::JsFuture;

    let window = web_sys::window().ok_or(BrowserPlatformError::MissingWindow)?;
    JsFuture::from(window.navigator().clipboard().write_text(value))
        .await
        .map_err(|error| BrowserPlatformError::Browser(format!("{error:?}")))?;
    Ok(())
}

#[cfg(not(target_arch = "wasm32"))]
pub async fn copy_text(_value: &str) -> Result<(), BrowserPlatformError> {
    Err(BrowserPlatformError::UnsupportedTarget)
}

#[cfg(target_arch = "wasm32")]
pub fn load_room_session() -> Result<Option<String>, BrowserPlatformError> {
    web_sys::window()
        .ok_or(BrowserPlatformError::MissingWindow)?
        .local_storage()
        .map_err(|error| BrowserPlatformError::Browser(format!("{error:?}")))?
        .ok_or_else(|| BrowserPlatformError::Browser("localStorage is unavailable".to_owned()))?
        .get_item(ROOM_SESSION_STORAGE_KEY)
        .map_err(|error| BrowserPlatformError::Browser(format!("{error:?}")))
}

#[cfg(not(target_arch = "wasm32"))]
pub fn load_room_session() -> Result<Option<String>, BrowserPlatformError> {
    Err(BrowserPlatformError::UnsupportedTarget)
}

#[cfg(target_arch = "wasm32")]
pub fn save_room_session(value: &str) -> Result<(), BrowserPlatformError> {
    web_sys::window()
        .ok_or(BrowserPlatformError::MissingWindow)?
        .local_storage()
        .map_err(|error| BrowserPlatformError::Browser(format!("{error:?}")))?
        .ok_or_else(|| BrowserPlatformError::Browser("localStorage is unavailable".to_owned()))?
        .set_item(ROOM_SESSION_STORAGE_KEY, value)
        .map_err(|error| BrowserPlatformError::Browser(format!("{error:?}")))
}

#[cfg(not(target_arch = "wasm32"))]
pub fn save_room_session(_value: &str) -> Result<(), BrowserPlatformError> {
    Err(BrowserPlatformError::UnsupportedTarget)
}

#[cfg(target_arch = "wasm32")]
pub fn clear_room_session() -> Result<(), BrowserPlatformError> {
    web_sys::window()
        .ok_or(BrowserPlatformError::MissingWindow)?
        .local_storage()
        .map_err(|error| BrowserPlatformError::Browser(format!("{error:?}")))?
        .ok_or_else(|| BrowserPlatformError::Browser("localStorage is unavailable".to_owned()))?
        .remove_item(ROOM_SESSION_STORAGE_KEY)
        .map_err(|error| BrowserPlatformError::Browser(format!("{error:?}")))
}

#[cfg(not(target_arch = "wasm32"))]
pub fn clear_room_session() -> Result<(), BrowserPlatformError> {
    Err(BrowserPlatformError::UnsupportedTarget)
}

#[cfg(target_arch = "wasm32")]
pub async fn sleep_ms(milliseconds: u32) {
    gloo_timers::future::TimeoutFuture::new(milliseconds).await;
}

#[cfg(not(target_arch = "wasm32"))]
pub async fn sleep_ms(_milliseconds: u32) {}

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
