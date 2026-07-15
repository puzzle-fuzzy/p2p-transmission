use crate::BrowserPlatformError;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StreamingStorageSupport {
    DirectFile,
    Unavailable,
}

#[cfg(target_arch = "wasm32")]
mod browser {
    use std::collections::BTreeSet;

    use blake3::Hasher;
    use js_sys::{Function, Object, Promise, Reflect, Uint8Array};
    use wasm_bindgen::{JsCast, JsValue};
    use wasm_bindgen_futures::JsFuture;
    use web_sys::File;

    use super::{BrowserPlatformError, StreamingStorageSupport};
    use crate::{BrowserStorageErrorKind, BrowserStorageOperation};

    pub struct StreamingFileWriter {
        handle: JsValue,
        writable: JsValue,
        next_offset: u64,
        closed: bool,
    }

    #[derive(Clone)]
    pub(crate) struct StreamingFileAbortHandle {
        writable: JsValue,
    }

    pub(crate) struct RecoveredStreamingFile {
        pub writer: StreamingFileWriter,
        pub hasher: Hasher,
        pub last_segment_blake3: Option<String>,
    }

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    pub(crate) enum StreamFilePermission {
        Granted,
        Prompt,
        Denied,
    }

    impl StreamingFileWriter {
        pub fn next_offset(&self) -> u64 {
            self.next_offset
        }

        pub(crate) fn recovery_handle(&self) -> JsValue {
            self.handle.clone()
        }

        pub(crate) fn abort_handle(&self) -> Option<StreamingFileAbortHandle> {
            (!self.closed).then(|| StreamingFileAbortHandle {
                writable: self.writable.clone(),
            })
        }

        pub async fn write_at(
            &mut self,
            offset: u64,
            bytes: &[u8],
        ) -> Result<(), BrowserPlatformError> {
            if self.closed {
                return Err(BrowserPlatformError::Browser(
                    "streaming file writer is already closed".to_owned(),
                ));
            }
            if offset != self.next_offset {
                return Err(BrowserPlatformError::Browser(format!(
                    "streaming write offset {offset} does not match {}",
                    self.next_offset
                )));
            }
            let next_offset = offset.checked_add(bytes.len() as u64).ok_or_else(|| {
                BrowserPlatformError::Browser("streaming offset overflow".to_owned())
            })?;
            let command = Object::new();
            Reflect::set(
                &command,
                &JsValue::from_str("type"),
                &JsValue::from_str("write"),
            )
            .map_err(|value| storage_error(BrowserStorageOperation::WriteDestination, value))?;
            Reflect::set(
                &command,
                &JsValue::from_str("position"),
                &JsValue::from_f64(offset as f64),
            )
            .map_err(|value| storage_error(BrowserStorageOperation::WriteDestination, value))?;
            let data = Uint8Array::from(bytes);
            Reflect::set(&command, &JsValue::from_str("data"), data.as_ref())
                .map_err(|value| storage_error(BrowserStorageOperation::WriteDestination, value))?;
            call_promise_method(
                &self.writable,
                "write",
                command.as_ref(),
                BrowserStorageOperation::WriteDestination,
            )
            .await?;
            self.next_offset = next_offset;
            Ok(())
        }

        pub(crate) async fn commit_checkpoint(&mut self) -> Result<(), BrowserPlatformError> {
            if self.closed {
                return Err(BrowserPlatformError::Browser(
                    "streaming file writer is already closed".to_owned(),
                ));
            }
            call_promise_method(
                &self.writable,
                "close",
                &JsValue::UNDEFINED,
                BrowserStorageOperation::CommitDestination,
            )
            .await?;
            self.closed = true;
            Ok(())
        }

        pub(crate) async fn reopen_after_checkpoint(&mut self) -> Result<(), BrowserPlatformError> {
            if !self.closed {
                return Err(BrowserPlatformError::Browser(
                    "streaming file writer must commit before reopening".to_owned(),
                ));
            }
            let options = Object::new();
            Reflect::set(
                &options,
                &JsValue::from_str("keepExistingData"),
                &JsValue::from_bool(true),
            )
            .map_err(|value| storage_error(BrowserStorageOperation::ReopenDestination, value))?;
            self.writable = call_promise_method(
                &self.handle,
                "createWritable",
                options.as_ref(),
                BrowserStorageOperation::ReopenDestination,
            )
            .await?;
            self.closed = false;
            Ok(())
        }

        pub async fn close(mut self) -> Result<(), BrowserPlatformError> {
            if self.closed {
                return Ok(());
            }
            call_promise_method(
                &self.writable,
                "close",
                &JsValue::UNDEFINED,
                BrowserStorageOperation::CloseDestination,
            )
            .await?;
            self.closed = true;
            Ok(())
        }

