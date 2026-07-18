use p2p_protocol::{
    CURRENT_PROTOCOL, ControlMessage, FileManifest, MAX_FILES_PER_MANIFEST, MAX_TRANSFER_BYTES,
    ResumeCursor, TransferMode, Validate,
};
use wasm_bindgen_futures::spawn_local;

use super::super::super::{
    RtcEvent, TransferFile,
    checkpoint::{
        Checkpoint, CheckpointError, ManifestFile, PendingCheckpoint, ResumeDisposition,
        match_live_resume, resolve_manifest_resume, validate_checkpoint_prefix,
    },
    manifest::{format_binary_id, parse_binary_id, summarize_transfer_files},
    wire::send_control_on,
};
use super::super::{
    BrowserFile, OutgoingFileState, OutgoingState, RtcPeer, StreamReadyPlan, prepare_outgoing,
    protocol_error,
};
use crate::{
    BrowserPlatformError,
    source_storage::{SourceFilePermission, recover_source_file, source_file_permissions},
    stream_recovery::{
        OutgoingRecoveryFile, OutgoingRecoveryRecord, delete_outgoing_recovery,
        load_outgoing_recovery, save_outgoing_recovery,
    },
};

impl RtcPeer {
    pub async fn offer_persistent_files(
        &self,
        files: Vec<BrowserFile>,
    ) -> Result<String, BrowserPlatformError> {
        let peer_id = self.inner.borrow().target_peer.clone().ok_or_else(|| {
            BrowserPlatformError::Browser("receiver peer is unavailable".to_owned())
        })?;
        let mut prepared = prepare_outgoing(files, Some(peer_id.clone()))?;
        if matches!(prepared.0.mode, TransferMode::Buffered) {
            prepared.0.recovery_peer_id = None;
        } else {
            let recovery = outgoing_recovery_record(&prepared.0).ok_or_else(|| {
                BrowserPlatformError::Browser(
                    "selected files cannot be restored after a refresh".to_owned(),
                )
            })?;
            save_outgoing_recovery(&recovery).await?;
        }
        match self.install_and_offer_outgoing(prepared) {
            Ok(transfer_id) => Ok(transfer_id),
            Err(error) => {
                let _ = delete_outgoing_recovery(&peer_id).await;
                Err(error)
            }
        }
    }

    pub async fn restore_outgoing_transfer(
        &self,
        peer_id: &str,
    ) -> Result<bool, BrowserPlatformError> {
        {
            let mut inner = self.inner.borrow_mut();
            if inner.outgoing.is_some()
                || inner.pending_outgoing_recovery.is_some()
                || inner.restoring_outgoing
            {
                return Ok(false);
            }
            inner.restoring_outgoing = true;
        }
        let recovery = match load_outgoing_recovery(peer_id).await {
            Ok(Some(recovery)) if recovery.peer_id == peer_id => recovery,
            Ok(Some(_)) => {
                let _ = delete_outgoing_recovery(peer_id).await;
                self.inner.borrow_mut().restoring_outgoing = false;
                return Ok(false);
            }
            Ok(None) => {
                self.inner.borrow_mut().restoring_outgoing = false;
                return Ok(false);
            }
            Err(error) => {
                self.inner.borrow_mut().restoring_outgoing = false;
                return Err(error);
            }
        };
        let handles = recovery
            .files
            .iter()
            .map(|file| file.handle.clone())
            .collect::<Vec<_>>();
        match source_file_permissions(&handles, false).await {
            Ok(permissions)
                if permissions
                    .iter()
                    .all(|permission| *permission == SourceFilePermission::Granted) =>
            {
                if let Err(error) = self.restore_outgoing_recovery(recovery.clone()).await {
                    let _ = delete_outgoing_recovery(peer_id).await;
                    self.inner.borrow_mut().restoring_outgoing = false;
                    return Err(error);
                }
            }
            Ok(permissions) if permissions.contains(&SourceFilePermission::Prompt) => {
                let files = recovery_transfer_files(&recovery);
                let summary = summarize_transfer_files(&files);
                {
                    let mut inner = self.inner.borrow_mut();
                    inner.restoring_outgoing = false;
                    inner.pending_outgoing_recovery = Some(recovery.clone());
                }
                self.emit(RtcEvent::OutgoingRecoveryOffered {
                    transfer_id: recovery.transfer_id,
                    file: summary,
                    files,
                });
            }
            Ok(_) | Err(_) => {
                let _ = delete_outgoing_recovery(peer_id).await;
                self.inner.borrow_mut().restoring_outgoing = false;
                return Ok(false);
            }
        }
        Ok(true)
    }

