use crate::BrowserPlatformError;

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
pub fn prime_notification_permission() -> Result<bool, BrowserPlatformError> {
    use wasm_bindgen::{JsCast, JsValue};

    let window = web_sys::window().ok_or(BrowserPlatformError::MissingWindow)?;
    let constructor = js_sys::Reflect::get(window.as_ref(), &JsValue::from_str("Notification"))
        .map_err(|error| BrowserPlatformError::Browser(format!("{error:?}")))?;
    if constructor.is_null() || constructor.is_undefined() {
        return Ok(false);
    }
    let permission = js_sys::Reflect::get(&constructor, &JsValue::from_str("permission"))
        .ok()
        .and_then(|value| value.as_string());
    if permission.as_deref() != Some("default") {
        return Ok(permission.as_deref() == Some("granted"));
    }
    let request = js_sys::Reflect::get(&constructor, &JsValue::from_str("requestPermission"))
        .map_err(|error| BrowserPlatformError::Browser(format!("{error:?}")))?
        .dyn_into::<js_sys::Function>()
        .map_err(|_| {
            BrowserPlatformError::Browser(
                "Notification.requestPermission is unavailable".to_owned(),
            )
        })?;
    let permission = request
        .call0(&constructor)
        .map_err(|error| BrowserPlatformError::Browser(format!("{error:?}")))?;
    let promise = js_sys::Promise::resolve(&permission);
    wasm_bindgen_futures::spawn_local(async move {
        let _ = wasm_bindgen_futures::JsFuture::from(promise).await;
    });
    Ok(true)
}

#[cfg(not(target_arch = "wasm32"))]
pub fn prime_notification_permission() -> Result<bool, BrowserPlatformError> {
    Err(BrowserPlatformError::UnsupportedTarget)
}

#[cfg(target_arch = "wasm32")]
pub fn send_notification(title: &str, body: &str, tag: &str) -> Result<bool, BrowserPlatformError> {
    use wasm_bindgen::{JsCast, JsValue};

    let window = web_sys::window().ok_or(BrowserPlatformError::MissingWindow)?;
    let constructor = js_sys::Reflect::get(window.as_ref(), &JsValue::from_str("Notification"))
        .map_err(|error| BrowserPlatformError::Browser(format!("{error:?}")))?;
    if constructor.is_null() || constructor.is_undefined() {
        return Ok(false);
    }
    let permission = js_sys::Reflect::get(&constructor, &JsValue::from_str("permission"))
        .ok()
        .and_then(|value| value.as_string());
    if permission.as_deref() != Some("granted") {
        return Ok(false);
    }

    let options = js_sys::Object::new();
    js_sys::Reflect::set(
        options.as_ref(),
        &JsValue::from_str("body"),
        &JsValue::from_str(body),
    )
    .map_err(|error| BrowserPlatformError::Browser(format!("{error:?}")))?;
    js_sys::Reflect::set(
        options.as_ref(),
        &JsValue::from_str("tag"),
        &JsValue::from_str(tag),
    )
    .map_err(|error| BrowserPlatformError::Browser(format!("{error:?}")))?;

    let arguments = js_sys::Array::new();
    arguments.push(&JsValue::from_str(title));
    arguments.push(options.as_ref());
    let constructor = constructor.dyn_into::<js_sys::Function>().map_err(|_| {
        BrowserPlatformError::Browser("Notification is not constructible".to_owned())
    })?;
    js_sys::Reflect::construct(&constructor, &arguments)
        .map_err(|error| BrowserPlatformError::Browser(format!("{error:?}")))?;
    Ok(true)
}

#[cfg(not(target_arch = "wasm32"))]
pub fn send_notification(
    _title: &str,
    _body: &str,
    _tag: &str,
) -> Result<bool, BrowserPlatformError> {
    Err(BrowserPlatformError::UnsupportedTarget)
}

#[cfg(target_arch = "wasm32")]
pub async fn sleep_ms(milliseconds: u32) {
    gloo_timers::future::TimeoutFuture::new(milliseconds).await;
}

#[cfg(not(target_arch = "wasm32"))]
pub async fn sleep_ms(_milliseconds: u32) {}

#[cfg(target_arch = "wasm32")]
pub fn monotonic_millis() -> u64 {
    web_sys::window()
        .and_then(|window| window.performance())
        .map_or_else(
            || js_sys::Date::now().max(0.0) as u64,
            |performance| performance.now().max(0.0) as u64,
        )
}

#[cfg(not(target_arch = "wasm32"))]
pub fn monotonic_millis() -> u64 {
    use std::sync::OnceLock;
    use std::time::Instant;

    static ORIGIN: OnceLock<Instant> = OnceLock::new();
    ORIGIN.get_or_init(Instant::now).elapsed().as_millis() as u64
}

#[cfg(target_arch = "wasm32")]
pub fn epoch_millis() -> u64 {
    js_sys::Date::now().max(0.0) as u64
}

#[cfg(not(target_arch = "wasm32"))]
pub fn epoch_millis() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};

    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis() as u64)
}
