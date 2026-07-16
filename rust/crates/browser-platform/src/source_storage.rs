use blake3::Hasher;
use js_sys::{Array, Function, Object, Promise, Reflect, Uint8Array};
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;
use web_sys::File;

use crate::{BrowserPlatformError, BrowserStorageErrorKind, BrowserStorageOperation};

#[derive(Clone)]
pub(crate) struct SelectedSourceFile {
    pub file: File,
    pub handle: JsValue,
}

pub(crate) struct RecoveredSourceFile {
    pub file: File,
    pub hasher: Hasher,
    pub last_segment_blake3: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum SourceFilePermission {
    Granted,
    Prompt,
    Denied,
}

pub(crate) fn persistent_source_file_support() -> bool {
    let Some(window) = web_sys::window() else {
        return false;
    };
    let secure = Reflect::get(window.as_ref(), &JsValue::from_str("isSecureContext"))
        .ok()
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let has_picker = Reflect::get(window.as_ref(), &JsValue::from_str("showOpenFilePicker"))
        .ok()
        .is_some_and(|value| value.is_function());
    secure && has_picker
}

pub(crate) async fn choose_source_files() -> Result<Vec<SelectedSourceFile>, BrowserPlatformError> {
    if !persistent_source_file_support() {
        return Err(BrowserPlatformError::Browser(
            "persistent source file selection is unavailable in this browser".to_owned(),
        ));
    }
    let window = web_sys::window().ok_or(BrowserPlatformError::MissingWindow)?;
    let options = Object::new();
    Reflect::set(
        &options,
        &JsValue::from_str("multiple"),
        &JsValue::from_bool(true),
    )
    .map_err(|value| source_error(BrowserStorageOperation::ChooseSource, value))?;
    let picker = method(
        window.as_ref(),
        "showOpenFilePicker",
        BrowserStorageOperation::ChooseSource,
    )?;
    let result = picker
        .call1(window.as_ref(), options.as_ref())
        .map_err(|value| source_error(BrowserStorageOperation::ChooseSource, value))?
        .dyn_into::<Promise>()
        .map_err(|value| source_error(BrowserStorageOperation::ChooseSource, value))?;
    let handles = Array::from(
        &JsFuture::from(result)
            .await
            .map_err(|value| source_error(BrowserStorageOperation::ChooseSource, value))?,
    );
    let mut files = Vec::with_capacity(handles.length() as usize);
    for handle in handles.iter() {
        let file = call_promise_method(
            &handle,
            "getFile",
            &JsValue::UNDEFINED,
            BrowserStorageOperation::ReadSource,
        )
        .await?
        .dyn_into::<File>()
        .map_err(|value| source_error(BrowserStorageOperation::ReadSource, value))?;
        files.push(SelectedSourceFile { file, handle });
    }
    Ok(files)
}

pub(crate) async fn source_file_permissions(
    handles: &[JsValue],
    request: bool,
) -> Result<Vec<SourceFilePermission>, BrowserPlatformError> {
    let method_name = if request {
        "requestPermission"
    } else {
        "queryPermission"
    };
    let options = Object::new();
    Reflect::set(
        &options,
        &JsValue::from_str("mode"),
        &JsValue::from_str("read"),
    )
    .map_err(|value| source_error(BrowserStorageOperation::RequestPermission, value))?;
    let mut promises = Vec::with_capacity(handles.len());
    for handle in handles {
        let value = method(
            handle,
            method_name,
            BrowserStorageOperation::RequestPermission,
        )?
        .call1(handle, options.as_ref())
        .map_err(|value| source_error(BrowserStorageOperation::RequestPermission, value))?;
        promises.push(
            value
                .dyn_into::<Promise>()
                .map_err(|value| source_error(BrowserStorageOperation::RequestPermission, value))?,
        );
    }
    let mut permissions = Vec::with_capacity(promises.len());
    for promise in promises {
        let value = JsFuture::from(promise)
            .await
            .map_err(|value| source_error(BrowserStorageOperation::RequestPermission, value))?;
        permissions.push(match value.as_string().as_deref() {
            Some("granted") => SourceFilePermission::Granted,
            Some("prompt") => SourceFilePermission::Prompt,
            Some("denied") => SourceFilePermission::Denied,
            _ => {
                return Err(BrowserPlatformError::Browser(
                    "source file returned an unknown permission state".to_owned(),
                ));
            }
        });
    }
    Ok(permissions)
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn recover_source_file(
    handle: JsValue,
    expected_name: &str,
    expected_mime: Option<&str>,
    expected_size_bytes: u64,
    expected_last_modified_ms: u64,
    committed_bytes: u64,
    segment_bytes: u32,
) -> Result<RecoveredSourceFile, BrowserPlatformError> {
    let file = call_promise_method(
        &handle,
        "getFile",
        &JsValue::UNDEFINED,
        BrowserStorageOperation::ReadSource,
    )
    .await?
    .dyn_into::<File>()
    .map_err(|value| source_error(BrowserStorageOperation::ReadSource, value))?;
    let actual_mime = (!file.type_().is_empty()).then(|| file.type_());
    if file.name() != expected_name
        || actual_mime.as_deref() != expected_mime
        || file.size() != expected_size_bytes as f64
        || file.last_modified() != expected_last_modified_ms as f64
        || committed_bytes > expected_size_bytes
    {
        return Err(BrowserPlatformError::Browser(
            "source file changed after the transfer checkpoint".to_owned(),
        ));
    }

    let mut hasher = Hasher::new();
    let mut last_segment_blake3 = None;
    let mut offset = 0_u64;
    while offset < committed_bytes {
        let end = offset
            .saturating_add(u64::from(segment_bytes))
            .min(committed_bytes);
        let blob = file
            .slice_with_f64_and_f64(offset as f64, end as f64)
            .map_err(|value| source_error(BrowserStorageOperation::ReadSource, value))?;
        let buffer = JsFuture::from(blob.array_buffer())
            .await
            .map_err(|value| source_error(BrowserStorageOperation::ReadSource, value))?;
        let array = Uint8Array::new(&buffer);
        let mut bytes = vec![0_u8; array.length() as usize];
        array.copy_to(&mut bytes);
        if bytes.len() as u64 != end - offset {
            return Err(BrowserPlatformError::Browser(
                "source file changed while validating the checkpoint".to_owned(),
            ));
        }
        hasher.update(&bytes);
        last_segment_blake3 = Some(blake3::hash(&bytes).to_hex().to_string());
        offset = end;
    }
    Ok(RecoveredSourceFile {
        file,
        hasher,
        last_segment_blake3,
    })
}

async fn call_promise_method(
    target: &JsValue,
    name: &str,
    argument: &JsValue,
    operation: BrowserStorageOperation,
) -> Result<JsValue, BrowserPlatformError> {
    let method = method(target, name, operation)?;
    let value = if argument.is_undefined() {
        method.call0(target)
    } else {
        method.call1(target, argument)
    }
    .map_err(|value| source_error(operation, value))?;
    JsFuture::from(
        value
            .dyn_into::<Promise>()
            .map_err(|value| source_error(operation, value))?,
    )
    .await
    .map_err(|value| source_error(operation, value))
}

fn method(
    target: &JsValue,
    name: &str,
    operation: BrowserStorageOperation,
) -> Result<Function, BrowserPlatformError> {
    Reflect::get(target, &JsValue::from_str(name))
        .map_err(|value| source_error(operation, value))?
        .dyn_into::<Function>()
        .map_err(|value| source_error(operation, value))
}

fn source_error(operation: BrowserStorageOperation, value: JsValue) -> BrowserPlatformError {
    let name = Reflect::get(&value, &JsValue::from_str("name"))
        .ok()
        .and_then(|value| value.as_string());
    if name.as_deref() == Some("AbortError") {
        return BrowserPlatformError::UserCancelled;
    }
    let message = Reflect::get(&value, &JsValue::from_str("message"))
        .ok()
        .and_then(|value| value.as_string())
        .or_else(|| value.as_string())
        .unwrap_or_else(|| format!("{value:?}"));
    BrowserPlatformError::Storage {
        operation,
        kind: BrowserStorageErrorKind::from_dom_exception_name(name.as_deref()),
        message,
    }
}