    pub async fn resume_outgoing_transfer(&self) -> Result<(), BrowserPlatformError> {
        let recovery = {
            let mut inner = self.inner.borrow_mut();
            if inner.restoring_outgoing {
                return Err(BrowserPlatformError::Browser(
                    "source file recovery is already running".to_owned(),
                ));
            }
            let recovery = inner.pending_outgoing_recovery.take().ok_or_else(|| {
                BrowserPlatformError::Browser(
                    "saved source files are no longer available".to_owned(),
                )
            })?;
            inner.restoring_outgoing = true;
            recovery
        };
        let handles = recovery
            .files
            .iter()
            .map(|file| file.handle.clone())
            .collect::<Vec<_>>();
        let permissions = source_file_permissions(&handles, true).await;
        if !matches!(
            permissions.as_deref(),
            Ok(values) if values.iter().all(|value| *value == SourceFilePermission::Granted)
        ) {
            let mut inner = self.inner.borrow_mut();
            inner.restoring_outgoing = false;
            inner.pending_outgoing_recovery = Some(recovery);
            return match permissions {
                Ok(_) => Err(BrowserPlatformError::Browser(
                    "未获得原文件的读取权限".to_owned(),
                )),
                Err(error) => Err(error),
            };
        }
        if let Err(error) = self.restore_outgoing_recovery(recovery.clone()).await {
            let mut inner = self.inner.borrow_mut();
            inner.restoring_outgoing = false;
            inner.pending_outgoing_recovery = Some(recovery);
            return Err(error);
        }
        Ok(())
    }

    pub(in crate::rtc::browser) fn handle_segment_ack(
        &self,
        transfer_id: String,
        file_id: String,
        segment_index: u64,
        committed_bytes: u64,
        blake3: String,
    ) {
        let acknowledgement = (|| -> Result<_, String> {
            let mut inner = self.inner.borrow_mut();
            let outgoing = inner
                .outgoing
                .as_mut()
                .ok_or_else(|| "segment acknowledgement has no outgoing transfer".to_owned())?;
            if outgoing.transfer_id != transfer_id {
                return Err("segment acknowledgement id does not match".to_owned());
            }
            let Some(mut pending) = outgoing.pending_ack.take() else {
                return Err("segment acknowledgement was not expected".to_owned());
            };
            let file_matches = outgoing
                .files
                .get(pending.file_index)
                .is_some_and(|file| parse_binary_id(&file_id, "file") == Some(file.file_bytes));
            let result = if file_matches
                && pending.segment_index == segment_index
                && pending.committed_bytes == committed_bytes
                && pending.blake3 == blake3
            {
                let file = &mut outgoing.files[pending.file_index];
                file.committed_bytes = pending.committed_bytes;
                file.committed_hasher = pending.file_hasher;
                file.last_segment_blake3 = Some(pending.blake3);
                Ok(())
            } else {
                Err("segment acknowledgement does not match".to_owned())
            };
            let recovery = result
                .is_ok()
                .then(|| outgoing_recovery_record(outgoing))
                .flatten();
            Ok((pending.sender.take(), result, recovery))
        })();
        let (sender, result, recovery) = match acknowledgement {
            Ok(acknowledgement) => acknowledgement,
            Err(message) => {
                self.fail(Some(transfer_id), message);
                return;
            }
        };
        if let Some(recovery) = recovery {
            spawn_local(async move {
                let result = match save_outgoing_recovery(&recovery).await {
                    Ok(()) => result,
                    Err(error) => Err(format!(
                        "failed to save the outgoing transfer checkpoint: {error}"
                    )),
                };
                if let Some(sender) = sender {
                    let _ = sender.send(result);
                }
            });
        } else if let Some(sender) = sender {
            let _ = sender.send(result);
        }
    }

