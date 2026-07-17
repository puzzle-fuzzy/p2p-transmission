use blake3::Hasher;
use js_sys::{Array, Date, Uint8Array};
use p2p_protocol::{CURRENT_PROTOCOL, ControlMessage, FileDigest, StreamPauseReason, TransferMode};
use wasm_bindgen::JsValue;
use wasm_bindgen_futures::spawn_local;
use web_sys::{Blob, BlobPropertyBag, Url};

use super::super::finalization::{
    CompletionAction, CompletionSignalOutcome, completion_action, recovery_cleanup_retry_delay_ms,
};
use super::recovery::stream_recovery_matches;
use super::{
    BrowserPlatformError, BrowserStorageErrorKind, ChunkBounds, PROGRESS_INTERVAL_MS,
    ReceivePayload, ReceiveState, RtcConnectionPhase, RtcEvent, RtcPeer, StreamRecoveryFile,
    StreamRecoveryRecord, StreamingFileWriter, TransferDirection, batch_blake3,
    decode_binary_chunk, delete_stream_recovery, format_binary_id, load_stream_recovery,
    parse_binary_id, reconnectable_channel_error, save_stream_recovery, send_control_on,
    summarize_transfer_files,
};

impl RtcPeer {
    pub(super) fn handle_binary(&self, frame: Vec<u8>) {
        let Ok(chunk) = decode_binary_chunk(&frame) else {
            self.fail(None, "invalid binary transfer frame".to_owned());
            return;
        };
        let header = chunk.header;
        let payload = chunk.payload;
        let progress = {
            let mut inner = self.inner.borrow_mut();
            let Some(receive) = inner.receive.as_mut() else {
                let paused = inner
                    .incoming
                    .as_ref()
                    .is_some_and(|offer| offer.transfer_bytes == header.transfer_id)
                    && inner.pending_recovery.is_some();
                drop(inner);
                if paused {
                    return;
                }
                self.fail(
                    None,
                    "binary frame arrived without an accepted transfer".to_owned(),
                );
                return;
            };
            let transfer_valid =
                receive.started && header.transfer_id == receive.offer.transfer_bytes;
            let payload_valid = if transfer_valid {
                match &mut receive.payload {
                    ReceivePayload::Buffered { chunks } => {
                        if let Some(offer_file) = receive.offer.files.first() {
                            let next = ChunkBounds::new(
                                receive.offer.transfer_bytes,
                                offer_file.file_bytes,
                                receive.received_bytes,
                                offer_file.file.size_bytes,
                            )
                            .next_offset(&header, payload.len());
                            if let Some(next) = next {
                                receive.hasher.update(payload);
                                receive.received_bytes = next;
                                chunks.push(payload.to_vec());
                                true
                            } else {
                                false
                            }
                        } else {
                            false
                        }
                    }
                    ReceivePayload::Streamed {
                        segment_bytes,
                        current_file_index,
                        files,
                    } => match receive
                        .offer
                        .files
                        .get(*current_file_index)
                        .zip(files.get_mut(*current_file_index))
                    {
                        Some((offer_file, file)) => {
                            let segment_end = file
                                .segment_offset
                                .saturating_add(u64::from(*segment_bytes))
                                .min(offer_file.file.size_bytes);
                            let next = (!file.writing)
                                .then(|| {
                                    ChunkBounds::new(
                                        receive.offer.transfer_bytes,
                                        offer_file.file_bytes,
                                        file.received_bytes,
                                        segment_end,
                                    )
                                    .next_offset(&header, payload.len())
                                })
                                .flatten();
                            if let Some(next) = next {
                                file.hasher.update(payload);
                                file.segment_hasher.update(payload);
                                file.received_bytes = next;
                                file.chunks.push(payload.to_vec());
                                receive.received_bytes += payload.len() as u64;
                                true
                            } else {
                                false
                            }
                        }
                        None => false,
                    },
                }
            } else {
                false
            };
            if !payload_valid {
                let transfer_id = receive.offer.transfer_id.clone();
                drop(inner);
                self.clear_transfer(&transfer_id);
                self.send_transfer_error(
                    &transfer_id,
                    "invalid_chunk",
                    "binary chunk order or bounds are invalid",
                );
                self.fail(Some(transfer_id), "文件分块顺序或长度无效".to_owned());
                return;
            }
            let total_bytes = receive.offer.total_bytes();
            let now = Date::now();
            if now - receive.last_progress_ms >= PROGRESS_INTERVAL_MS
                || receive.received_bytes == total_bytes
            {
                receive.last_progress_ms = now;
                Some((
                    receive.offer.transfer_id.clone(),
                    receive.received_bytes,
                    total_bytes,
                ))
            } else {
                None
            }
        };
        if let Some((transfer_id, completed_bytes, total_bytes)) = progress {
            self.emit(RtcEvent::TransferProgress {
                transfer_id,
                direction: TransferDirection::Receive,
                completed_bytes,
                total_bytes,
            });
        }
    }

