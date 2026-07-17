use std::{cell::RefCell, rc::Rc};

use blake3::Hasher;
use futures_channel::oneshot;
use futures_util::{
    FutureExt,
    future::{Either, select},
    pin_mut,
};
use gloo_timers::future::TimeoutFuture;
use js_sys::{ArrayBuffer, Date, Uint8Array};
use p2p_protocol::{CURRENT_PROTOCOL, ControlMessage, FileDigest, TransferMode};
use p2p_transfer::{BackpressurePolicy, ChunkPlan, SegmentPlan};
use wasm_bindgen::{JsCast, closure::Closure};
use wasm_bindgen_futures::{JsFuture, spawn_local};
use web_sys::{Event, RtcDataChannel};

use super::{
    BACKPRESSURE_TIMEOUT_MS, BrowserPlatformError, PROGRESS_INTERVAL_MS, PendingSegmentAck,
    RtcConnectionPhase, RtcEvent, RtcPeer, TransferDirection, browser_error, encode_binary_chunk,
    format_binary_id, reconnectable_channel_error, send_control_on, summarize_transfer_files,
};

impl RtcPeer {
    pub(super) fn spawn_outgoing(&self, transfer_id: String, generation: u64) {
        let peer = self.clone();
        spawn_local(async move {
            if let Err(error) = peer.send_outgoing(transfer_id.clone(), generation).await
                && peer.outgoing_generation_matches(&transfer_id, generation)
            {
                if reconnectable_channel_error(&error) {
                    peer.suspend_stream_for_reconnect();
                    peer.emit(RtcEvent::ConnectionState(RtcConnectionPhase::Closed));
                } else {
                    peer.clear_transfer(&transfer_id);
                    peer.fail(Some(transfer_id), error.to_string());
                }
            }
        });
    }

    async fn send_outgoing(
        &self,
        transfer_id: String,
        generation: u64,
    ) -> Result<(), BrowserPlatformError> {
        let mode = self
            .inner
            .borrow()
            .outgoing
            .as_ref()
            .ok_or_else(|| {
                BrowserPlatformError::Browser("outgoing transfer disappeared".to_owned())
            })?
            .mode;
        match mode {
            TransferMode::Buffered => self.send_buffered_outgoing(transfer_id).await,
            TransferMode::Streamed { segment_bytes } => {
                self.send_streamed_outgoing(transfer_id, segment_bytes, generation)
                    .await
            }
        }
    }

