use std::{cell::RefCell, rc::Rc};

use futures_channel::oneshot;
use js_sys::{Array, Object, Reflect};
use wasm_bindgen::{JsCast, JsValue, closure::Closure};
use web_sys::{Event, IdbDatabase, IdbObjectStore, IdbRequest, IdbTransactionMode};

use crate::BrowserPlatformError;

const DATABASE_NAME: &str = "p2p-transmission";
const DATABASE_VERSION: u32 = 2;
const STREAM_STORE_NAME: &str = "stream-recovery";
const OUTGOING_STORE_NAME: &str = "outgoing-recovery";
const RECORD_VERSION: u32 = 1;

#[derive(Clone)]
pub(crate) struct StreamRecoveryFile {
    pub file_id: String,
    pub name: String,
    pub mime: Option<String>,
    pub size_bytes: u64,
    pub handle: JsValue,
    pub committed_bytes: u64,
    pub last_segment_blake3: Option<String>,
}

#[derive(Clone)]
pub(crate) struct StreamRecoveryRecord {
    pub transfer_id: String,
    pub peer_id: String,
    pub segment_bytes: u32,
    pub files: Vec<StreamRecoveryFile>,
}

#[derive(Clone)]
pub(crate) struct OutgoingRecoveryFile {
    pub file_id: String,
    pub name: String,
    pub mime: Option<String>,
    pub size_bytes: u64,
    pub last_modified_ms: u64,
    pub handle: JsValue,
    pub committed_bytes: u64,
    pub last_segment_blake3: Option<String>,
}

#[derive(Clone)]
pub(crate) struct OutgoingRecoveryRecord {
    pub transfer_id: String,
    pub peer_id: String,
    pub segment_bytes: u32,
    pub files: Vec<OutgoingRecoveryFile>,
}

pub(crate) async fn save_stream_recovery(
    record: &StreamRecoveryRecord,
) -> Result<(), BrowserPlatformError> {
    let database = open_database().await?;
    let transaction = database
        .transaction_with_str_and_mode(STREAM_STORE_NAME, IdbTransactionMode::Readwrite)
        .map_err(indexed_db_error)?;
    let store = transaction
        .object_store(STREAM_STORE_NAME)
        .map_err(indexed_db_error)?;
    let request = store
        .put_with_key(
            &record_to_js(record)?,
            &JsValue::from_str(&record.transfer_id),
        )
        .map_err(indexed_db_error)?;
    await_request(&request).await?;
    database.close();
    Ok(())
}

pub(crate) async fn load_stream_recovery(
    transfer_id: &str,
) -> Result<Option<StreamRecoveryRecord>, BrowserPlatformError> {
    let database = open_database().await?;
    let transaction = database
        .transaction_with_str_and_mode(STREAM_STORE_NAME, IdbTransactionMode::Readonly)
        .map_err(indexed_db_error)?;
    let store = transaction
        .object_store(STREAM_STORE_NAME)
        .map_err(indexed_db_error)?;
    let request = store
        .get(&JsValue::from_str(transfer_id))
        .map_err(indexed_db_error)?;
    let value = await_request(&request).await?;
    database.close();
    if value.is_undefined() {
        Ok(None)
    } else {
        record_from_js(&value).map(Some)
    }
}

pub(crate) async fn delete_stream_recovery(transfer_id: &str) -> Result<(), BrowserPlatformError> {
    let database = open_database().await?;
    let transaction = database
        .transaction_with_str_and_mode(STREAM_STORE_NAME, IdbTransactionMode::Readwrite)
        .map_err(indexed_db_error)?;
    let store = transaction
        .object_store(STREAM_STORE_NAME)
        .map_err(indexed_db_error)?;
    let request = store
        .delete(&JsValue::from_str(transfer_id))
        .map_err(indexed_db_error)?;
    await_request(&request).await?;
    database.close();
    Ok(())
}

pub(crate) async fn save_outgoing_recovery(
    record: &OutgoingRecoveryRecord,
) -> Result<(), BrowserPlatformError> {
    let database = open_database().await?;
    let transaction = database
        .transaction_with_str_and_mode(OUTGOING_STORE_NAME, IdbTransactionMode::Readwrite)
        .map_err(indexed_db_error)?;
    let store = transaction
        .object_store(OUTGOING_STORE_NAME)
        .map_err(indexed_db_error)?;
    let request = store
        .put_with_key(
            &outgoing_record_to_js(record)?,
            &JsValue::from_str(&record.peer_id),
        )
        .map_err(indexed_db_error)?;
    await_request(&request).await?;
    database.close();
    Ok(())
}

