use crate::{BrowserPlatformError, LaunchIntent};

#[cfg(any(target_arch = "wasm32", test))]
fn launch_intent_from_location(search: &str, hash: &str) -> Option<LaunchIntent> {
    let parameter = |value: &str, target: &str| {
        value
            .trim_start_matches(['?', '#'])
            .split('&')
            .filter_map(|pair| pair.split_once('='))
            .find_map(|(name, value)| (name == target).then(|| value.to_owned()))
    };
    let hash_room = parameter(hash, "room").map(|room| room.to_ascii_uppercase());
    let hash_capability = parameter(hash, "capability");
    if let Some(room_code) = hash_room {
        return Some(LaunchIntent::JoinRoom {
            room_code,
            capability: hash_capability,
        });
    }

    if parameter(search, "intent").as_deref() == Some("create") {
        return Some(LaunchIntent::CreateRoom);
    }
    parameter(search, "room")
        .map(|room| room.to_ascii_uppercase())
        .map(|room_code| LaunchIntent::JoinRoom {
            room_code,
            capability: None,
        })
}

#[cfg(target_arch = "wasm32")]
pub fn take_launch_intent() -> Result<Option<LaunchIntent>, BrowserPlatformError> {
    use wasm_bindgen::JsValue;

    let window = web_sys::window().ok_or(BrowserPlatformError::MissingWindow)?;
    let location = window.location();
    let hash = location
        .hash()
        .map_err(|error| BrowserPlatformError::Browser(format!("{error:?}")))?;
    let search = location
        .search()
        .map_err(|error| BrowserPlatformError::Browser(format!("{error:?}")))?;
    let intent = launch_intent_from_location(&search, &hash);
    let path = location
        .pathname()
        .map_err(|error| BrowserPlatformError::Browser(format!("{error:?}")))?;
    if intent.is_some() || path != "/" {
        window
            .history()
            .map_err(|error| BrowserPlatformError::Browser(format!("{error:?}")))?
            .replace_state_with_url(&JsValue::NULL, "", Some("/"))
            .map_err(|error| BrowserPlatformError::Browser(format!("{error:?}")))?;
    }
    Ok(intent)
}

#[cfg(not(target_arch = "wasm32"))]
pub fn take_launch_intent() -> Result<Option<LaunchIntent>, BrowserPlatformError> {
    Err(BrowserPlatformError::UnsupportedTarget)
}

#[cfg(target_arch = "wasm32")]
pub fn build_invite_url(room_code: &str, capability: &str) -> Result<String, BrowserPlatformError> {
    let origin = web_sys::window()
        .ok_or(BrowserPlatformError::MissingWindow)?
        .location()
        .origin()
        .map_err(|error| BrowserPlatformError::Browser(format!("{error:?}")))?;
    Ok(invite_url_from_origin(&origin, room_code, capability))
}

#[cfg(any(target_arch = "wasm32", test))]
fn invite_url_from_origin(origin: &str, room_code: &str, capability: &str) -> String {
    format!("{origin}/#room={room_code}&capability={capability}")
}

#[cfg(not(target_arch = "wasm32"))]
pub fn build_invite_url(
    _room_code: &str,
    _capability: &str,
) -> Result<String, BrowserPlatformError> {
    Err(BrowserPlatformError::UnsupportedTarget)
}

#[cfg(test)]
mod tests {
    use super::{LaunchIntent, invite_url_from_origin, launch_intent_from_location};

    #[test]
    fn parses_root_application_launch_intents() {
        assert_eq!(
            launch_intent_from_location("?intent=create", ""),
            Some(LaunchIntent::CreateRoom)
        );
        assert_eq!(
            launch_intent_from_location("?room=ab23cd", ""),
            Some(LaunchIntent::JoinRoom {
                room_code: "AB23CD".to_owned(),
                capability: None,
            })
        );
        assert_eq!(
            launch_intent_from_location(
                "?intent=create",
                "#room=XY45ZT&capability=0123456789abcdef"
            ),
            Some(LaunchIntent::JoinRoom {
                room_code: "XY45ZT".to_owned(),
                capability: Some("0123456789abcdef".to_owned()),
            })
        );
        assert_eq!(launch_intent_from_location("", ""), None);
    }

    #[test]
    fn invite_links_always_use_the_canonical_root_path() {
        assert_eq!(
            invite_url_from_origin("https://p2p.example", "AB23CD", "secret"),
            "https://p2p.example/#room=AB23CD&capability=secret"
        );
    }
}
