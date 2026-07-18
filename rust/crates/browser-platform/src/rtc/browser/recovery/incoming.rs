use blake3::Hasher;
use p2p_protocol::{CURRENT_PROTOCOL, ControlMessage, FileManifest, ResumeCursor, TransferMode};
use p2p_transfer::{DEFAULT_STREAM_ACK_WINDOW_BYTES, DEFAULT_STREAM_CHUNK_BYTES};
use wasm_bindgen_futures::spawn_local;

use super::super::super::{
    RtcEvent, StreamingFileWriter,
    checkpoint::{Checkpoint, validate_checkpoint_prefix},
    manifest::{IncomingManifestError, IncomingOffer, format_binary_id, summarize_transfer_files},
    wire::send_control_on,
};
use super::super::{ReceiveFileState, ReceivePayload, ReceiveState, RtcPeer};
use crate::{
    BrowserPlatformError,
    stream_recovery::{
        StreamRecoveryFile, StreamRecoveryRecord, delete_stream_recovery, load_stream_recovery,
        save_stream_recovery,
    },
    stream_storage::{StreamFilePermission, reopen_stream_file, stream_file_permissions},
};

impl RtcPeer {
    pub(in crate::rtc::browser) fn send_stream_resume(
        &self,
        transfer_id: &str,
    ) -> Result<(), BrowserPlatformError> {
        let (segment_bytes, resume) = {
            let inner = self.inner.borrow();
            let receive = inner.receive.as_ref().ok_or_else(|| {
                BrowserPlatformError::Browser("streaming receiver is unavailable".to_owned())
            })?;
            if receive.offer.transfer_id != transfer_id {
                return Err(BrowserPlatformError::Browser(
                    "streaming receiver id does not match".to_owned(),
                ));
            }
            let ReceivePayload::Streamed {
                segment_bytes,
                files,
                ..
            } = &receive.payload
            else {
                return Err(BrowserPlatformError::Browser(
                    "streaming receiver mode does not match".to_owned(),
                ));
            };
            let resume = receive
                .offer
                .files
                .iter()
                .zip(files)
                .map(|(offer, state)| ResumeCursor {
                    file_id: format_binary_id("file", &offer.file_bytes),
                    committed_bytes: state.segment_offset,
                    last_segment_blake3: state.last_segment_blake3.clone(),
                })
                .collect();
            (*segment_bytes, resume)
        };
        let channel = self.current_data_channel()?;
        send_control_on(
            &channel,
            &ControlMessage::Decision {
                version: CURRENT_PROTOCOL,
                transfer_id: transfer_id.to_owned(),
                accepted: true,
            },
        )?;
        send_control_on(
            &channel,
            &ControlMessage::StreamReady {
                version: CURRENT_PROTOCOL,
                transfer_id: transfer_id.to_owned(),
                max_chunk_bytes: DEFAULT_STREAM_CHUNK_BYTES as u32,
                ack_window_bytes: DEFAULT_STREAM_ACK_WINDOW_BYTES.min(u64::from(segment_bytes)),
                resume,
            },
        )
    }