pub(crate) async fn load_outgoing_recovery(
    peer_id: &str,
) -> Result<Option<OutgoingRecoveryRecord>, BrowserPlatformError> {
    let database = open_database().await?;
    let transaction = database
        .transaction_with_str_and_mode(OUTGOING_STORE_NAME, IdbTransactionMode::Readonly)
        .map_err(indexed_db_error)?;
    let store = transaction
        .object_store(OUTGOING_STORE_NAME)
        .map_err(indexed_db_error)?;
    let request = store
        .get(&JsValue::from_str(peer_id))
        .map_err(indexed_db_error)?;
    let value = await_request(&request).await?;
    database.close();
    if value.is_undefined() {
        Ok(None)
    } else {
        outgoing_record_from_js(&value).map(Some)
    }
}

pub(crate) async fn delete_outgoing_recovery(peer_id: &str) -> Result<(), BrowserPlatformError> {
    let database = open_database().await?;
    let transaction = database
        .transaction_with_str_and_mode(OUTGOING_STORE_NAME, IdbTransactionMode::Readwrite)
        .map_err(indexed_db_error)?;
    let store = transaction
        .object_store(OUTGOING_STORE_NAME)
        .map_err(indexed_db_error)?;
    let request = store
        .delete(&JsValue::from_str(peer_id))
        .map_err(indexed_db_error)?;
    await_request(&request).await?;
    database.close();
    Ok(())
}

async fn open_database() -> Result<IdbDatabase, BrowserPlatformError> {
    let factory = web_sys::window()
        .ok_or(BrowserPlatformError::MissingWindow)?
        .indexed_db()
        .map_err(indexed_db_error)?
        .ok_or_else(|| BrowserPlatformError::Browser("IndexedDB is unavailable".to_owned()))?;
    let request = factory
        .open_with_u32(DATABASE_NAME, DATABASE_VERSION)
        .map_err(indexed_db_error)?;
    let upgrade_error = Rc::new(RefCell::new(None::<String>));
    let upgrade_request = request.clone();
    let captured_error = Rc::clone(&upgrade_error);
    let upgrade = Closure::wrap(Box::new(move |_event: Event| {
        let result = upgrade_request
            .result()
            .map_err(indexed_db_error)
            .and_then(|value| value.dyn_into::<IdbDatabase>().map_err(indexed_db_error))
            .and_then(|database| {
                for name in [STREAM_STORE_NAME, OUTGOING_STORE_NAME] {
                    if !database.object_store_names().contains(name) {
                        database
                            .create_object_store(name)
                            .map(|_: IdbObjectStore| ())
                            .map_err(indexed_db_error)?;
                    }
                }
                Ok(())
            });
        if let Err(error) = result {
            *captured_error.borrow_mut() = Some(error.to_string());
        }
    }) as Box<dyn FnMut(_)>);
    request.set_onupgradeneeded(Some(upgrade.as_ref().unchecked_ref()));

    let base_request = request.clone().unchecked_into::<IdbRequest>();
    let value = await_request(&base_request).await?;
    request.set_onupgradeneeded(None);
    drop(upgrade);
    if let Some(message) = upgrade_error.borrow_mut().take() {
        return Err(BrowserPlatformError::Browser(message));
    }
    value.dyn_into::<IdbDatabase>().map_err(indexed_db_error)
}

async fn await_request(request: &IdbRequest) -> Result<JsValue, BrowserPlatformError> {
    let (sender, receiver) = oneshot::channel();
    let sender = Rc::new(RefCell::new(Some(sender)));

    let success_request = request.clone();
    let success_sender = Rc::clone(&sender);
    let success = Closure::wrap(Box::new(move |_event: Event| {
        if let Some(sender) = success_sender.borrow_mut().take() {
            let _ = sender.send(success_request.result().map_err(indexed_db_error));
        }
    }) as Box<dyn FnMut(_)>);

    let error_request = request.clone();
    let error_sender = sender;
    let error = Closure::wrap(Box::new(move |_event: Event| {
        if let Some(sender) = error_sender.borrow_mut().take() {
            let message = error_request
                .error()
                .ok()
                .flatten()
                .map(|error| error.message())
                .unwrap_or_else(|| "IndexedDB request failed".to_owned());
            let _ = sender.send(Err(BrowserPlatformError::Browser(message)));
        }
    }) as Box<dyn FnMut(_)>);

    request.set_onsuccess(Some(success.as_ref().unchecked_ref()));
    request.set_onerror(Some(error.as_ref().unchecked_ref()));
    let result = receiver.await.map_err(|_| {
        BrowserPlatformError::Browser("IndexedDB request was interrupted".to_owned())
    })?;
    request.set_onsuccess(None);
    request.set_onerror(None);
    result
}

