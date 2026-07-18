use crate::{BrowserPlatformError, LaunchIntent};

#[cfg(any(target_arch = "wasm32", test))]
fn launch_intent_from_fragment(hash: &str) -> Option<LaunchIntent> {
    let mut fields = hash.strip_prefix('#')?.split('&');
    let room_code = fields.next()?.strip_prefix("room=")?;
    let capability = fields.next()?.strip_prefix("capability=")?;
    if fields.next().is_some()
        || room_code.len() != 6
        || !room_code
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || matches!(byte, b'2'..=b'9'))
        || capability.len() != 64
        || !capability
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    {
        return None;
    }
    Some(LaunchIntent::JoinRoom {
        room_code: room_code.to_owned(),
        capability: capability.to_owned(),
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
    let intent = launch_intent_from_fragment(&hash);
    if intent.is_some() {
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
    use super::{LaunchIntent, invite_url_from_origin, launch_intent_from_fragment};

    #[test]
    fn accepts_only_the_canonical_invite_fragment() {
        let capability = "0123456789abcdef".repeat(4);
        assert_eq!(
            launch_intent_from_fragment(&format!("#room=XY45ZT&capability={capability}")),
            Some(LaunchIntent::JoinRoom {
                room_code: "XY45ZT".to_owned(),
                capability: capability.clone(),
            })
        );

        for invalid in [
            String::new(),
            "?room=XY45ZT".to_owned(),
            "#room=XY45ZT".to_owned(),
            format!("#room=XY45ZT&invite={capability}"),
            format!("#capability={capability}&room=XY45ZT"),
            format!("#room=xy45zt&capability={capability}"),
            format!(
                "#room=XY45ZT&capability={}",
                capability.to_ascii_uppercase()
            ),
            format!("#room=XY45ZT&capability={capability}&source=share"),
            format!("#room=XY45ZT&capability={capability}&room=AB23CD"),
        ] {
            assert_eq!(launch_intent_from_fragment(&invalid), None, "{invalid}");
        }
    }

    #[test]
    fn invite_links_always_use_the_canonical_root_path() {
        let capability = "0123456789abcdef".repeat(4);
        assert_eq!(
            invite_url_from_origin("https://p2p.example", "AB23CD", &capability),
            format!("https://p2p.example/#room=AB23CD&capability={capability}")
        );
    }
}
