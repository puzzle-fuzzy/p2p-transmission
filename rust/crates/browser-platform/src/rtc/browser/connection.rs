use js_sys::Array;
use wasm_bindgen::JsValue;
use web_sys::{RtcConfiguration, RtcIceServer, RtcPeerConnection, RtcPeerConnectionState};

use super::super::{BrowserPlatformError, RtcConfigResponse, RtcConnectionPhase};

pub(super) fn rtc_configuration(response: &RtcConfigResponse) -> RtcConfiguration {
    let configuration = RtcConfiguration::new();
    let servers = Array::new();
    for value in &response.ice_servers {
        let server = RtcIceServer::new();
        let urls = Array::new();
        for url in &value.urls {
            urls.push(&JsValue::from_str(url));
        }
        server.set_urls_str_sequence(urls.as_ref());
        if let Some(username) = &value.username {
            server.set_username(username);
        }
        if let Some(credential) = &value.credential {
            server.set_credential(credential);
        }
        servers.push(&server);
    }
    configuration.set_ice_servers(servers.as_ref());
    configuration
}

pub(super) fn map_connection_state(state: RtcPeerConnectionState) -> RtcConnectionPhase {
    match state {
        RtcPeerConnectionState::New => RtcConnectionPhase::New,
        RtcPeerConnectionState::Connecting => RtcConnectionPhase::Connecting,
        RtcPeerConnectionState::Connected => RtcConnectionPhase::Connected,
        RtcPeerConnectionState::Disconnected => RtcConnectionPhase::Disconnected,
        RtcPeerConnectionState::Failed => RtcConnectionPhase::Failed,
        RtcPeerConnectionState::Closed => RtcConnectionPhase::Closed,
        _ => RtcConnectionPhase::Failed,
    }
}

pub(super) fn local_description_sdp(
    peer_connection: &RtcPeerConnection,
) -> Result<String, BrowserPlatformError> {
    let description = peer_connection.local_description().ok_or_else(|| {
        BrowserPlatformError::Decode("RTC local description is unavailable".to_owned())
    })?;
    let sdp = description.sdp();
    if sdp.is_empty() {
        return Err(BrowserPlatformError::Decode(
            "RTC local description has no SDP".to_owned(),
        ));
    }
    Ok(sdp)
}
