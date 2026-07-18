use p2p_protocol::TransferMode;
use wasm_bindgen_futures::spawn_local;

use super::super::super::{CancelReason, RtcEvent};
use super::super::{ReceivePayload, RtcPeer, clear_peer_resources, recovery};
use super::active_transfer_id;
use crate::stream_recovery::{delete_outgoing_recovery, delete_stream_recovery};

impl RtcPeer {
    pub fn reset(&self) {
        let (cancelled, outgoing_recovery_peer) = {
            let mut inner = self.inner.borrow_mut();
            let transfer_id = active_transfer_id(&inner);
            let outgoing_recovery_peer = inner
                .outgoing
                .as_ref()
                .and_then(|state| state.recovery_peer_id.clone())
                .or_else(|| {
                    inner
                        .pending_outgoing_recovery
                        .as_ref()
                        .map(|state| state.peer_id.clone())
                });
            clear_peer_resources(&mut inner);
            inner.outgoing = None;
            inner.pending_outgoing_recovery = None;
            inner.restoring_outgoing = false;
            inner.incoming = None;
            inner.pending_recovery = None;
            inner.paused_receive_reason = None;
            inner.restoring_transfer = None;
            inner.receive = None;
            (transfer_id, outgoing_recovery_peer)
        };
        if let Some(transfer_id) = cancelled {
            let recovery_id = transfer_id.clone();
            spawn_local(async move {
                let _ = delete_stream_recovery(&recovery_id).await;
            });
            self.emit(RtcEvent::TransferCancelled {
                transfer_id,
                reason: CancelReason::PeerClosed,
            });
        }
        if let Some(peer_id) = outgoing_recovery_peer {
            spawn_local(async move {
                let _ = delete_outgoing_recovery(&peer_id).await;
            });
        }
    }

    pub fn prepare_reconnect(&self) {
        let cancelled = {
            let mut inner = self.inner.borrow_mut();
            let mut cancelled = None;

            if let Some(outgoing) = inner.outgoing.as_mut() {
                if matches!(outgoing.mode, TransferMode::Streamed { .. }) {
                    outgoing.generation = outgoing.generation.saturating_add(1);
                    outgoing.accepted = false;
                    outgoing.stream_ready = None;
                    outgoing.sending = false;
                    outgoing.sent_bytes =
                        outgoing.files.iter().map(|file| file.committed_bytes).sum();
                    if let Some(pending) = outgoing.pending_ack.as_mut() {
                        pending.sender.take();
                    }
                } else {
                    cancelled = Some(outgoing.transfer_id.clone());
                    inner.outgoing = None;
                }
            }

            if let Some(receive) = inner.receive.as_mut() {
                if matches!(receive.payload, ReceivePayload::Streamed { .. }) {
                    recovery::prepare_receive_reconnect(receive);
                } else {
                    cancelled = Some(receive.offer.transfer_id.clone());
                    inner.receive = None;
                }
            }

            if let Some(incoming) = inner.incoming.take() {
                cancelled.get_or_insert(incoming.transfer_id);
            }
            clear_peer_resources(&mut inner);
            cancelled
        };
        if let Some(transfer_id) = cancelled {
            self.emit(RtcEvent::TransferCancelled {
                transfer_id,
                reason: CancelReason::PeerClosed,
            });
        }
    }

    pub(in crate::rtc::browser) fn suspend_stream_for_reconnect(&self) {
        let mut inner = self.inner.borrow_mut();
        if let Some(outgoing) = inner.outgoing.as_mut()
            && matches!(outgoing.mode, TransferMode::Streamed { .. })
        {
            outgoing.generation = outgoing.generation.saturating_add(1);
            outgoing.accepted = false;
            outgoing.stream_ready = None;
            outgoing.sending = false;
            outgoing.sent_bytes = outgoing.files.iter().map(|file| file.committed_bytes).sum();
            if let Some(pending) = outgoing.pending_ack.as_mut() {
                pending.sender.take();
            }
        }
        if let Some(receive) = inner.receive.as_mut()
            && matches!(receive.payload, ReceivePayload::Streamed { .. })
        {
            recovery::prepare_receive_reconnect(receive);
        }
    }
}