    async fn restore_stream_recovery(
        &self,
        offer: IncomingOffer,
        recovery: StreamRecoveryRecord,
    ) -> Result<(), BrowserPlatformError> {
        let TransferMode::Streamed { segment_bytes } = offer.mode else {
            return Err(BrowserPlatformError::Browser(
                "saved recovery does not use streaming mode".to_owned(),
            ));
        };
        let mut files = Vec::with_capacity(recovery.files.len());
        for (offer_file, recovery_file) in offer.files.iter().zip(&recovery.files) {
            let committed_bytes = recovery_file.committed_bytes;
            if committed_bytes > offer_file.file.size_bytes
                || (committed_bytes < offer_file.file.size_bytes
                    && committed_bytes % u64::from(segment_bytes) != 0)
            {
                return Err(BrowserPlatformError::Browser(
                    "saved recovery checkpoint is outside a verified segment".to_owned(),
                ));
            }
            let recovered = reopen_stream_file(
                recovery_file.handle.clone(),
                committed_bytes,
                offer_file.file.size_bytes,
                segment_bytes,
            )
            .await?;
            if recovered.last_segment_blake3 != recovery_file.last_segment_blake3 {
                return Err(BrowserPlatformError::Browser(
                    "saved file no longer matches the recovery checkpoint".to_owned(),
                ));
            }
            let segment_index = if committed_bytes == 0 {
                0
            } else {
                committed_bytes.div_ceil(u64::from(segment_bytes))
            };
            files.push(ReceiveFileState {
                writer: Some(recovered.writer),
                active_abort: None,
                received_bytes: committed_bytes,
                hasher: Box::new(recovered.hasher.clone()),
                segment_index,
                segment_offset: committed_bytes,
                chunks: Vec::new(),
                segment_hasher: Box::new(Hasher::new()),
                committed_hasher: Box::new(recovered.hasher),
                last_segment_blake3: recovered.last_segment_blake3,
                writing: false,
            });
        }
        if files.len() != offer.files.len() {
            return Err(BrowserPlatformError::Browser(
                "saved recovery file count does not match".to_owned(),
            ));
        }
        let received_bytes = files.iter().map(|file| file.received_bytes).sum();
        let current_file_index = offer
            .files
            .iter()
            .zip(&files)
            .position(|(offer, state)| state.segment_offset < offer.file.size_bytes)
            .unwrap_or(offer.files.len());
        {
            let mut inner = self.inner.borrow_mut();
            if inner.restoring_transfer.as_deref() != Some(offer.transfer_id.as_str())
                || inner.outgoing.is_some()
                || inner.receive.is_some()
            {
                return Err(BrowserPlatformError::Browser(
                    "streaming recovery is no longer active".to_owned(),
                ));
            }
            inner.restoring_transfer = None;
            inner.incoming = None;
            inner.pending_recovery = None;
            inner.paused_receive_reason = None;
            inner.receive = Some(ReceiveState {
                offer: offer.clone(),
                started: false,
                received_bytes,
                payload: ReceivePayload::Streamed {
                    segment_bytes,
                    current_file_index,
                    files,
                },
                hasher: Hasher::new(),
                resume_requested: false,
                last_progress_ms: 0.0,
                recovery_persisted: true,
                generation: 0,
            });
        }
        if let Err(error) = self.send_stream_resume(&offer.transfer_id) {
            let mut inner = self.inner.borrow_mut();
            if inner
                .receive
                .as_ref()
                .is_some_and(|receive| receive.offer.transfer_id == offer.transfer_id)
            {
                inner.receive = None;
                inner.restoring_transfer = Some(offer.transfer_id.clone());
            }
            return Err(error);
        }
        Ok(())
    }

    fn publish_incoming_offer(&self, offer: IncomingOffer, recovery: Option<StreamRecoveryRecord>) {
        let recovery_available = recovery.is_some();
        {
            let mut inner = self.inner.borrow_mut();
            if inner.restoring_transfer.as_deref() != Some(offer.transfer_id.as_str())
                || inner.outgoing.is_some()
                || inner.incoming.is_some()
                || inner.receive.is_some()
            {
                return;
            }
            inner.restoring_transfer = None;
            inner.pending_recovery = recovery;
            inner.paused_receive_reason = None;
            inner.incoming = Some(offer.clone());
        }
        let files = offer.transfer_files();
        self.emit(RtcEvent::IncomingOffered {
            transfer_id: offer.transfer_id,
            mode: offer.mode,
            file: summarize_transfer_files(&files),
            files,
            recovery_available,
        });
    }

