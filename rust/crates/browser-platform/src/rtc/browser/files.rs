use wasm_bindgen::{JsCast, JsValue};
use web_sys::{File, HtmlInputElement};

use super::{
    super::{BrowserPlatformError, TransferFile},
    browser_error,
};
use crate::source_storage::{
    choose_source_files, persistent_source_file_support as source_file_support,
};

#[derive(Clone)]
pub struct BrowserFile {
    pub(super) inner: File,
    pub(super) source_handle: Option<JsValue>,
}

impl BrowserFile {
    pub fn name(&self) -> String {
        self.inner.name()
    }

    pub fn mime(&self) -> Option<String> {
        let value = self.inner.type_();
        (!value.is_empty()).then_some(value)
    }

    pub fn size_bytes(&self) -> u64 {
        self.inner.size() as u64
    }

    pub(super) fn last_modified_ms(&self) -> u64 {
        self.inner.last_modified() as u64
    }

    pub(super) fn metadata(&self) -> TransferFile {
        TransferFile {
            name: self.name(),
            mime: self.mime(),
            size_bytes: self.size_bytes(),
        }
    }
}

pub fn browser_files_from_input(
    element_id: &str,
) -> Result<Vec<BrowserFile>, BrowserPlatformError> {
    let document = web_sys::window()
        .ok_or(BrowserPlatformError::MissingWindow)?
        .document()
        .ok_or_else(|| BrowserPlatformError::Browser("document is unavailable".to_owned()))?;
    let element = document
        .get_element_by_id(element_id)
        .ok_or_else(|| BrowserPlatformError::Browser("file input is unavailable".to_owned()))?;
    let input = element
        .dyn_into::<HtmlInputElement>()
        .map_err(|element| browser_error(element.into()))?;
    let files = input
        .files()
        .map(|files| {
            (0..files.length())
                .filter_map(|index| files.get(index))
                .map(|inner| BrowserFile {
                    inner,
                    source_handle: None,
                })
                .collect()
        })
        .unwrap_or_default();
    input.set_value("");
    Ok(files)
}

pub fn persistent_source_file_support() -> bool {
    source_file_support()
}

pub async fn choose_persistent_source_files() -> Result<Vec<BrowserFile>, BrowserPlatformError> {
    choose_source_files().await.map(|files| {
        files
            .into_iter()
            .map(|file| BrowserFile {
                inner: file.file,
                source_handle: Some(file.handle),
            })
            .collect()
    })
}