        pub async fn abort(mut self) -> Result<(), BrowserPlatformError> {
            if self.closed {
                return Ok(());
            }
            call_promise_method(
                &self.writable,
                "abort",
                &JsValue::UNDEFINED,
                BrowserStorageOperation::AbortDestination,
            )
            .await?;
            self.closed = true;
            Ok(())
        }
    }

    impl StreamingFileAbortHandle {
        pub(crate) async fn abort(&self) -> Result<(), BrowserPlatformError> {
            call_promise_method(
                &self.writable,
                "abort",
                &JsValue::UNDEFINED,
                BrowserStorageOperation::AbortDestination,
            )
            .await
            .map(|_| ())
        }
    }

    impl Drop for StreamingFileWriter {
        fn drop(&mut self) {
            if self.closed {
                return;
            }
            if let Ok(method) = method(
                &self.writable,
                "abort",
                BrowserStorageOperation::AbortDestination,
            ) {
                let _ = method.call0(&self.writable);
            }
        }
    }

    pub fn streaming_storage_support() -> StreamingStorageSupport {
        let Some(window) = web_sys::window() else {
            return StreamingStorageSupport::Unavailable;
        };
        let secure = Reflect::get(window.as_ref(), &JsValue::from_str("isSecureContext"))
            .ok()
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
        let has_picker = Reflect::get(window.as_ref(), &JsValue::from_str("showSaveFilePicker"))
            .ok()
            .is_some_and(|value| value.is_function());
        if secure && has_picker {
            StreamingStorageSupport::DirectFile
        } else {
            StreamingStorageSupport::Unavailable
        }
    }

    pub fn streaming_batch_storage_supported() -> bool {
        let Some(window) = web_sys::window() else {
            return false;
        };
        let secure = Reflect::get(window.as_ref(), &JsValue::from_str("isSecureContext"))
            .ok()
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
        let has_picker = Reflect::get(window.as_ref(), &JsValue::from_str("showDirectoryPicker"))
            .ok()
            .is_some_and(|value| value.is_function());
        secure && has_picker
    }

    pub async fn choose_stream_file(
        suggested_name: &str,
    ) -> Result<StreamingFileWriter, BrowserPlatformError> {
        if streaming_storage_support() != StreamingStorageSupport::DirectFile {
            return Err(BrowserPlatformError::Browser(
                "streaming file saving is unavailable in this browser".to_owned(),
            ));
        }
        let window = web_sys::window().ok_or(BrowserPlatformError::MissingWindow)?;
        let picker = method(
            window.as_ref(),
            "showSaveFilePicker",
            BrowserStorageOperation::ChooseDestination,
        )?;
        let options = Object::new();
        Reflect::set(
            &options,
            &JsValue::from_str("suggestedName"),
            &JsValue::from_str(suggested_name),
        )
        .map_err(|value| storage_error(BrowserStorageOperation::ChooseDestination, value))?;
        let picker_result = picker
            .call1(window.as_ref(), options.as_ref())
            .map_err(|value| storage_error(BrowserStorageOperation::ChooseDestination, value))?
            .dyn_into::<Promise>()
            .map_err(|value| storage_error(BrowserStorageOperation::ChooseDestination, value))?;
        let handle = JsFuture::from(picker_result)
            .await
            .map_err(|value| storage_error(BrowserStorageOperation::ChooseDestination, value))?;
        let writable = call_promise_method(
            &handle,
            "createWritable",
            &JsValue::UNDEFINED,
            BrowserStorageOperation::OpenDestination,
        )
        .await?;
        Ok(StreamingFileWriter {
            handle,
            writable,
            next_offset: 0,
            closed: false,
        })
    }