    async fn recover_or_offer_stream(&self, offer: IncomingOffer) {
        if !matches!(offer.mode, TransferMode::Streamed { .. }) {
            self.publish_incoming_offer(offer, None);
            return;
        }
        let peer_id = self.inner.borrow().target_peer.clone();
        let recovery = match load_stream_recovery(&offer.transfer_id).await {
            Ok(Some(recovery))
                if peer_id
                    .as_deref()
                    .is_some_and(|peer_id| stream_recovery_matches(&offer, peer_id, &recovery)) =>
            {
                Some(recovery)
            }
            Ok(Some(_)) | Err(_) => {
                let _ = delete_stream_recovery(&offer.transfer_id).await;
                None
            }
            Ok(None) => None,
        };
        let Some(recovery) = recovery else {
            self.publish_incoming_offer(offer, None);
            return;
        };
        let handles = recovery
            .files
            .iter()
            .map(|file| file.handle.clone())
            .collect::<Vec<_>>();
        match stream_file_permissions(&handles, false).await {
            Ok(permissions)
                if permissions
                    .iter()
                    .all(|permission| *permission == StreamFilePermission::Granted) =>
            {
                if self
                    .restore_stream_recovery(offer.clone(), recovery)
                    .await
                    .is_err()
                {
                    let _ = delete_stream_recovery(&offer.transfer_id).await;
                    self.publish_incoming_offer(offer, None);
                }
            }
            Ok(permissions) if permissions.contains(&StreamFilePermission::Prompt) => {
                self.publish_incoming_offer(offer, Some(recovery));
            }
            Ok(_) | Err(_) => {
                let _ = delete_stream_recovery(&offer.transfer_id).await;
                self.publish_incoming_offer(offer, None);
            }
        }
    }

    pub(in crate::rtc::browser) fn handle_manifest(
        &self,
        transfer_id: String,
        mode: TransferMode,
        files: Vec<FileManifest>,
    ) {
        let offer = match IncomingOffer::from_manifest(transfer_id.clone(), mode, files) {
            Ok(offer) => offer,
            Err(IncomingManifestError::InvalidTransferId) => {
                self.send_transfer_error(&transfer_id, "invalid_id", "invalid transfer id");
                return;
            }
            Err(IncomingManifestError::InvalidFileId) => {
                self.send_transfer_error(&transfer_id, "invalid_id", "invalid file id");
                return;
            }
            Err(IncomingManifestError::BufferedBatchUnsupported) => {
                self.send_transfer_error(
                    &transfer_id,
                    "buffered_batch_unsupported",
                    "batch manifests must use streaming mode",
                );
                return;
            }
        };
        let mut resume_now = false;
        let mut resume_after_write = false;
        let mut busy = false;
        let mut invalid_resume = false;
        let mut restore_new = false;
        let mut paused_reason = None;
        {
            let mut inner = self.inner.borrow_mut();
            if let Some(receive) = inner.receive.as_mut() {
                let matches_existing = receive.offer.matches(&offer)
                    && matches!(receive.offer.mode, TransferMode::Streamed { .. });
                if !matches_existing {
                    invalid_resume = true;
                } else if let ReceivePayload::Streamed { files, .. } = &receive.payload {
                    receive.started = false;
                    if files.iter().any(|file| file.writing) {
                        receive.resume_requested = true;
                        resume_after_write = true;
                    } else {
                        resume_now = true;
                    }
                }
            } else if let Some(existing) = inner.incoming.as_ref()
                && inner.pending_recovery.is_some()
                && let Some(reason) = inner.paused_receive_reason
            {
                if existing.matches(&offer) {
                    paused_reason = Some(reason);
                } else {
                    invalid_resume = true;
                }
            } else if inner.outgoing.is_some()
                || inner.incoming.is_some()
                || inner.restoring_transfer.is_some()
            {
                busy = true;
            } else {
                inner.restoring_transfer = Some(transfer_id.clone());
                restore_new = true;
            }
        }
        if invalid_resume {
            self.send_transfer_error(
                &transfer_id,
                "resume_mismatch",
                "streaming resume manifest does not match the active transfer",
            );
        } else if busy {
            self.send_transfer_error(&transfer_id, "busy", "another transfer is active");
        } else if let Some(reason) = paused_reason {
            if let Ok(channel) = self.current_data_channel() {
                let _ = send_control_on(
                    &channel,
                    &ControlMessage::StreamPaused {
                        version: CURRENT_PROTOCOL,
                        transfer_id,
                        reason,
                    },
                );
            }
        } else if resume_now {
            if let Err(error) = self.send_stream_resume(&transfer_id) {
                self.fail(Some(transfer_id), error.to_string());
            }
        } else if resume_after_write {
            // The writer task will answer once its current verified segment reaches disk.
        } else if restore_new {
            let peer = self.clone();
            spawn_local(async move {
                peer.recover_or_offer_stream(offer).await;
            });
        }
    }

