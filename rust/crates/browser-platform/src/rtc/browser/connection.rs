use js_sys::{Array, Reflect};
use wasm_bindgen::JsValue;
use web_sys::{RtcConfiguration, RtcIceServer, RtcPeerConnectionState};

use super::{
    super::{BrowserPlatformError, RtcConfigResponse, RtcConnectionPhase},
    browser_error,
};

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

pub(super) fn description_sdp(value: &JsValue) -> Result<String, BrowserPlatformError> {
    Reflect::get(value, &JsValue::from_str("sdp"))
        .map_err(browser_error)?
        .as_string()
        .ok_or_else(|| BrowserPlatformError::Decode("RTC description has no SDP".to_owned()))
}