    pub async fn choose_stream_files(
        suggested_names: &[String],
    ) -> Result<Vec<StreamingFileWriter>, BrowserPlatformError> {
        match suggested_names {
            [] => {
                return Err(BrowserPlatformError::Browser(
                    "streaming file list is empty".to_owned(),
                ));
            }
            [name] => return choose_stream_file(name).await.map(|writer| vec![writer]),
            _ => {}
        }
        if !streaming_batch_storage_supported() {
            return Err(BrowserPlatformError::Browser(
                "streaming folder saving is unavailable in this browser".to_owned(),
            ));
        }
        let window = web_sys::window().ok_or(BrowserPlatformError::MissingWindow)?;
        let picker = method(
            window.as_ref(),
            "showDirectoryPicker",
            BrowserStorageOperation::ChooseDestination,
        )?;
        let picker_options = Object::new();
        Reflect::set(
            &picker_options,
            &JsValue::from_str("mode"),
            &JsValue::from_str("readwrite"),
        )
        .map_err(|value| storage_error(BrowserStorageOperation::ChooseDestination, value))?;
        let picker_result = picker
            .call1(window.as_ref(), picker_options.as_ref())
            .map_err(|value| storage_error(BrowserStorageOperation::ChooseDestination, value))?
            .dyn_into::<Promise>()
            .map_err(|value| storage_error(BrowserStorageOperation::ChooseDestination, value))?;
        let directory = JsFuture::from(picker_result)
            .await
            .map_err(|value| storage_error(BrowserStorageOperation::ChooseDestination, value))?;
        let names = unique_destination_names(suggested_names);
        let mut writers = Vec::with_capacity(names.len());
        for name in names {
            let options = Object::new();
            Reflect::set(
                &options,
                &JsValue::from_str("create"),
                &JsValue::from_bool(true),
            )
            .map_err(|value| storage_error(BrowserStorageOperation::OpenDestination, value))?;
            let get_file = method(
                &directory,
                "getFileHandle",
                BrowserStorageOperation::OpenDestination,
            )?;
            let handle_result = get_file
                .call2(&directory, &JsValue::from_str(&name), options.as_ref())
                .map_err(|value| storage_error(BrowserStorageOperation::OpenDestination, value))?
                .dyn_into::<Promise>()
                .map_err(|value| storage_error(BrowserStorageOperation::OpenDestination, value))?;
            let handle = JsFuture::from(handle_result)
                .await
                .map_err(|value| storage_error(BrowserStorageOperation::OpenDestination, value))?;
            let writable = call_promise_method(
                &handle,
                "createWritable",
                &JsValue::UNDEFINED,
                BrowserStorageOperation::OpenDestination,
            )
            .await?;
            writers.push(StreamingFileWriter {
                handle,
                writable,
                next_offset: 0,
                closed: false,
            });
        }
        Ok(writers)
    }

    pub(crate) async fn stream_file_permissions(
        handles: &[JsValue],
        request: bool,
    ) -> Result<Vec<StreamFilePermission>, BrowserPlatformError> {
        let method_name = if request {
            "requestPermission"
        } else {
            "queryPermission"
        };
        let options = Object::new();
        Reflect::set(
            &options,
            &JsValue::from_str("mode"),
            &JsValue::from_str("readwrite"),
        )
        .map_err(|value| storage_error(BrowserStorageOperation::RequestPermission, value))?;

        // Start every permission request synchronously so a batch restore remains
        // inside the user activation created by the dialog button.
        let mut promises = Vec::with_capacity(handles.len());
        for handle in handles {
            let value = method(
                handle,
                method_name,
                BrowserStorageOperation::RequestPermission,
            )?
            .call1(handle, options.as_ref())
            .map_err(|value| storage_error(BrowserStorageOperation::RequestPermission, value))?;
            promises.push(value.dyn_into::<Promise>().map_err(|value| {
                storage_error(BrowserStorageOperation::RequestPermission, value)
            })?);
        }

        let mut permissions = Vec::with_capacity(promises.len());
        for promise in promises {
            let value = JsFuture::from(promise).await.map_err(|value| {
                storage_error(BrowserStorageOperation::RequestPermission, value)
            })?;
            permissions.push(match value.as_string().as_deref() {
                Some("granted") => StreamFilePermission::Granted,
                Some("prompt") => StreamFilePermission::Prompt,
                Some("denied") => StreamFilePermission::Denied,
                _ => {
                    return Err(BrowserPlatformError::Browser(
                        "file handle returned an unknown permission state".to_owned(),
                    ));
                }
            });
        }
        Ok(permissions)
    }