    async fn send_buffered_outgoing(
        &self,
        transfer_id: String,
    ) -> Result<(), BrowserPlatformError> {
        let (browser_file, file, transfer_bytes, file_bytes) = {
            let inner = self.inner.borrow();
            let outgoing = inner.outgoing.as_ref().ok_or_else(|| {
                BrowserPlatformError::Browser("outgoing transfer disappeared".to_owned())
            })?;
            let outgoing_file = outgoing.files.first().ok_or_else(|| {
                BrowserPlatformError::Browser("outgoing file disappeared".to_owned())
            })?;
            (
                outgoing_file.browser_file.clone(),
                outgoing_file.file.clone(),
                outgoing.transfer_bytes,
                outgoing_file.file_bytes,
            )
        };
        let channel = self.current_data_channel()?;
        send_control_on(
            &channel,
            &ControlMessage::Start {
                version: CURRENT_PROTOCOL,
                transfer_id: transfer_id.clone(),
            },
        )?;
        self.emit(RtcEvent::TransferStarted {
            transfer_id: transfer_id.clone(),
            direction: TransferDirection::Send,
            mode: TransferMode::Buffered,
            file: file.clone(),
            files: vec![file.clone()],
        });
        TimeoutFuture::new(20).await;

        let policy = BackpressurePolicy::default();
        let plan = ChunkPlan::new(file.size_bytes, policy.chunk_bytes as u32)
            .map_err(|error| BrowserPlatformError::Browser(format!("{error:?}")))?;
        let mut hasher = Hasher::new();
        for index in 0..plan.chunk_count() {
            if self.outgoing_cancelled(&transfer_id) {
                return Ok(());
            }
            if policy.should_pause(u64::from(channel.buffered_amount())) {
                wait_for_buffer_low(&channel, policy).await;
                if self.outgoing_cancelled(&transfer_id) {
                    return Ok(());
                }
            }
            let descriptor = plan.chunk(index).ok_or_else(|| {
                BrowserPlatformError::Browser("chunk plan ended early".to_owned())
            })?;
            let end = descriptor.offset + u64::from(descriptor.length);
            let blob = browser_file
                .slice_with_f64_and_f64(descriptor.offset as f64, end as f64)
                .map_err(browser_error)?;
            let array_buffer = JsFuture::from(blob.array_buffer())
                .await
                .map_err(browser_error)?
                .dyn_into::<ArrayBuffer>()
                .map_err(browser_error)?;
            let bytes = Uint8Array::new(&array_buffer).to_vec();
            hasher.update(&bytes);
            let frame = encode_binary_chunk(
                transfer_bytes,
                file_bytes,
                descriptor.offset,
                descriptor.length,
                &bytes,
            );
            channel.send_with_u8_array(&frame).map_err(browser_error)?;
            let now = Date::now();
            let emit_progress = {
                let mut inner = self.inner.borrow_mut();
                let outgoing = inner.outgoing.as_mut().ok_or_else(|| {
                    BrowserPlatformError::Browser("outgoing transfer disappeared".to_owned())
                })?;
                outgoing.sent_bytes = end;
                outgoing.max_buffered_bytes = outgoing
                    .max_buffered_bytes
                    .max(u64::from(channel.buffered_amount()));
                if now - outgoing.last_progress_ms >= PROGRESS_INTERVAL_MS || end == file.size_bytes
                {
                    outgoing.last_progress_ms = now;
                    true
                } else {
                    false
                }
            };
            if emit_progress {
                self.emit(RtcEvent::TransferProgress {
                    transfer_id: transfer_id.clone(),
                    direction: TransferDirection::Send,
                    completed_bytes: end,
                    total_bytes: file.size_bytes,
                });
            }
        }
        let digest = hasher.finalize().to_hex().to_string();
        {
            let mut inner = self.inner.borrow_mut();
            let outgoing = inner.outgoing.as_mut().ok_or_else(|| {
                BrowserPlatformError::Browser("outgoing transfer disappeared".to_owned())
            })?;
            let outgoing_file = outgoing.files.first_mut().ok_or_else(|| {
                BrowserPlatformError::Browser("outgoing file disappeared".to_owned())
            })?;
            outgoing_file.expected_hash = Some(digest.clone());
        }
        send_control_on(
            &channel,
            &ControlMessage::Complete {
                version: CURRENT_PROTOCOL,
                transfer_id: transfer_id.clone(),
                bytes: file.size_bytes,
                blake3: digest,
            },
        )?;
        self.emit(RtcEvent::AwaitingVerification {
            transfer_id,
            file: file.clone(),
            files: vec![file],
        });
        Ok(())
    }

