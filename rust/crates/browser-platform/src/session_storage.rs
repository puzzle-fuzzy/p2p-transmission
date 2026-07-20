use crate::BrowserPlatformError;

#[cfg(target_arch = "wasm32")]
use p2p_protocol::ROOM_SESSION_STORAGE_KEY;

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