fn record_to_js(record: &StreamRecoveryRecord) -> Result<JsValue, BrowserPlatformError> {
    let object = Object::new();
    set(
        &object,
        "version",
        &JsValue::from_f64(RECORD_VERSION as f64),
    )?;
    set(
        &object,
        "transferId",
        &JsValue::from_str(&record.transfer_id),
    )?;
    set(&object, "peerId", &JsValue::from_str(&record.peer_id))?;
    set(
        &object,
        "segmentBytes",
        &JsValue::from_f64(record.segment_bytes as f64),
    )?;
    let files = Array::new();
    for file in &record.files {
        let value = Object::new();
        set(&value, "fileId", &JsValue::from_str(&file.file_id))?;
        set(&value, "name", &JsValue::from_str(&file.name))?;
        set(
            &value,
            "mime",
            &file
                .mime
                .as_deref()
                .map_or(JsValue::NULL, JsValue::from_str),
        )?;
        set(
            &value,
            "sizeBytes",
            &JsValue::from_f64(file.size_bytes as f64),
        )?;
        set(&value, "handle", &file.handle)?;
        set(
            &value,
            "committedBytes",
            &JsValue::from_f64(file.committed_bytes as f64),
        )?;
        set(
            &value,
            "lastSegmentBlake3",
            &file
                .last_segment_blake3
                .as_deref()
                .map_or(JsValue::NULL, JsValue::from_str),
        )?;
        files.push(value.as_ref());
    }
    set(&object, "files", files.as_ref())?;
    Ok(object.into())
}

fn record_from_js(value: &JsValue) -> Result<StreamRecoveryRecord, BrowserPlatformError> {
    if required_u64(value, "version")? != u64::from(RECORD_VERSION) {
        return Err(invalid_record("unsupported recovery record version"));
    }
    let files_value = required(value, "files")?;
    let files = Array::from(&files_value);
    if files.length() == 0 {
        return Err(invalid_record("recovery record has no files"));
    }
    let mut parsed_files = Vec::with_capacity(files.length() as usize);
    for value in files.iter() {
        let handle = required(&value, "handle")?;
        if !handle.is_object() {
            return Err(invalid_record("recovery file handle is invalid"));
        }
        parsed_files.push(StreamRecoveryFile {
            file_id: required_string(&value, "fileId")?,
            name: required_string(&value, "name")?,
            mime: optional_string(&value, "mime")?,
            size_bytes: required_u64(&value, "sizeBytes")?,
            handle,
            committed_bytes: required_u64(&value, "committedBytes")?,
            last_segment_blake3: optional_string(&value, "lastSegmentBlake3")?,
        });
    }
    let segment_bytes = required_u64(value, "segmentBytes")?;
    let segment_bytes = u32::try_from(segment_bytes)
        .map_err(|_| invalid_record("recovery segment size is invalid"))?;
    Ok(StreamRecoveryRecord {
        transfer_id: required_string(value, "transferId")?,
        peer_id: required_string(value, "peerId")?,
        segment_bytes,
        files: parsed_files,
    })
}

fn outgoing_record_to_js(record: &OutgoingRecoveryRecord) -> Result<JsValue, BrowserPlatformError> {
    let object = Object::new();
    set(
        &object,
        "version",
        &JsValue::from_f64(RECORD_VERSION as f64),
    )?;
    set(
        &object,
        "transferId",
        &JsValue::from_str(&record.transfer_id),
    )?;
    set(&object, "peerId", &JsValue::from_str(&record.peer_id))?;
    set(
        &object,
        "segmentBytes",
        &JsValue::from_f64(record.segment_bytes as f64),
    )?;
    let files = Array::new();
    for file in &record.files {
        let value = Object::new();
        set(&value, "fileId", &JsValue::from_str(&file.file_id))?;
        set(&value, "name", &JsValue::from_str(&file.name))?;
        set(
            &value,
            "mime",
            &file
                .mime
                .as_deref()
                .map_or(JsValue::NULL, JsValue::from_str),
        )?;
        set(
            &value,
            "sizeBytes",
            &JsValue::from_f64(file.size_bytes as f64),
        )?;
        set(
            &value,
            "lastModifiedMs",
            &JsValue::from_f64(file.last_modified_ms as f64),
        )?;
        set(&value, "handle", &file.handle)?;
        set(
            &value,
            "committedBytes",
            &JsValue::from_f64(file.committed_bytes as f64),
        )?;
        set(
            &value,
            "lastSegmentBlake3",
            &file
                .last_segment_blake3
                .as_deref()
                .map_or(JsValue::NULL, JsValue::from_str),
        )?;
        files.push(value.as_ref());
    }
    set(&object, "files", files.as_ref())?;
    Ok(object.into())
}