    async fn reconcile_outgoing_resume(
        &self,
        transfer_id: String,
        max_chunk_bytes: u32,
        ack_window_bytes: u64,
        resume: Vec<ResumeCursor>,
    ) -> Result<(), BrowserPlatformError> {
        let mut recovery = {
            let inner = self.inner.borrow();
            let outgoing = inner.outgoing.as_ref().ok_or_else(|| {
                BrowserPlatformError::Browser("outgoing recovery disappeared".to_owned())
            })?;
            if outgoing.transfer_id != transfer_id
                || !outgoing.restored_from_disk
                || !outgoing.reconciling_resume
            {
                return Err(BrowserPlatformError::Browser(
                    "outgoing recovery is no longer active".to_owned(),
                ));
            }
            outgoing_recovery_record(outgoing).ok_or_else(|| {
                BrowserPlatformError::Browser("outgoing source handles are unavailable".to_owned())
            })?
        };
        apply_resume_to_recovery(&mut recovery, &resume)?;
        let mut recovered_files = Vec::with_capacity(recovery.files.len());
        for file in &recovery.files {
            let recovered = recover_source_file(
                file.handle.clone(),
                &file.name,
                file.mime.as_deref(),
                file.size_bytes,
                file.last_modified_ms,
                file.committed_bytes,
                recovery.segment_bytes,
            )
            .await?;
            if recovered.last_segment_blake3 != file.last_segment_blake3 {
                return Err(BrowserPlatformError::Browser(
                    "receiver checkpoint does not match the source file".to_owned(),
                ));
            }
            recovered_files.push(recovered);
        }
        save_outgoing_recovery(&recovery).await?;
        {
            let mut inner = self.inner.borrow_mut();
            let outgoing = inner.outgoing.as_mut().ok_or_else(|| {
                BrowserPlatformError::Browser("outgoing recovery disappeared".to_owned())
            })?;
            if outgoing.transfer_id != transfer_id
                || !outgoing.restored_from_disk
                || !outgoing.reconciling_resume
                || outgoing.files.len() != recovered_files.len()
            {
                return Err(BrowserPlatformError::Browser(
                    "outgoing recovery changed while validating files".to_owned(),
                ));
            }
            for ((state, saved), recovered) in outgoing
                .files
                .iter_mut()
                .zip(&recovery.files)
                .zip(recovered_files)
            {
                state.browser_file = recovered.file;
                state.committed_bytes = saved.committed_bytes;
                *state.committed_hasher = recovered.hasher;
                state.last_segment_blake3 = recovered.last_segment_blake3;
            }
            outgoing.sent_bytes = outgoing.files.iter().map(|file| file.committed_bytes).sum();
            outgoing.restored_from_disk = false;
            outgoing.reconciling_resume = false;
        }
        self.handle_stream_ready(transfer_id, max_chunk_bytes, ack_window_bytes, resume);
        Ok(())
    }