    pub async fn accept_stream_transfer(
        &self,
        transfer_id: &str,
        writers: Vec<StreamingFileWriter>,
    ) -> Result<(), BrowserPlatformError> {
        let channel = self.current_data_channel()?;
        let (offer, peer_id) = {
            let mut inner = self.inner.borrow_mut();
            let Some(offer) = inner.incoming.take() else {
                return Err(BrowserPlatformError::Browser(
                    "incoming transfer is no longer available".to_owned(),
                ));
            };
            if offer.transfer_id != transfer_id {
                inner.incoming = Some(offer);
                return Err(BrowserPlatformError::Browser(
                    "incoming transfer id does not match".to_owned(),
                ));
            }
            if !matches!(offer.mode, TransferMode::Streamed { .. }) {
                inner.incoming = Some(offer);
                return Err(BrowserPlatformError::Browser(
                    "incoming transfer does not use streaming mode".to_owned(),
                ));
            }
            let peer_id = inner.target_peer.clone().ok_or_else(|| {
                BrowserPlatformError::Browser("receiver peer is unavailable".to_owned())
            })?;
            inner.pending_recovery = None;
            inner.paused_receive_reason = None;
            (offer, peer_id)
        };
        if writers.len() != offer.files.len() {
            self.inner.borrow_mut().incoming = Some(offer);
            return Err(BrowserPlatformError::Browser(
                "streaming destination count does not match the manifest".to_owned(),
            ));
        }
        let TransferMode::Streamed { segment_bytes } = offer.mode else {
            unreachable!("streaming mode was checked");
        };
        let current_file_index = offer
            .files
            .iter()
            .position(|file| file.file.size_bytes > 0)
            .unwrap_or(offer.files.len());
        let recovery_record = recovery_record_from_writers(&offer, &peer_id, &writers);
        let recovery_persisted = save_stream_recovery(&recovery_record).await.is_ok();
        if !recovery_persisted {
            let _ = delete_stream_recovery(transfer_id).await;
        }
        send_control_on(
            &channel,
            &ControlMessage::Decision {
                version: CURRENT_PROTOCOL,
                transfer_id: transfer_id.to_owned(),
                accepted: true,
            },
        )?;
        send_control_on(
            &channel,
            &ControlMessage::StreamReady {
                version: CURRENT_PROTOCOL,
                transfer_id: transfer_id.to_owned(),
                max_chunk_bytes: DEFAULT_STREAM_CHUNK_BYTES as u32,
                ack_window_bytes: DEFAULT_STREAM_ACK_WINDOW_BYTES.min(u64::from(segment_bytes)),
                resume: Vec::<ResumeCursor>::new(),
            },
        )?;
        self.inner.borrow_mut().receive = Some(ReceiveState {
            offer,
            started: false,
            received_bytes: 0,
            payload: ReceivePayload::Streamed {
                segment_bytes,
                current_file_index,
                files: writers
                    .into_iter()
                    .map(|writer| ReceiveFileState {
                        writer: Some(writer),
                        active_abort: None,
                        received_bytes: 0,
                        hasher: Box::new(Hasher::new()),
                        segment_index: 0,
                        segment_offset: 0,
                        chunks: Vec::new(),
                        segment_hasher: Box::new(Hasher::new()),
                        committed_hasher: Box::new(Hasher::new()),
                        last_segment_blake3: None,
                        writing: false,
                    })
                    .collect(),
            },
            hasher: Hasher::new(),
            resume_requested: false,
            last_progress_ms: 0.0,
            recovery_persisted,
            generation: 0,
        });
        Ok(())
    }