    pub(crate) async fn reopen_stream_file(
        handle: JsValue,
        committed_bytes: u64,
        expected_size_bytes: u64,
        segment_bytes: u32,
    ) -> Result<RecoveredStreamingFile, BrowserPlatformError> {
        let file = call_promise_method(
            &handle,
            "getFile",
            &JsValue::UNDEFINED,
            BrowserStorageOperation::ReadDestination,
        )
        .await?
        .dyn_into::<File>()
        .map_err(|value| storage_error(BrowserStorageOperation::ReadDestination, value))?;
        if file.size() < committed_bytes as f64 || file.size() > expected_size_bytes as f64 {
            return Err(BrowserPlatformError::Browser(
                "saved file size is outside the recovery manifest".to_owned(),
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
                .map_err(|value| storage_error(BrowserStorageOperation::ReadDestination, value))?;
            let buffer = JsFuture::from(blob.array_buffer())
                .await
                .map_err(|value| storage_error(BrowserStorageOperation::ReadDestination, value))?;
            let array = Uint8Array::new(&buffer);
            let mut bytes = vec![0_u8; array.length() as usize];
            array.copy_to(&mut bytes);
            if bytes.len() as u64 != end - offset {
                return Err(BrowserPlatformError::Browser(
                    "saved file changed while validating the recovery checkpoint".to_owned(),
                ));
            }
            hasher.update(&bytes);
            last_segment_blake3 = Some(blake3::hash(&bytes).to_hex().to_string());
            offset = end;
        }

        let options = Object::new();
        Reflect::set(
            &options,
            &JsValue::from_str("keepExistingData"),
            &JsValue::from_bool(committed_bytes > 0),
        )
        .map_err(|value| storage_error(BrowserStorageOperation::ReopenDestination, value))?;
        let writable = call_promise_method(
            &handle,
            "createWritable",
            options.as_ref(),
            BrowserStorageOperation::ReopenDestination,
        )
        .await?;
        Ok(RecoveredStreamingFile {
            writer: StreamingFileWriter {
                handle,
                writable,
                next_offset: committed_bytes,
                closed: false,
            },
            hasher,
            last_segment_blake3,
        })
    }

    fn unique_destination_names(names: &[String]) -> Vec<String> {
        let mut used = BTreeSet::new();
        names
            .iter()
            .map(|name| {
                if used.insert(name.clone()) {
                    return name.clone();
                }
                let (stem, extension) = name
                    .rsplit_once('.')
                    .filter(|(stem, _)| !stem.is_empty())
                    .map_or((name.as_str(), ""), |(stem, extension)| (stem, extension));
                let mut suffix = 2_u32;
                loop {
                    let candidate = if extension.is_empty() {
                        format!("{stem} ({suffix})")
                    } else {
                        format!("{stem} ({suffix}).{extension}")
                    };
                    if used.insert(candidate.clone()) {
                        break candidate;
                    }
                    suffix += 1;
                }
            })
            .collect()
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
        .map_err(|value| storage_error(operation, value))?;
        let promise = value
            .dyn_into::<Promise>()
            .map_err(|value| storage_error(operation, value))?;
        JsFuture::from(promise)
            .await
            .map_err(|value| storage_error(operation, value))
    }

    fn method(
        target: &JsValue,
        name: &str,
        operation: BrowserStorageOperation,
    ) -> Result<Function, BrowserPlatformError> {
        Reflect::get(target, &JsValue::from_str(name))
            .map_err(|value| storage_error(operation, value))?
            .dyn_into::<Function>()
            .map_err(|value| storage_error(operation, value))
    }

    fn storage_error(operation: BrowserStorageOperation, value: JsValue) -> BrowserPlatformError {
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
}

#[cfg(target_arch = "wasm32")]
pub use browser::{
    StreamingFileWriter, choose_stream_file, choose_stream_files,
    streaming_batch_storage_supported, streaming_storage_support,
};

#[cfg(target_arch = "wasm32")]
pub(crate) use browser::{
    StreamFilePermission, StreamingFileAbortHandle, reopen_stream_file, stream_file_permissions,
};

#[cfg(not(target_arch = "wasm32"))]
mod native {
    use super::{BrowserPlatformError, StreamingStorageSupport};

    pub struct StreamingFileWriter;

    impl StreamingFileWriter {
        pub fn next_offset(&self) -> u64 {
            0
        }

        pub async fn write_at(
            &mut self,
            _offset: u64,
            _bytes: &[u8],
        ) -> Result<(), BrowserPlatformError> {
            Err(BrowserPlatformError::UnsupportedTarget)
        }

        pub async fn close(self) -> Result<(), BrowserPlatformError> {
            Err(BrowserPlatformError::UnsupportedTarget)
        }

        pub async fn abort(self) -> Result<(), BrowserPlatformError> {
            Err(BrowserPlatformError::UnsupportedTarget)
        }
    }

    pub fn streaming_storage_support() -> StreamingStorageSupport {
        StreamingStorageSupport::Unavailable
    }

    pub fn streaming_batch_storage_supported() -> bool {
        false
    }

    pub async fn choose_stream_file(
        _suggested_name: &str,
    ) -> Result<StreamingFileWriter, BrowserPlatformError> {
        Err(BrowserPlatformError::UnsupportedTarget)
    }

    pub async fn choose_stream_files(
        _suggested_names: &[String],
    ) -> Result<Vec<StreamingFileWriter>, BrowserPlatformError> {
        Err(BrowserPlatformError::UnsupportedTarget)
    }
}

#[cfg(not(target_arch = "wasm32"))]
pub use native::{
    StreamingFileWriter, choose_stream_file, choose_stream_files,
    streaming_batch_storage_supported, streaming_storage_support,
};