    pub(in crate::rtc::browser) fn handle_stream_ready(
        &self,
        transfer_id: String,
        max_chunk_bytes: u32,
        ack_window_bytes: u64,
        resume: Vec<ResumeCursor>,
    ) {
        let needs_reconciliation = {
            let mut inner = self.inner.borrow_mut();
            if let Some(outgoing) = inner.outgoing.as_mut() {
                if outgoing.transfer_id != transfer_id {
                    false
                } else if let TransferMode::Streamed { segment_bytes } = outgoing.mode
                    && ack_window_bytes >= u64::from(segment_bytes)
                    && outgoing.restored_from_disk
                {
                    if outgoing.reconciling_resume {
                        return;
                    }
                    if validate_resume_cursors(outgoing, segment_bytes, &resume).is_ok() {
                        outgoing.restored_from_disk = false;
                        false
                    } else {
                        outgoing.reconciling_resume = true;
                        true
                    }
                } else {
                    false
                }
            } else {
                false
            }
        };
        if needs_reconciliation {
            let peer = self.clone();
            spawn_local(async move {
                if let Err(error) = peer
                    .reconcile_outgoing_resume(
                        transfer_id.clone(),
                        max_chunk_bytes,
                        ack_window_bytes,
                        resume,
                    )
                    .await
                {
                    peer.send_transfer_error(
                        &transfer_id,
                        "resume_mismatch",
                        "streaming resume cursor does not match the source files",
                    );
                    peer.clear_transfer(&transfer_id);
                    peer.fail(Some(transfer_id), error.to_string());
                }
            });
            return;
        }
        let start_generation = {
            let mut inner = self.inner.borrow_mut();
            let Some(outgoing) = inner.outgoing.as_mut() else {
                drop(inner);
                self.fail(
                    Some(transfer_id),
                    "stream readiness has no outgoing transfer".to_owned(),
                );
                return;
            };
            let TransferMode::Streamed { segment_bytes } = outgoing.mode else {
                drop(inner);
                self.fail(
                    Some(transfer_id),
                    "stream readiness was sent for a buffered transfer".to_owned(),
                );
                return;
            };
            if outgoing.transfer_id != transfer_id || ack_window_bytes < u64::from(segment_bytes) {
                drop(inner);
                self.fail(
                    Some(transfer_id),
                    "stream readiness does not match the transfer".to_owned(),
                );
                return;
            }
            let cursor_result = validate_resume_cursors(outgoing, segment_bytes, &resume);
            let Ok(promote_pending) = cursor_result else {
                drop(inner);
                self.send_transfer_error(
                    &transfer_id,
                    "resume_mismatch",
                    "streaming resume cursor is not a verified batch checkpoint",
                );
                return;
            };
            if promote_pending {
                let mut pending = outgoing
                    .pending_ack
                    .take()
                    .expect("the pending checkpoint was validated");
                pending.sender.take();
                let file = &mut outgoing.files[pending.file_index];
                file.committed_bytes = pending.committed_bytes;
                file.committed_hasher = pending.file_hasher;
                file.last_segment_blake3 = Some(pending.blake3);
            } else if let Some(mut pending) = outgoing.pending_ack.take() {
                pending.sender.take();
            }
            outgoing.sent_bytes = outgoing.files.iter().map(|file| file.committed_bytes).sum();
            outgoing.stream_ready = Some(StreamReadyPlan {
                max_chunk_bytes,
                ack_window_bytes,
            });
            let should_start = outgoing.accepted && !outgoing.sending;
            if should_start {
                outgoing.sending = true;
            }
            should_start.then_some(outgoing.generation)
        };
        if let Some(generation) = start_generation {
            self.spawn_outgoing(transfer_id, generation);
        }
    }

    pub(in crate::rtc::browser) fn data_channel_opened(&self) {
        self.emit(RtcEvent::DataChannelReady);
        let manifest = {
            let inner = self.inner.borrow();
            inner.outgoing.as_ref().and_then(|outgoing| {
                (matches!(outgoing.mode, TransferMode::Streamed { .. })
                    && !outgoing.accepted
                    && !outgoing.sending)
                    .then(|| ControlMessage::Manifest {
                        version: CURRENT_PROTOCOL,
                        transfer_id: outgoing.transfer_id.clone(),
                        mode: outgoing.mode,
                        files: outgoing
                            .files
                            .iter()
                            .map(|file| FileManifest {
                                file_id: format_binary_id("file", &file.file_bytes),
                                name: file.file.name.clone(),
                                mime: file.file.mime.clone(),
                                size_bytes: file.file.size_bytes,
                            })
                            .collect(),
                    })
            })
        };
        if let Some(manifest) = manifest {
            let result = self
                .current_data_channel()
                .and_then(|channel| send_control_on(&channel, &manifest));
            if let Err(error) = result {
                self.fail(None, error.to_string());
            }
        }
    }