    pub async fn resume_stream_transfer(
        &self,
        transfer_id: &str,
    ) -> Result<(), BrowserPlatformError> {
        let (offer, recovery) = {
            let mut inner = self.inner.borrow_mut();
            if inner.restoring_transfer.as_deref() == Some(transfer_id) {
                return Ok(());
            }
            let offer = inner.incoming.take().ok_or_else(|| {
                BrowserPlatformError::Browser(
                    "incoming recovery offer is no longer available".to_owned(),
                )
            })?;
            let recovery = inner.pending_recovery.take().ok_or_else(|| {
                inner.incoming = Some(offer.clone());
                BrowserPlatformError::Browser(
                    "saved streaming recovery is no longer available".to_owned(),
                )
            })?;
            if offer.transfer_id != transfer_id || recovery.transfer_id != transfer_id {
                inner.incoming = Some(offer);
                inner.pending_recovery = Some(recovery);
                return Err(BrowserPlatformError::Browser(
                    "streaming recovery id does not match".to_owned(),
                ));
            }
            inner.restoring_transfer = Some(transfer_id.to_owned());
            (offer, recovery)
        };
        let handles = recovery
            .files
            .iter()
            .map(|file| file.handle.clone())
            .collect::<Vec<_>>();
        let permissions = stream_file_permissions(&handles, true).await;
        if !matches!(
            permissions.as_deref(),
            Ok(values) if values.iter().all(|value| *value == StreamFilePermission::Granted)
        ) {
            let mut inner = self.inner.borrow_mut();
            inner.restoring_transfer = None;
            inner.incoming = Some(offer);
            inner.pending_recovery = Some(recovery);
            return match permissions {
                Ok(_) => Err(BrowserPlatformError::Browser(
                    "未获得原保存位置的写入权限".to_owned(),
                )),
                Err(error) => Err(error),
            };
        }
        if let Err(error) = self
            .restore_stream_recovery(offer.clone(), recovery.clone())
            .await
        {
            let mut inner = self.inner.borrow_mut();
            inner.restoring_transfer = None;
            inner.incoming = Some(offer);
            inner.pending_recovery = Some(recovery);
            return Err(error);
        }
        Ok(())
    }
}

pub(in crate::rtc::browser) fn prepare_receive_reconnect(receive: &mut ReceiveState) {
    receive.started = false;
    let ReceivePayload::Streamed {
        current_file_index,
        files,
        ..
    } = &mut receive.payload
    else {
        return;
    };
    for file in files.iter_mut().filter(|file| !file.writing) {
        file.received_bytes = file.segment_offset;
        *file.hasher = file.committed_hasher.as_ref().clone();
        file.chunks.clear();
        *file.segment_hasher = Hasher::new();
    }
    receive.received_bytes = files.iter().map(|file| file.received_bytes).sum();
    *current_file_index = files
        .iter()
        .position(|file| file.writing)
        .or_else(|| {
            files
                .iter()
                .zip(&receive.offer.files)
                .position(|(state, offer)| state.received_bytes < offer.file.size_bytes)
        })
        .unwrap_or(files.len());
}

pub(in crate::rtc::browser) fn stream_recovery_matches(
    offer: &IncomingOffer,
    peer_id: &str,
    recovery: &StreamRecoveryRecord,
) -> bool {
    let TransferMode::Streamed { segment_bytes } = offer.mode else {
        return false;
    };
    if recovery.transfer_id != offer.transfer_id
        || recovery.peer_id != peer_id
        || recovery.segment_bytes != segment_bytes
        || recovery.files.len() != offer.files.len()
    {
        return false;
    }
    for (offer, recovery) in offer.files.iter().zip(&recovery.files) {
        if recovery.file_id != format_binary_id("file", &offer.file_bytes)
            || recovery.name != offer.file.name
            || recovery.mime != offer.file.mime
            || recovery.size_bytes != offer.file.size_bytes
        {
            return false;
        }
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
    validate_checkpoint_prefix(segment_bytes, &checkpoints).is_ok()
}

fn recovery_record_from_writers(
    offer: &IncomingOffer,
    peer_id: &str,
    writers: &[StreamingFileWriter],
) -> StreamRecoveryRecord {
    let TransferMode::Streamed { segment_bytes } = offer.mode else {
        unreachable!("recovery records are only created for streaming transfers");
    };
    StreamRecoveryRecord {
        transfer_id: offer.transfer_id.clone(),
        peer_id: peer_id.to_owned(),
        segment_bytes,
        files: offer
            .files
            .iter()
            .zip(writers)
            .map(|(offer, writer)| StreamRecoveryFile {
                file_id: format_binary_id("file", &offer.file_bytes),
                name: offer.file.name.clone(),
                mime: offer.file.mime.clone(),
                size_bytes: offer.file.size_bytes,
                handle: writer.recovery_handle(),
                committed_bytes: 0,
                last_segment_blake3: None,
            })
            .collect(),
    }
}