    pub(super) fn handle_segment_commit(
        &self,
        transfer_id: String,
        file_id: String,
        segment_index: u64,
        offset: u64,
        bytes: u32,
        blake3: String,
    ) {
        let prepared = (|| -> Result<_, String> {
            let mut inner = self.inner.borrow_mut();
            let receive = inner
                .receive
                .as_mut()
                .ok_or_else(|| "segment commit has no active receiver".to_owned())?;
            if receive.offer.transfer_id != transfer_id {
                Err("segment commit id does not match".to_owned())
            } else {
                match &mut receive.payload {
                    ReceivePayload::Buffered { .. } => {
                        Err("segment commit was sent for a buffered transfer".to_owned())
                    }
                    ReceivePayload::Streamed {
                        segment_bytes,
                        current_file_index,
                        files,
                    } => {
                        let file_index = *current_file_index;
                        let offer_file = receive
                            .offer
                            .files
                            .get(file_index)
                            .ok_or_else(|| "segment commit file is unavailable".to_owned())?;
                        let file = files
                            .get_mut(file_index)
                            .ok_or_else(|| "segment receiver is unavailable".to_owned())?;
                        let expected_end = file
                            .segment_offset
                            .saturating_add(u64::from(*segment_bytes))
                            .min(offer_file.file.size_bytes);
                        let actual_hash = file.segment_hasher.finalize().to_hex().to_string();
                        if parse_binary_id(&file_id, "file") != Some(offer_file.file_bytes)
                            || file.writing
                            || file.segment_index != segment_index
                            || file.segment_offset != offset
                            || file.received_bytes != expected_end
                            || u64::from(bytes) != file.received_bytes - file.segment_offset
                            || actual_hash != blake3
                        {
                            Err("segment commit bounds or hash do not match".to_owned())
                        } else {
                            let writer = file
                                .writer
                                .take()
                                .ok_or_else(|| "streaming writer is unavailable".to_owned())?;
                            file.active_abort = writer.abort_handle();
                            let chunks = std::mem::take(&mut file.chunks);
                            *file.segment_hasher = Hasher::new();
                            file.writing = true;
                            Ok((
                                writer,
                                chunks,
                                expected_end,
                                file_index,
                                receive.recovery_persisted,
                                receive.generation,
                            ))
                        }
                    }
                }
            }
        })();
        let (mut writer, chunks, committed_bytes, file_index, recovery_persisted, generation) =
            match prepared {
                Ok(prepared) => prepared,
                Err(message) => {
                    self.clear_transfer(&transfer_id);
                    self.send_transfer_error(&transfer_id, "invalid_segment", &message);
                    self.fail(Some(transfer_id), "文件分段校验失败".to_owned());
                    return;
                }
            };
        let peer = self.clone();
        spawn_local(async move {
            let segment_len = chunks.iter().map(Vec::len).sum();
            let mut segment_data = Vec::with_capacity(segment_len);
            for chunk in chunks {
                segment_data.extend_from_slice(&chunk);
            }
            if let Err(error) = writer.write_at(offset, &segment_data).await {
                if !peer.receive_generation_matches(&transfer_id, generation) {
                    return;
                }
                if let Some(reason) = recoverable_stream_pause_reason(&error) {
                    peer.pause_stream_receive(transfer_id, writer, generation, reason)
                        .await;
                    return;
                }
                peer.clear_transfer(&transfer_id);
                peer.send_transfer_error(
                    &transfer_id,
                    "storage_write_failed",
                    "receiver could not write the streaming file",
                );
                peer.fail(Some(transfer_id), error.to_string());
                return;
            }
            if !peer.receive_generation_matches(&transfer_id, generation) {
                let _ = writer.abort().await;
                return;
            }
            if recovery_persisted && let Err(error) = writer.commit_checkpoint().await {
                if !peer.receive_generation_matches(&transfer_id, generation) {
                    return;
                }
                if let Some(reason) = recoverable_stream_pause_reason(&error) {
                    peer.pause_stream_receive(transfer_id, writer, generation, reason)
                        .await;
                    return;
                }
                peer.clear_transfer(&transfer_id);
                peer.send_transfer_error(
                    &transfer_id,
                    "storage_checkpoint_failed",
                    "receiver could not commit the streaming checkpoint",
                );
                peer.fail(Some(transfer_id), error.to_string());
                return;
            }
            if !peer.receive_generation_matches(&transfer_id, generation) {
                let _ = writer.abort().await;
                return;
            }
            if recovery_persisted && let Err(error) = writer.reopen_after_checkpoint().await {
                if !peer.receive_generation_matches(&transfer_id, generation) {
                    return;
                }
                if let Some(reason) = recoverable_stream_pause_reason(&error) {
                    peer.pause_stream_receive(transfer_id, writer, generation, reason)
                        .await;
                    return;
                }
                peer.clear_transfer(&transfer_id);
                peer.send_transfer_error(
                    &transfer_id,
                    "storage_reopen_failed",
                    "receiver could not reopen the streaming destination",
                );
                peer.fail(Some(transfer_id), error.to_string());
                return;
            }
            if !peer.receive_generation_matches(&transfer_id, generation) {
                let _ = writer.abort().await;
                return;
            }
            let restored = {
                let mut inner = peer.inner.borrow_mut();
                let peer_id = inner.target_peer.clone();
                let Some(receive) = inner.receive.as_mut() else {
                    return;
                };
                if receive.offer.transfer_id != transfer_id || receive.generation != generation {
                    None
                } else if let ReceivePayload::Streamed {
                    current_file_index,
                    files,
                    ..
                } = &mut receive.payload
                {
                    let Some(file) = files.get_mut(file_index) else {
                        return;
                    };
                    if file.segment_index != segment_index || !file.writing {
                        None
                    } else {
                        file.writer = Some(writer);
                        file.active_abort = None;
                        file.segment_index += 1;
                        file.segment_offset = committed_bytes;
                        *file.committed_hasher = file.hasher.as_ref().clone();
                        file.last_segment_blake3 = Some(blake3.clone());
                        file.writing = false;
                        if committed_bytes == receive.offer.files[file_index].file.size_bytes {
                            *current_file_index = receive
                                .offer
                                .files
                                .iter()
                                .enumerate()
                                .skip(file_index + 1)
                                .find_map(|(index, file)| {
                                    (file.file.size_bytes > 0).then_some(index)
                                })
                                .unwrap_or(receive.offer.files.len());
                        }
                        let resume = receive.resume_requested;
                        receive.resume_requested = false;
                        let recovery = receive
                            .recovery_persisted
                            .then(|| {
                                peer_id.as_deref().and_then(|peer_id| {
                                    recovery_record_from_receive(receive, peer_id)
                                })
                            })
                            .flatten();
                        Some((resume, recovery))
                    }
                } else {
                    None
                }
            };
            let Some((resume_requested, recovery)) = restored else {
                peer.clear_transfer(&transfer_id);
                peer.fail(
                    Some(transfer_id),
                    "streaming receiver state changed while writing".to_owned(),
                );
                return;
            };
            if let Some(recovery) = recovery
                && let Err(error) = save_stream_recovery(&recovery).await
            {
                if !peer.receive_generation_matches(&transfer_id, generation) {
                    return;
                }
                let _ = delete_stream_recovery(&transfer_id).await;
                peer.clear_transfer(&transfer_id);
                peer.send_transfer_error(
                    &transfer_id,
                    "recovery_checkpoint_failed",
                    "receiver could not persist the verified checkpoint",
                );
                peer.fail(Some(transfer_id), error.to_string());
                return;
            }
            if !peer.receive_generation_matches(&transfer_id, generation) {
                return;
            }
            if resume_requested {
                if let Err(error) = peer.send_stream_resume(&transfer_id) {
                    peer.fail(Some(transfer_id), error.to_string());
                }
                return;
            }
            let result = peer.current_data_channel().and_then(|channel| {
                send_control_on(
                    &channel,
                    &ControlMessage::SegmentAck {
                        version: CURRENT_PROTOCOL,
                        transfer_id: transfer_id.clone(),
                        file_id,
                        segment_index,
                        committed_bytes,
                        blake3,
                    },
                )
            });
            if let Err(error) = result {
                if reconnectable_channel_error(&error) {
                    peer.suspend_stream_for_reconnect();
                    peer.emit(RtcEvent::ConnectionState(RtcConnectionPhase::Closed));
                } else {
                    peer.fail(Some(transfer_id), error.to_string());
                }
            }
        });
    }