    async fn restore_outgoing_recovery(
        &self,
        recovery: OutgoingRecoveryRecord,
    ) -> Result<(), BrowserPlatformError> {
        let transfer_bytes =
            parse_binary_id(&recovery.transfer_id, "transfer").ok_or_else(|| {
                BrowserPlatformError::Browser("saved outgoing transfer id is invalid".to_owned())
            })?;
        if recovery.segment_bytes == 0
            || recovery.files.is_empty()
            || recovery.files.len() > MAX_FILES_PER_MANIFEST
        {
            return Err(BrowserPlatformError::Browser(
                "saved outgoing manifest is invalid".to_owned(),
            ));
        }
        let checkpoints = recovery
            .files
            .iter()
            .map(|file| Checkpoint {
                file_id: &file.file_id,
                size_bytes: file.size_bytes,
                committed_bytes: file.committed_bytes,
                last_segment_blake3: file.last_segment_blake3.as_deref(),
            })
            .collect::<Vec<_>>();
        validate_checkpoint_prefix(recovery.segment_bytes, &checkpoints).map_err(|_| {
            BrowserPlatformError::Browser("saved outgoing checkpoint is invalid".to_owned())
        })?;
        let mut total_bytes = 0_u64;
        let mut files = Vec::with_capacity(recovery.files.len());
        for saved in &recovery.files {
            let file_bytes = parse_binary_id(&saved.file_id, "file").ok_or_else(|| {
                BrowserPlatformError::Browser("saved outgoing file id is invalid".to_owned())
            })?;
            let recovered = recover_source_file(
                saved.handle.clone(),
                &saved.name,
                saved.mime.as_deref(),
                saved.size_bytes,
                saved.last_modified_ms,
                saved.committed_bytes,
                recovery.segment_bytes,
            )
            .await?;
            if recovered.last_segment_blake3 != saved.last_segment_blake3 {
                return Err(BrowserPlatformError::Browser(
                    "source file no longer matches the saved checkpoint".to_owned(),
                ));
            }
            total_bytes = total_bytes.checked_add(saved.size_bytes).ok_or_else(|| {
                BrowserPlatformError::Browser("saved transfer size overflow".to_owned())
            })?;
            files.push(OutgoingFileState {
                file_bytes,
                file: TransferFile {
                    name: saved.name.clone(),
                    mime: saved.mime.clone(),
                    size_bytes: saved.size_bytes,
                },
                browser_file: recovered.file,
                source_handle: Some(saved.handle.clone()),
                last_modified_ms: saved.last_modified_ms,
                expected_hash: None,
                committed_bytes: saved.committed_bytes,
                committed_hasher: Box::new(recovered.hasher),
                last_segment_blake3: recovered.last_segment_blake3,
            });
        }
        if total_bytes > MAX_TRANSFER_BYTES {
            return Err(BrowserPlatformError::Browser(
                "saved transfer exceeds the transfer limit".to_owned(),
            ));
        }
        let metadata = files
            .iter()
            .map(|file| file.file.clone())
            .collect::<Vec<_>>();
        let outgoing = OutgoingState {
            transfer_id: recovery.transfer_id.clone(),
            transfer_bytes,
            mode: TransferMode::Streamed {
                segment_bytes: recovery.segment_bytes,
            },
            sent_bytes: files.iter().map(|file| file.committed_bytes).sum(),
            files,
            total_bytes,
            expected_digests: Vec::new(),
            accepted: false,
            stream_ready: None,
            pending_ack: None,
            generation: 0,
            sending: false,
            cancelled: false,
            last_progress_ms: 0.0,
            max_buffered_bytes: 0,
            recovery_peer_id: Some(recovery.peer_id),
            restored_from_disk: true,
            reconciling_resume: false,
        };
        manifest_from_outgoing(&outgoing)
            .validate()
            .map_err(protocol_error)?;
        {
            let mut inner = self.inner.borrow_mut();
            if inner.outgoing.is_some() || inner.incoming.is_some() || inner.receive.is_some() {
                return Err(BrowserPlatformError::Browser(
                    "another transfer is already active".to_owned(),
                ));
            }
            inner.restoring_outgoing = false;
            inner.pending_outgoing_recovery = None;
            inner.outgoing = Some(outgoing);
        }
        self.emit(RtcEvent::OutgoingOffered {
            transfer_id: recovery.transfer_id,
            file: summarize_transfer_files(&metadata),
            files: metadata,
        });
        if self.data_channel_ready() {
            self.data_channel_opened();
        }
        Ok(())
    }
}

