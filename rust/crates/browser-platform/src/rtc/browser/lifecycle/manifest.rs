use blake3::Hasher;
use js_sys::Math;
use p2p_protocol::{
    CURRENT_PROTOCOL, ControlMessage, FileManifest, MAX_FILES_PER_MANIFEST, MAX_TRANSFER_BYTES,
    Validate,
};

use super::super::super::{
    BrowserPlatformError, TransferFile,
    manifest::{TransferPlanError, format_binary_id, plan_transfer},
};
use super::super::{BrowserFile, Inner, OutgoingFileState, OutgoingState, protocol_error};
pub(super) fn active_transfer_id(inner: &Inner) -> Option<String> {
    inner
        .outgoing
        .as_ref()
        .map(|state| state.transfer_id.clone())
        .or_else(|| {
            inner
                .pending_outgoing_recovery
                .as_ref()
                .map(|state| state.transfer_id.clone())
        })
        .or_else(|| {
            inner
                .receive
                .as_ref()
                .map(|state| state.offer.transfer_id.clone())
        })
        .or_else(|| {
            inner
                .incoming
                .as_ref()
                .map(|state| state.transfer_id.clone())
        })
        .or_else(|| {
            inner
                .pending_recovery
                .as_ref()
                .map(|state| state.transfer_id.clone())
        })
        .or_else(|| inner.restoring_transfer.clone())
}

pub(in crate::rtc::browser) fn random_binary_id(prefix: &str) -> (String, [u8; 16]) {
    let mut bytes = [0_u8; 16];
    for byte in &mut bytes {
        *byte = (Math::random() * 256.0) as u8;
    }
    (format_binary_id(prefix, &bytes), bytes)
}

pub(in crate::rtc::browser) fn prepare_outgoing(
    files: Vec<BrowserFile>,
    recovery_peer_id: Option<String>,
) -> Result<(OutgoingState, ControlMessage, Vec<TransferFile>), BrowserPlatformError> {
    let metadata = files.iter().map(BrowserFile::metadata).collect::<Vec<_>>();
    let plan = plan_transfer(&metadata).map_err(|error| {
        let message = match error {
            TransferPlanError::InvalidFileCount => {
                format!("select between 1 and {MAX_FILES_PER_MANIFEST} files")
            }
            TransferPlanError::SizeOverflow => "transfer size overflow".to_owned(),
            TransferPlanError::TransferTooLarge => {
                format!("files exceed the {MAX_TRANSFER_BYTES} byte transfer limit")
            }
        };
        BrowserPlatformError::Browser(message)
    })?;
    let total_bytes = plan.total_bytes;
    let mode = plan.mode;
    let (transfer_id, transfer_bytes) = random_binary_id("transfer");
    let outgoing_files = files
        .into_iter()
        .zip(metadata.iter().cloned())
        .map(|(file, metadata)| {
            let (file_id, file_bytes) = random_binary_id("file");
            let last_modified_ms = file.last_modified_ms();
            (
                FileManifest {
                    file_id,
                    name: metadata.name.clone(),
                    mime: metadata.mime.clone(),
                    size_bytes: metadata.size_bytes,
                },
                OutgoingFileState {
                    file_bytes,
                    file: metadata,
                    browser_file: file.inner,
                    source_handle: file.source_handle,
                    last_modified_ms,
                    expected_hash: None,
                    committed_bytes: 0,
                    committed_hasher: Box::new(Hasher::new()),
                    last_segment_blake3: None,
                },
            )
        })
        .collect::<Vec<_>>();
    let message = ControlMessage::Manifest {
        version: CURRENT_PROTOCOL,
        transfer_id: transfer_id.clone(),
        mode,
        files: outgoing_files
            .iter()
            .map(|(manifest, _)| manifest.clone())
            .collect(),
    };
    message.validate().map_err(protocol_error)?;
    let outgoing = OutgoingState {
        transfer_id,
        transfer_bytes,
        mode,
        files: outgoing_files.into_iter().map(|(_, state)| state).collect(),
        total_bytes,
        sent_bytes: 0,
        expected_digests: Vec::new(),
        accepted: false,
        stream_ready: None,
        pending_ack: None,
        generation: 0,
        sending: false,
        cancelled: false,
        last_progress_ms: 0.0,
        max_buffered_bytes: 0,
        recovery_peer_id,
        restored_from_disk: false,
        reconciling_resume: false,
    };
    Ok((outgoing, message, metadata))
}