    async fn pause_stream_receive(
        &self,
        transfer_id: String,
        writer: StreamingFileWriter,
        generation: u64,
        reason: StreamPauseReason,
    ) {
        let _ = writer.abort().await;
        if !self.receive_generation_matches(&transfer_id, generation) {
            return;
        }
        let recovery = match load_stream_recovery(&transfer_id).await {
            Ok(Some(recovery)) => recovery,
            Ok(None) | Err(_) => {
                self.clear_transfer(&transfer_id);
                self.send_transfer_error(
                    &transfer_id,
                    "recovery_checkpoint_missing",
                    "receiver could not preserve the last durable checkpoint",
                );
                self.fail(Some(transfer_id), "无法保留已校验的磁盘检查点".to_owned());
                return;
            }
        };
        if !self.receive_generation_matches(&transfer_id, generation) {
            return;
        }
        let paused = {
            let mut inner = self.inner.borrow_mut();
            let peer_id = inner.target_peer.clone();
            let Some(receive) = inner.receive.take() else {
                return;
            };
            if receive.offer.transfer_id != transfer_id
                || receive.generation != generation
                || !peer_id.as_deref().is_some_and(|peer_id| {
                    stream_recovery_matches(&receive.offer, peer_id, &recovery)
                })
            {
                inner.receive = Some(receive);
                return;
            }
            let offer = receive.offer.clone();
            let total_bytes = offer.total_bytes();
            let completed_bytes = recovery.files.iter().map(|file| file.committed_bytes).sum();
            let idle_writers = match receive.payload {
                ReceivePayload::Streamed { files, .. } => files
                    .into_iter()
                    .filter_map(|file| file.writer)
                    .collect::<Vec<_>>(),
                ReceivePayload::Buffered { .. } => Vec::new(),
            };
            inner.incoming = Some(offer);
            inner.pending_recovery = Some(recovery);
            inner.paused_receive_reason = Some(reason);
            Some((completed_bytes, total_bytes, idle_writers))
        };
        let Some((completed_bytes, total_bytes, idle_writers)) = paused else {
            return;
        };
        for writer in idle_writers {
            let _ = writer.abort().await;
        }
        let still_paused = {
            let inner = self.inner.borrow();
            inner
                .incoming
                .as_ref()
                .is_some_and(|offer| offer.transfer_id == transfer_id)
                && inner
                    .pending_recovery
                    .as_ref()
                    .is_some_and(|recovery| recovery.transfer_id == transfer_id)
        };
        if !still_paused {
            return;
        }
        if let Ok(channel) = self.current_data_channel() {
            let _ = send_control_on(
                &channel,
                &ControlMessage::StreamPaused {
                    version: CURRENT_PROTOCOL,
                    transfer_id: transfer_id.clone(),
                    reason,
                },
            );
        }
        self.emit(RtcEvent::TransferPaused {
            transfer_id,
            direction: TransferDirection::Receive,
            reason,
            completed_bytes,
            total_bytes,
        });
    }

