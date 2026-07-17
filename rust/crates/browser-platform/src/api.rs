#[cfg(target_arch = "wasm32")]
use p2p_protocol::ErrorEnvelope;
use p2p_protocol::{
    CURRENT_PROTOCOL, CreateInviteRequest, CreateInviteResponse, CreateRoomRequest,
    CreateRoomResponse, CreateSessionRequest, DecideJoinRequest, JoinDecisionRequest,
    JoinRequestResponse, LeaveRoomRequest, RequestJoinRequest, RoomBootstrapResponse,
    RoomMutationResponse, RtcConfigResponse, SessionResponse,
};
use serde::{Serialize, de::DeserializeOwned};

use crate::BrowserPlatformError;

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