fn validate_resume_cursors(
    outgoing: &OutgoingState,
    segment_bytes: u32,
    resume: &[ResumeCursor],
) -> Result<bool, ()> {
    let file_ids = outgoing
        .files
        .iter()
        .map(|file| format_binary_id("file", &file.file_bytes))
        .collect::<Vec<_>>();
    let current = outgoing
        .files
        .iter()
        .zip(&file_ids)
        .map(|(file, file_id)| Checkpoint {
            file_id,
            size_bytes: file.file.size_bytes,
            committed_bytes: file.committed_bytes,
            last_segment_blake3: file.last_segment_blake3.as_deref(),
        })
        .collect::<Vec<_>>();
    let pending = outgoing
        .pending_ack
        .as_ref()
        .map(|pending| PendingCheckpoint {
            file_index: pending.file_index,
            committed_bytes: pending.committed_bytes,
            blake3: &pending.blake3,
        });
    match_live_resume(segment_bytes, &current, pending, resume)
        .map(|disposition| matches!(disposition, ResumeDisposition::PromotePending { .. }))
        .map_err(|_| ())
}

fn apply_resume_to_recovery(
    recovery: &mut OutgoingRecoveryRecord,
    resume: &[ResumeCursor],
) -> Result<(), BrowserPlatformError> {
    let manifest = recovery
        .files
        .iter()
        .map(|file| ManifestFile {
            file_id: &file.file_id,
            size_bytes: file.size_bytes,
        })
        .collect::<Vec<_>>();
    let resolved =
        resolve_manifest_resume(recovery.segment_bytes, &manifest, resume).map_err(|error| {
            let message = match error {
                CheckpointError::FileCountMismatch => {
                    "receiver checkpoint file count does not match"
                }
                CheckpointError::FileOrderMismatch => {
                    "receiver checkpoint file order does not match"
                }
                CheckpointError::ZeroSegmentBytes
                | CheckpointError::InvalidCheckpoint
                | CheckpointError::StateMismatch => {
                    "receiver checkpoint is not a verified segment boundary"
                }
            };
            BrowserPlatformError::Browser(message.to_owned())
        })?;
    for (file, checkpoint) in recovery.files.iter_mut().zip(resolved) {
        file.committed_bytes = checkpoint.committed_bytes;
        file.last_segment_blake3 = checkpoint.last_segment_blake3;
    }
    Ok(())
}

fn recovery_transfer_files(recovery: &OutgoingRecoveryRecord) -> Vec<TransferFile> {
    recovery
        .files
        .iter()
        .map(|file| TransferFile {
            name: file.name.clone(),
            mime: file.mime.clone(),
            size_bytes: file.size_bytes,
        })
        .collect()
}

fn outgoing_recovery_record(outgoing: &OutgoingState) -> Option<OutgoingRecoveryRecord> {
    let TransferMode::Streamed { segment_bytes } = outgoing.mode else {
        return None;
    };
    let peer_id = outgoing.recovery_peer_id.clone()?;
    let files = outgoing
        .files
        .iter()
        .map(|file| {
            Some(OutgoingRecoveryFile {
                file_id: format_binary_id("file", &file.file_bytes),
                name: file.file.name.clone(),
                mime: file.file.mime.clone(),
                size_bytes: file.file.size_bytes,
                last_modified_ms: file.last_modified_ms,
                handle: file.source_handle.clone()?,
                committed_bytes: file.committed_bytes,
                last_segment_blake3: file.last_segment_blake3.clone(),
            })
        })
        .collect::<Option<Vec<_>>>()?;
    Some(OutgoingRecoveryRecord {
        transfer_id: outgoing.transfer_id.clone(),
        peer_id,
        segment_bytes,
        files,
    })
}

fn manifest_from_outgoing(outgoing: &OutgoingState) -> ControlMessage {
    ControlMessage::Manifest {
        version: CURRENT_PROTOCOL,
        transfer_id: outgoing.transfer_id.clone(),
        mode: outgoing.mode,
        files: outgoing
            .files
            .iter()
            .map(|file| FileManifest {
                file_id: format_binary_id("file", &file.file_bytes),
                name: file.file.name.clone(),
                mime: file.file.mime.clone(),
                size_bytes: file.file.size_bytes,
            })
            .collect(),
    }
}