    pub(super) fn finish_stream_receive(
        &self,
        transfer_id: String,
        total_bytes: u64,
        files: Vec<FileDigest>,
    ) {
        let receive = self.inner.borrow_mut().receive.take();
        let Some(receive) = receive else {
            return;
        };
        let base_valid = receive.offer.transfer_id == transfer_id
            && matches!(receive.offer.mode, TransferMode::Streamed { .. })
            && files.len() == receive.offer.files.len()
            && total_bytes == receive.offer.total_bytes()
            && receive.received_bytes == total_bytes
            && !files.is_empty();
        let (writers, committed) = match receive.payload {
            ReceivePayload::Streamed {
                files: receive_files,
                ..
            } => {
                let committed = base_valid
                    && receive
                        .offer
                        .files
                        .iter()
                        .zip(&receive_files)
                        .zip(&files)
                        .all(|((offer, state), digest)| {
                            state.received_bytes == offer.file.size_bytes
                                && state.segment_offset == offer.file.size_bytes
                                && state.chunks.is_empty()
                                && !state.writing
                                && parse_binary_id(&digest.file_id, "file")
                                    == Some(offer.file_bytes)
                                && digest.size_bytes == offer.file.size_bytes
                                && digest.blake3 == state.hasher.finalize().to_hex().to_string()
                        });
                (
                    receive_files
                        .into_iter()
                        .filter_map(|file| file.writer)
                        .collect::<Vec<_>>(),
                    committed,
                )
            }
            ReceivePayload::Buffered { .. } => (Vec::new(), false),
        };
        if !committed || writers.len() != receive.offer.files.len() {
            self.send_transfer_error(
                &transfer_id,
                "integrity_mismatch",
                "streamed bytes failed integrity verification",
            );
            self.fail(Some(transfer_id), "文件完整性校验失败".to_owned());
            return;
        }
        let transfer_files = receive.offer.transfer_files();
        let summary = summarize_transfer_files(&transfer_files);
        let batch_hash = batch_blake3(&files);
        let peer = self.clone();
        spawn_local(async move {
            for writer in writers {
                if let Err(error) = writer.close().await {
                    peer.send_transfer_error(
                        &transfer_id,
                        "storage_close_failed",
                        "receiver could not finish the streaming files",
                    );
                    peer.fail(Some(transfer_id), error.to_string());
                    return;
                }
            }
            let completion_signal = peer.current_data_channel().and_then(|channel| {
                send_control_on(
                    &channel,
                    &ControlMessage::StreamComplete {
                        version: CURRENT_PROTOCOL,
                        transfer_id: transfer_id.clone(),
                        total_bytes,
                        files: files.clone(),
                    },
                )
            });
            let signal_outcome = match &completion_signal {
                Ok(()) => CompletionSignalOutcome::Enqueued,
                Err(error) if reconnectable_channel_error(error) => {
                    CompletionSignalOutcome::ReconnectableFailure
                }
                Err(_) => CompletionSignalOutcome::FatalFailure,
            };
            match completion_action(signal_outcome) {
                CompletionAction::AttemptRecoveryCleanupAndComplete => {}
                CompletionAction::PreserveRecoveryAndReconnect => {
                    peer.suspend_stream_for_reconnect();
                    peer.emit(RtcEvent::ConnectionState(RtcConnectionPhase::Closed));
                    return;
                }
                CompletionAction::PreserveRecoveryAndFail => {
                    if let Err(error) = completion_signal {
                        peer.fail(Some(transfer_id), error.to_string());
                    }
                    return;
                }
            }
            if let Err(error) = delete_stream_recovery_with_retry(&transfer_id).await {
                warn_recovery_cleanup_failure(&transfer_id, &error);
            }
            peer.emit(RtcEvent::TransferCompleted {
                transfer_id,
                direction: TransferDirection::Receive,
                file: summary,
                files: transfer_files,
                blake3: batch_hash,
                download_url: None,
            });
        });
    }

