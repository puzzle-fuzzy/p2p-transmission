use crate::{BrowserPlatformError, NativeShareOutcome};

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
pub fn native_share_supported() -> bool {
    use wasm_bindgen::JsValue;

    web_sys::window().is_some_and(|window| {
        js_sys::Reflect::get(window.navigator().as_ref(), &JsValue::from_str("share"))
            .is_ok_and(|value| value.is_function())
    })
}

#[cfg(not(target_arch = "wasm32"))]
pub fn native_share_supported() -> bool {
    false
}

#[cfg(target_arch = "wasm32")]
pub async fn share_url(
    title: &str,
    text: &str,
    url: &str,
) -> Result<NativeShareOutcome, BrowserPlatformError> {
    use wasm_bindgen::{JsCast, JsValue};
    use wasm_bindgen_futures::JsFuture;

    let window = web_sys::window().ok_or(BrowserPlatformError::MissingWindow)?;
    let navigator = window.navigator();
    let share = js_sys::Reflect::get(navigator.as_ref(), &JsValue::from_str("share"))
        .map_err(|error| BrowserPlatformError::Browser(format!("{error:?}")))?;
    if !share.is_function() {
        return Ok(NativeShareOutcome::Unsupported);
    }

    let data = js_sys::Object::new();
    for (key, value) in [("title", title), ("text", text), ("url", url)] {
        js_sys::Reflect::set(
            data.as_ref(),
            &JsValue::from_str(key),
            &JsValue::from_str(value),
        )
        .map_err(|error| BrowserPlatformError::Browser(format!("{error:?}")))?;
    }
    let promise = share
        .dyn_into::<js_sys::Function>()
        .map_err(|_| BrowserPlatformError::Browser("navigator.share is unavailable".to_owned()))?
        .call1(navigator.as_ref(), data.as_ref())
        .map(|value| js_sys::Promise::resolve(&value))
        .map_err(|error| BrowserPlatformError::Browser(format!("{error:?}")))?;
    match JsFuture::from(promise).await {
        Ok(_) => Ok(NativeShareOutcome::Shared),
        Err(error)
            if js_sys::Reflect::get(&error, &JsValue::from_str("name"))
                .ok()
                .and_then(|value| value.as_string())
                .as_deref()
                == Some("AbortError") =>
        {
            Ok(NativeShareOutcome::Cancelled)
        }
        Err(error) => Err(BrowserPlatformError::Browser(format!("{error:?}"))),
    }
}

#[cfg(not(target_arch = "wasm32"))]
pub async fn share_url(
    _title: &str,
    _text: &str,
    _url: &str,
) -> Result<NativeShareOutcome, BrowserPlatformError> {
    Err(BrowserPlatformError::UnsupportedTarget)
}

#[cfg(target_arch = "wasm32")]
pub async fn sleep_ms(milliseconds: u32) {
    gloo_timers::future::TimeoutFuture::new(milliseconds).await;
}

#[cfg(not(target_arch = "wasm32"))]
pub async fn sleep_ms(_milliseconds: u32) {}
