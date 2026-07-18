use p2p_protocol::{CURRENT_PROTOCOL, ControlMessage, FileDigest, TransferMode};
use wasm_bindgen_futures::spawn_local;

use super::super::super::{
    RtcEvent, StreamPauseReason, TransferDirection,
    manifest::{batch_blake3, summarize_transfer_files},
    wire::send_control_on,
};
use super::super::RtcPeer;
use crate::stream_recovery::{delete_outgoing_recovery, delete_stream_recovery};

impl RtcPeer {
    pub(in crate::rtc::browser) fn handle_decision(&self, transfer_id: String, accepted: bool) {
        let (rejected, start_generation) = {
            let mut inner = self.inner.borrow_mut();
            let Some(outgoing) = inner.outgoing.as_mut() else {
                drop(inner);
                self.fail(
                    Some(transfer_id),
                    "decision has no outgoing transfer".to_owned(),
                );
                return;
            };
            if outgoing.transfer_id != transfer_id {
                drop(inner);
                self.fail(Some(transfer_id), "decision id does not match".to_owned());
                return;
            }
            if !accepted {
                let outgoing = inner.outgoing.take().expect("outgoing was checked");
                let files = outgoing
                    .files
                    .iter()
                    .map(|file| file.file.clone())
                    .collect::<Vec<_>>();
                (
                    Some((
                        summarize_transfer_files(&files),
                        files,
                        outgoing.recovery_peer_id,
                    )),
                    None,
                )
            } else {
                outgoing.accepted = true;
                let ready =
                    outgoing.mode == TransferMode::Buffered || outgoing.stream_ready.is_some();
                let should_start = ready && !outgoing.sending;
                if should_start {
                    outgoing.sending = true;
                }
                (None, should_start.then_some(outgoing.generation))
            }
        };
        if let Some((file, files, recovery_peer_id)) = rejected {
            self.emit(RtcEvent::TransferRejected {
                transfer_id,
                direction: TransferDirection::Send,
                file,
                files,
            });
            if let Some(peer_id) = recovery_peer_id {
                spawn_local(async move {
                    let _ = delete_outgoing_recovery(&peer_id).await;
                });
            }
        } else if let Some(generation) = start_generation {
            self.spawn_outgoing(transfer_id, generation);
        }
    }

    pub(in crate::rtc::browser) fn handle_stream_paused(
        &self,
        transfer_id: String,
        reason: StreamPauseReason,
    ) {
        let paused = {
            let mut inner = self.inner.borrow_mut();
            let Some(outgoing) = inner.outgoing.as_mut() else {
                drop(inner);
                self.fail(
                    Some(transfer_id),
                    "stream pause has no outgoing transfer".to_owned(),
                );
                return;
            };
            if outgoing.transfer_id != transfer_id
                || !matches!(outgoing.mode, TransferMode::Streamed { .. })
            {
                drop(inner);
                self.fail(
                    Some(transfer_id),
                    "stream pause does not match the outgoing transfer".to_owned(),
                );
                return;
            }
            outgoing.generation = outgoing.generation.saturating_add(1);
            outgoing.accepted = true;
            outgoing.sending = false;
            outgoing.stream_ready = None;
            if let Some(pending) = outgoing.pending_ack.as_mut() {
                pending.sender.take();
            }
            outgoing.sent_bytes = outgoing.files.iter().map(|file| file.committed_bytes).sum();
            (outgoing.sent_bytes, outgoing.total_bytes)
        };
        self.emit(RtcEvent::TransferPaused {
            transfer_id,
            direction: TransferDirection::Send,
            reason,
            completed_bytes: paused.0,
            total_bytes: paused.1,
        });
    }

    pub(in crate::rtc::browser) fn handle_stream_complete(
        &self,
        transfer_id: String,
        total_bytes: u64,
        files: Vec<FileDigest>,
    ) {
        if self.inner.borrow().receive.is_some() {
            self.finish_stream_receive(transfer_id, total_bytes, files);
            return;
        }
        let completed = {
            let mut inner = self.inner.borrow_mut();
            let Some(outgoing) = inner.outgoing.as_ref() else {
                drop(inner);
                self.fail(
                    Some(transfer_id),
                    "stream completion has no active transfer".to_owned(),
                );
                return;
            };
            if outgoing.transfer_id != transfer_id
                || !matches!(outgoing.mode, TransferMode::Streamed { .. })
                || total_bytes != outgoing.total_bytes
                || outgoing.sent_bytes != total_bytes
                || files != outgoing.expected_digests
            {
                drop(inner);
                self.fail(
                    Some(transfer_id),
                    "receiver stream verification does not match".to_owned(),
                );
                return;
            }
            let outgoing = inner.outgoing.take().expect("outgoing was checked");
            let transfer_files = outgoing
                .files
                .into_iter()
                .map(|file| file.file)
                .collect::<Vec<_>>();
            (
                outgoing.transfer_id,
                transfer_files,
                outgoing.recovery_peer_id,
            )
        };
        self.emit(RtcEvent::TransferCompleted {
            transfer_id: completed.0,
            direction: TransferDirection::Send,
            file: summarize_transfer_files(&completed.1),
            files: completed.1,
            blake3: batch_blake3(&files),
            download_url: None,
        });
        if let Some(peer_id) = completed.2 {
            spawn_local(async move {
                let _ = delete_outgoing_recovery(&peer_id).await;
            });
        }
    }