    async fn send_streamed_outgoing(
        &self,
        transfer_id: String,
        segment_bytes: u32,
        generation: u64,
    ) -> Result<(), BrowserPlatformError> {
        let (transfer_bytes, ready, total_bytes, sent_bytes, transfer_files) = {
            let inner = self.inner.borrow();
            let outgoing = inner.outgoing.as_ref().ok_or_else(|| {
                BrowserPlatformError::Browser("outgoing transfer disappeared".to_owned())
            })?;
            if outgoing.generation != generation {
                return Ok(());
            }
            let ready = outgoing.stream_ready.ok_or_else(|| {
                BrowserPlatformError::Browser("streaming receiver is not ready".to_owned())
            })?;
            (
                outgoing.transfer_bytes,
                ready,
                outgoing.total_bytes,
                outgoing.sent_bytes,
                outgoing
                    .files
                    .iter()
                    .map(|file| file.file.clone())
                    .collect::<Vec<_>>(),
            )
        };
        if ready.ack_window_bytes < u64::from(segment_bytes) {
            return Err(BrowserPlatformError::Browser(
                "streaming acknowledgement window is too small".to_owned(),
            ));
        }
        let channel = self.current_data_channel()?;
        send_control_on(
            &channel,
            &ControlMessage::Start {
                version: CURRENT_PROTOCOL,
                transfer_id: transfer_id.clone(),
            },
        )?;
        self.emit(RtcEvent::TransferStarted {
            transfer_id: transfer_id.clone(),
            direction: TransferDirection::Send,
            mode: TransferMode::Streamed { segment_bytes },
            file: summarize_transfer_files(&transfer_files),
            files: transfer_files.clone(),
        });
        if sent_bytes > 0 {
            self.emit(RtcEvent::TransferProgress {
                transfer_id: transfer_id.clone(),
                direction: TransferDirection::Send,
                completed_bytes: sent_bytes,
                total_bytes,
            });
        }
        TimeoutFuture::new(20).await;

        let policy = BackpressurePolicy {
            chunk_bytes: ready.max_chunk_bytes as usize,
            ..BackpressurePolicy::default()
        };
        let mut digests = Vec::with_capacity(transfer_files.len());
        let mut preceding_bytes = 0_u64;
        for file_index in 0..transfer_files.len() {
            let (browser_file, file, file_bytes, committed_bytes, mut file_hasher) = {
                let inner = self.inner.borrow();
                let outgoing = inner.outgoing.as_ref().ok_or_else(|| {
                    BrowserPlatformError::Browser("outgoing transfer disappeared".to_owned())
                })?;
                if outgoing.generation != generation {
                    return Ok(());
                }
                let file = outgoing.files.get(file_index).ok_or_else(|| {
                    BrowserPlatformError::Browser("outgoing file disappeared".to_owned())
                })?;
                (
                    file.browser_file.clone(),
                    file.file.clone(),
                    file.file_bytes,
                    file.committed_bytes,
                    file.committed_hasher.as_ref().clone(),
                )
            };
            let segments = SegmentPlan::new(file.size_bytes, segment_bytes)
                .map_err(|error| BrowserPlatformError::Browser(format!("{error:?}")))?;
            let start_segment = if committed_bytes == file.size_bytes {
                segments.segment_count()
            } else {
                committed_bytes / u64::from(segment_bytes)
            };
            for segment_index in start_segment..segments.segment_count() {
                let segment = segments.segment(segment_index).ok_or_else(|| {
                    BrowserPlatformError::Browser("segment plan ended early".to_owned())
                })?;
                let mut segment_hasher = Hasher::new();
                let mut segment_sent = 0_u64;
                while segment_sent < u64::from(segment.length) {
                    if !self.outgoing_generation_matches(&transfer_id, generation)
                        || self.outgoing_cancelled(&transfer_id)
                    {
                        return Ok(());
                    }
                    if policy.should_pause(u64::from(channel.buffered_amount())) {
                        wait_for_buffer_low(&channel, policy).await;
                        if !self.outgoing_generation_matches(&transfer_id, generation)
                            || self.outgoing_cancelled(&transfer_id)
                        {
                            return Ok(());
                        }
                    }
                    let remaining = u64::from(segment.length) - segment_sent;
                    let chunk_length = remaining.min(ready.max_chunk_bytes as u64) as u32;
                    let offset = segment.offset + segment_sent;
                    let end = offset + u64::from(chunk_length);
                    let blob = browser_file
                        .slice_with_f64_and_f64(offset as f64, end as f64)
                        .map_err(browser_error)?;
                    let array_buffer = JsFuture::from(blob.array_buffer())
                        .await
                        .map_err(browser_error)?
                        .dyn_into::<ArrayBuffer>()
                        .map_err(browser_error)?;
                    let bytes = Uint8Array::new(&array_buffer).to_vec();
                    file_hasher.update(&bytes);
                    segment_hasher.update(&bytes);
                    let frame = encode_binary_chunk(
                        transfer_bytes,
                        file_bytes,
                        offset,
                        chunk_length,
                        &bytes,
                    );
                    channel.send_with_u8_array(&frame).map_err(browser_error)?;
                    segment_sent += u64::from(chunk_length);
                    let completed_bytes = preceding_bytes + end;
                    let now = Date::now();
                    let emit_progress = {
                        let mut inner = self.inner.borrow_mut();
                        let outgoing = inner.outgoing.as_mut().ok_or_else(|| {
                            BrowserPlatformError::Browser(
                                "outgoing transfer disappeared".to_owned(),
                            )
                        })?;
                        outgoing.sent_bytes = completed_bytes;
                        outgoing.max_buffered_bytes = outgoing
                            .max_buffered_bytes
                            .max(u64::from(channel.buffered_amount()));
                        if now - outgoing.last_progress_ms >= PROGRESS_INTERVAL_MS
                            || completed_bytes == total_bytes
                        {
                            outgoing.last_progress_ms = now;
                            true
                        } else {
                            false
                        }
                    };
                    if emit_progress {
                        self.emit(RtcEvent::TransferProgress {
                            transfer_id: transfer_id.clone(),
                            direction: TransferDirection::Send,
                            completed_bytes,
                            total_bytes,
                        });
                    }
                }

                let segment_blake3 = segment_hasher.finalize().to_hex().to_string();
                let committed_bytes = segment.offset + u64::from(segment.length);
                let (ack_sender, ack_receiver) = oneshot::channel();
                {
                    let mut inner = self.inner.borrow_mut();
                    let outgoing = inner.outgoing.as_mut().ok_or_else(|| {
                        BrowserPlatformError::Browser("outgoing transfer disappeared".to_owned())
                    })?;
                    outgoing.pending_ack = Some(PendingSegmentAck {
                        file_index,
                        segment_index,
                        committed_bytes,
                        blake3: segment_blake3.clone(),
                        file_hasher: Box::new(file_hasher.clone()),
                        sender: Some(ack_sender),
                    });
                }
                send_control_on(
                    &channel,
                    &ControlMessage::SegmentCommit {
                        version: CURRENT_PROTOCOL,
                        transfer_id: transfer_id.clone(),
                        file_id: format_binary_id("file", &file_bytes),
                        segment_index,
                        offset: segment.offset,
                        bytes: segment.length,
                        blake3: segment_blake3,
                    },
                )?;
                let acknowledgement = ack_receiver.map(|result| {
                    result
                        .unwrap_or_else(|_| Err("streaming acknowledgement was dropped".to_owned()))
                });
                let timeout = TimeoutFuture::new(30_000)
                    .map(|_| Err("streaming acknowledgement timed out".to_owned()));
                pin_mut!(acknowledgement, timeout);
                let result = match select(acknowledgement, timeout).await {
                    Either::Left((result, _)) | Either::Right((result, _)) => result,
                };
                result.map_err(BrowserPlatformError::Browser)?;
            }
            let digest = file_hasher.finalize().to_hex().to_string();
            {
                let mut inner = self.inner.borrow_mut();
                let outgoing = inner.outgoing.as_mut().ok_or_else(|| {
                    BrowserPlatformError::Browser("outgoing transfer disappeared".to_owned())
                })?;
                let outgoing_file = outgoing.files.get_mut(file_index).ok_or_else(|| {
                    BrowserPlatformError::Browser("outgoing file disappeared".to_owned())
                })?;
                outgoing_file.expected_hash = Some(digest.clone());
            }
            digests.push(FileDigest {
                file_id: format_binary_id("file", &file_bytes),
                size_bytes: file.size_bytes,
                blake3: digest,
            });
            preceding_bytes += file.size_bytes;
        }

        if !self.outgoing_generation_matches(&transfer_id, generation) {
            return Ok(());
        }

        {
            let mut inner = self.inner.borrow_mut();
            let outgoing = inner.outgoing.as_mut().ok_or_else(|| {
                BrowserPlatformError::Browser("outgoing transfer disappeared".to_owned())
            })?;
            outgoing.expected_digests = digests.clone();
            outgoing.sent_bytes = total_bytes;
        }
        send_control_on(
            &channel,
            &ControlMessage::StreamComplete {
                version: CURRENT_PROTOCOL,
                transfer_id: transfer_id.clone(),
                total_bytes,
                files: digests,
            },
        )?;
        self.emit(RtcEvent::AwaitingVerification {
            transfer_id,
            file: summarize_transfer_files(&transfer_files),
            files: transfer_files,
        });
        Ok(())
    }