    pub(super) fn finish_receive(&self, transfer_id: String, bytes: u64, blake3: String) {
        let receive = {
            let mut inner = self.inner.borrow_mut();
            let Some(receive) = inner.receive.take() else {
                return;
            };
            receive
        };
        let actual_hash = receive.hasher.finalize().to_hex().to_string();
        let Some(offer_file) = receive.offer.files.first() else {
            self.fail(Some(transfer_id), "接收文件信息缺失".to_owned());
            return;
        };
        if receive.offer.transfer_id != transfer_id
            || receive.offer.mode != TransferMode::Buffered
            || receive.received_bytes != bytes
            || receive.offer.files.len() != 1
            || bytes != offer_file.file.size_bytes
            || actual_hash != blake3
        {
            self.send_transfer_error(
                &transfer_id,
                "integrity_mismatch",
                "received bytes failed integrity verification",
            );
            self.fail(Some(transfer_id), "文件完整性校验失败".to_owned());
            return;
        }
        let ReceivePayload::Buffered { chunks } = receive.payload else {
            self.fail(Some(transfer_id), "接收模式不匹配".to_owned());
            return;
        };

        let parts = Array::new();
        for chunk in &chunks {
            let array = Uint8Array::from(chunk.as_slice());
            parts.push(&array.buffer());
        }
        let options = BlobPropertyBag::new();
        options.set_type(
            receive.offer.files[0]
                .file
                .mime
                .as_deref()
                .unwrap_or("application/octet-stream"),
        );
        let Ok(blob) = Blob::new_with_u8_array_sequence_and_options(&parts, &options) else {
            self.fail(Some(transfer_id), "无法创建接收文件".to_owned());
            return;
        };
        let Ok(url) = Url::create_object_url_with_blob(&blob) else {
            self.fail(Some(transfer_id), "无法创建文件下载地址".to_owned());
            return;
        };
        {
            let mut inner = self.inner.borrow_mut();
            if let Some(previous) = inner.object_url.replace(url.clone()) {
                let _ = Url::revoke_object_url(&previous);
            }
        }
        if let Ok(channel) = self.current_data_channel() {
            let _ = send_control_on(
                &channel,
                &ControlMessage::Complete {
                    version: CURRENT_PROTOCOL,
                    transfer_id: transfer_id.clone(),
                    bytes,
                    blake3: blake3.clone(),
                },
            );
        }
        self.emit(RtcEvent::TransferCompleted {
            transfer_id,
            direction: TransferDirection::Receive,
            file: offer_file.file.clone(),
            files: vec![offer_file.file.clone()],
            blake3,
            download_url: Some(url),
        });
    }