    pub(in crate::rtc::browser) fn handle_complete(
        &self,
        transfer_id: String,
        bytes: u64,
        blake3: String,
    ) {
        if self.inner.borrow().receive.is_some() {
            self.finish_receive(transfer_id, bytes, blake3);
            return;
        }
        let completed = {
            let mut inner = self.inner.borrow_mut();
            let Some(outgoing) = inner.outgoing.as_ref() else {
                drop(inner);
                self.fail(
                    Some(transfer_id),
                    "completion has no active transfer".to_owned(),
                );
                return;
            };
            if outgoing.transfer_id != transfer_id
                || outgoing.mode != TransferMode::Buffered
                || outgoing.sent_bytes != bytes
                || outgoing.files.len() != 1
                || outgoing.files[0].expected_hash.as_deref() != Some(blake3.as_str())
            {
                drop(inner);
                self.fail(
                    Some(transfer_id),
                    "receiver verification does not match".to_owned(),
                );
                return;
            }
            let outgoing = inner.outgoing.take().expect("outgoing was checked");
            (outgoing.files[0].file.clone(), outgoing.transfer_id)
        };
        self.emit(RtcEvent::TransferCompleted {
            transfer_id: completed.1,
            direction: TransferDirection::Send,
            file: completed.0.clone(),
            files: vec![completed.0],
            blake3,
            download_url: None,
        });
    }

    pub(in crate::rtc::browser) fn send_transfer_error(
        &self,
        transfer_id: &str,
        code: &str,
        message: &str,
    ) {
        if let Ok(channel) = self.current_data_channel() {
            let _ = send_control_on(
                &channel,
                &ControlMessage::Error {
                    version: CURRENT_PROTOCOL,
                    transfer_id: transfer_id.to_owned(),
                    code: code.to_owned(),
                    message: message.to_owned(),
                },
            );
        }
    }

    pub(in crate::rtc::browser) fn clear_transfer(&self, transfer_id: &str) {
        let mut inner = self.inner.borrow_mut();
        let mut delete_recovery = false;
        let mut outgoing_recovery_peer = None;
        if inner
            .outgoing
            .as_ref()
            .is_some_and(|state| state.transfer_id == transfer_id)
        {
            outgoing_recovery_peer = inner
                .outgoing
                .take()
                .and_then(|state| state.recovery_peer_id);
        }
        if inner
            .pending_outgoing_recovery
            .as_ref()
            .is_some_and(|state| state.transfer_id == transfer_id)
        {
            outgoing_recovery_peer = inner
                .pending_outgoing_recovery
                .take()
                .map(|state| state.peer_id);
        }
        if inner
            .incoming
            .as_ref()
            .is_some_and(|state| state.transfer_id == transfer_id)
        {
            inner.incoming = None;
            delete_recovery = true;
        }
        if inner
            .pending_recovery
            .as_ref()
            .is_some_and(|state| state.transfer_id == transfer_id)
        {
            inner.pending_recovery = None;
            inner.paused_receive_reason = None;
            delete_recovery = true;
        }
        if inner.restoring_transfer.as_deref() == Some(transfer_id) {
            inner.restoring_transfer = None;
            delete_recovery = true;
        }
        if inner
            .receive
            .as_ref()
            .is_some_and(|state| state.offer.transfer_id == transfer_id)
        {
            inner.receive = None;
            delete_recovery = true;
        }
        drop(inner);
        if delete_recovery {
            let transfer_id = transfer_id.to_owned();
            spawn_local(async move {
                let _ = delete_stream_recovery(&transfer_id).await;
            });
        }
        if let Some(peer_id) = outgoing_recovery_peer {
            spawn_local(async move {
                let _ = delete_outgoing_recovery(&peer_id).await;
            });
        }
    }
}