    fn outgoing_cancelled(&self, transfer_id: &str) -> bool {
        self.inner
            .borrow()
            .outgoing
            .as_ref()
            .is_none_or(|outgoing| outgoing.transfer_id != transfer_id || outgoing.cancelled)
    }

    fn outgoing_generation_matches(&self, transfer_id: &str, generation: u64) -> bool {
        self.inner
            .borrow()
            .outgoing
            .as_ref()
            .is_some_and(|outgoing| {
                outgoing.transfer_id == transfer_id
                    && outgoing.generation == generation
                    && !outgoing.cancelled
            })
    }
}

async fn wait_for_buffer_low(channel: &RtcDataChannel, policy: BackpressurePolicy) {
    while !policy.can_resume(u64::from(channel.buffered_amount())) {
        let (sender, receiver) = oneshot::channel::<()>();
        let sender = Rc::new(RefCell::new(Some(sender)));
        let event_sender = Rc::clone(&sender);
        let on_low = Closure::<dyn FnMut(Event)>::new(move |_| {
            if let Some(sender) = event_sender.borrow_mut().take() {
                let _ = sender.send(());
            }
        });
        channel.set_onbufferedamountlow(Some(on_low.as_ref().unchecked_ref()));
        if policy.can_resume(u64::from(channel.buffered_amount()))
            && let Some(sender) = sender.borrow_mut().take()
        {
            let _ = sender.send(());
        }
        let event = receiver.map(|_| ());
        let timeout = TimeoutFuture::new(BACKPRESSURE_TIMEOUT_MS);
        pin_mut!(event, timeout);
        let _ = select(event, timeout).await;
        channel.set_onbufferedamountlow(None);
    }
}