    fn receive_generation_matches(&self, transfer_id: &str, generation: u64) -> bool {
        self.inner.borrow().receive.as_ref().is_some_and(|receive| {
            receive.offer.transfer_id == transfer_id && receive.generation == generation
        })
    }
}

async fn delete_stream_recovery_with_retry(transfer_id: &str) -> Result<(), BrowserPlatformError> {
    let mut failed_attempts = 0_u8;
    loop {
        match delete_stream_recovery(transfer_id).await {
            Ok(()) => return Ok(()),
            Err(error) => {
                failed_attempts = failed_attempts.saturating_add(1);
                let Some(delay_ms) = recovery_cleanup_retry_delay_ms(failed_attempts) else {
                    return Err(error);
                };
                gloo_timers::future::TimeoutFuture::new(delay_ms).await;
            }
        }
    }
}

fn warn_recovery_cleanup_failure(transfer_id: &str, error: &BrowserPlatformError) {
    web_sys::console::warn_1(&JsValue::from_str(&format!(
        "stream transfer {transfer_id} completed, but its recovery checkpoint could not be removed after retries: {error}"
    )));
}

fn recoverable_stream_pause_reason(error: &BrowserPlatformError) -> Option<StreamPauseReason> {
    match error {
        BrowserPlatformError::Storage {
            kind: BrowserStorageErrorKind::QuotaExceeded,
            ..
        } => Some(StreamPauseReason::DestinationQuotaExceeded),
        BrowserPlatformError::Storage {
            kind: BrowserStorageErrorKind::PermissionDenied,
            ..
        } => Some(StreamPauseReason::DestinationPermissionDenied),
        _ => None,
    }
}

fn recovery_record_from_receive(
    receive: &ReceiveState,
    peer_id: &str,
) -> Option<StreamRecoveryRecord> {
    let ReceivePayload::Streamed {
        segment_bytes,
        files,
        ..
    } = &receive.payload
    else {
        return None;
    };
    let recovery_files = receive
        .offer
        .files
        .iter()
        .zip(files)
        .map(|(offer, state)| {
            state.writer.as_ref().map(|writer| StreamRecoveryFile {
                file_id: format_binary_id("file", &offer.file_bytes),
                name: offer.file.name.clone(),
                mime: offer.file.mime.clone(),
                size_bytes: offer.file.size_bytes,
                handle: writer.recovery_handle(),
                committed_bytes: state.segment_offset,
                last_segment_blake3: state.last_segment_blake3.clone(),
            })
        })
        .collect::<Option<Vec<_>>>()?;
    Some(StreamRecoveryRecord {
        transfer_id: receive.offer.transfer_id.clone(),
        peer_id: peer_id.to_owned(),
        segment_bytes: *segment_bytes,
        files: recovery_files,
    })
}