fn outgoing_record_from_js(
    value: &JsValue,
) -> Result<OutgoingRecoveryRecord, BrowserPlatformError> {
    if required_u64(value, "version")? != u64::from(RECORD_VERSION) {
        return Err(invalid_record(
            "unsupported outgoing recovery record version",
        ));
    }
    let files_value = required(value, "files")?;
    let files = Array::from(&files_value);
    if files.length() == 0 {
        return Err(invalid_record("outgoing recovery record has no files"));
    }
    let mut parsed_files = Vec::with_capacity(files.length() as usize);
    for value in files.iter() {
        let handle = required(&value, "handle")?;
        if !handle.is_object() {
            return Err(invalid_record("outgoing recovery file handle is invalid"));
        }
        parsed_files.push(OutgoingRecoveryFile {
            file_id: required_string(&value, "fileId")?,
            name: required_string(&value, "name")?,
            mime: optional_string(&value, "mime")?,
            size_bytes: required_u64(&value, "sizeBytes")?,
            last_modified_ms: required_u64(&value, "lastModifiedMs")?,
            handle,
            committed_bytes: required_u64(&value, "committedBytes")?,
            last_segment_blake3: optional_string(&value, "lastSegmentBlake3")?,
        });
    }
    let segment_bytes = required_u64(value, "segmentBytes")?;
    let segment_bytes = u32::try_from(segment_bytes)
        .map_err(|_| invalid_record("outgoing recovery segment size is invalid"))?;
    Ok(OutgoingRecoveryRecord {
        transfer_id: required_string(value, "transferId")?,
        peer_id: required_string(value, "peerId")?,
        segment_bytes,
        files: parsed_files,
    })
}

fn set(target: &Object, name: &str, value: &JsValue) -> Result<(), BrowserPlatformError> {
    Reflect::set(target, &JsValue::from_str(name), value)
        .map(|_| ())
        .map_err(indexed_db_error)
}

fn required(target: &JsValue, name: &str) -> Result<JsValue, BrowserPlatformError> {
    let value = Reflect::get(target, &JsValue::from_str(name)).map_err(indexed_db_error)?;
    if value.is_undefined() {
        Err(invalid_record(&format!("recovery field {name} is missing")))
    } else {
        Ok(value)
    }
}

fn required_string(target: &JsValue, name: &str) -> Result<String, BrowserPlatformError> {
    required(target, name)?
        .as_string()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid_record(&format!("recovery field {name} is invalid")))
}

fn optional_string(target: &JsValue, name: &str) -> Result<Option<String>, BrowserPlatformError> {
    let value = required(target, name)?;
    if value.is_null() {
        Ok(None)
    } else {
        value
            .as_string()
            .map(Some)
            .ok_or_else(|| invalid_record(&format!("recovery field {name} is invalid")))
    }
}

fn required_u64(target: &JsValue, name: &str) -> Result<u64, BrowserPlatformError> {
    let value = required(target, name)?
        .as_f64()
        .ok_or_else(|| invalid_record(&format!("recovery field {name} is invalid")))?;
    if !value.is_finite() || value < 0.0 || value.fract() != 0.0 || value > 9_007_199_254_740_991.0
    {
        return Err(invalid_record(&format!(
            "recovery field {name} is outside the exact integer range"
        )));
    }
    Ok(value as u64)
}

fn invalid_record(message: &str) -> BrowserPlatformError {
    BrowserPlatformError::Browser(message.to_owned())
}

fn indexed_db_error(value: JsValue) -> BrowserPlatformError {
    let message = Reflect::get(&value, &JsValue::from_str("message"))
        .ok()
        .and_then(|value| value.as_string())
        .or_else(|| value.as_string())
        .unwrap_or_else(|| format!("{value:?}"));
    BrowserPlatformError::Browser(message)
}
