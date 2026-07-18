use blake3::Hasher;
use p2p_protocol::{CURRENT_PROTOCOL, ControlMessage, TransferMode};
use wasm_bindgen_futures::spawn_local;

use super::super::super::{
    BrowserPlatformError, CancelReason, RtcEvent, TransferDirection, TransferFile,
    manifest::summarize_transfer_files, wire::send_control_on,
};
use super::super::{BrowserFile, OutgoingState, ReceivePayload, ReceiveState, RtcPeer};
use super::{active_transfer_id, prepare_outgoing};
use crate::stream_recovery::{delete_outgoing_recovery, delete_stream_recovery};

impl RtcPeer {
    pub fn offer_files(&self, files: Vec<BrowserFile>) -> Result<String, BrowserPlatformError> {
        let prepared = prepare_outgoing(files, None)?;
        self.install_and_offer_outgoing(prepared)
    }

    pub(in crate::rtc::browser) fn install_and_offer_outgoing(
        &self,
        prepared: (OutgoingState, ControlMessage, Vec<TransferFile>),
    ) -> Result<String, BrowserPlatformError> {
        let channel = self.current_data_channel()?;
        let (outgoing, message, metadata) = prepared;
        let transfer_id = outgoing.transfer_id.clone();
        {
            let mut inner = self.inner.borrow_mut();
            if inner.outgoing.is_some()
                || inner.incoming.is_some()
                || inner.receive.is_some()
                || inner.restoring_outgoing
            {
                return Err(BrowserPlatformError::Browser(
                    "another transfer is already active".to_owned(),
                ));
            }
            inner.outgoing = Some(outgoing);
        }
        if let Err(error) = send_control_on(&channel, &message) {
            self.inner.borrow_mut().outgoing = None;
            return Err(error);
        }
        self.emit(RtcEvent::OutgoingOffered {
            transfer_id: transfer_id.clone(),
            file: summarize_transfer_files(&metadata),
            files: metadata,
        });
        Ok(transfer_id)
    }

    pub fn decide_transfer(
        &self,
        transfer_id: &str,
        accepted: bool,
    ) -> Result<(), BrowserPlatformError> {
        let channel = self.current_data_channel()?;
        let offer = {
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
            inner.pending_recovery = None;
            inner.paused_receive_reason = None;
            offer
        };
        if accepted {
            if offer.mode != TransferMode::Buffered {
                self.inner.borrow_mut().incoming = Some(offer);
                return Err(BrowserPlatformError::Browser(
                    "streaming transfer requires a save destination".to_owned(),
                ));
            }
            send_control_on(
                &channel,
                &ControlMessage::Decision {
                    version: CURRENT_PROTOCOL,
                    transfer_id: transfer_id.to_owned(),
                    accepted: true,
                },
            )?;
            self.inner.borrow_mut().receive = Some(ReceiveState {
                offer,
                started: false,
                received_bytes: 0,
                payload: ReceivePayload::Buffered { chunks: Vec::new() },
                hasher: Hasher::new(),
                resume_requested: false,
                last_progress_ms: 0.0,
                recovery_persisted: false,
                generation: 0,
            });
        } else {
            send_control_on(
                &channel,
                &ControlMessage::Decision {
                    version: CURRENT_PROTOCOL,
                    transfer_id: transfer_id.to_owned(),
                    accepted: false,
                },
            )?;
            self.emit(RtcEvent::TransferRejected {
                transfer_id: transfer_id.to_owned(),
                direction: TransferDirection::Receive,
                file: summarize_transfer_files(&offer.transfer_files()),
                files: offer.transfer_files(),
            });
            let transfer_id = transfer_id.to_owned();
            spawn_local(async move {
                let _ = delete_stream_recovery(&transfer_id).await;
            });
        }
        Ok(())
    }

    pub async fn cancel_transfer(&self, reason: CancelReason) -> Result<(), BrowserPlatformError> {
        let transfer_id = {
            let inner = self.inner.borrow();
            active_transfer_id(&inner)
        };
        let Some(transfer_id) = transfer_id else {
            return Ok(());
        };
        let mut first_error = self.current_data_channel().ok().and_then(|channel| {
            send_control_on(
                &channel,
                &ControlMessage::Cancel {
                    version: CURRENT_PROTOCOL,
                    transfer_id: transfer_id.clone(),
                    reason,
                },
            )
            .err()
        });
        let (writers, active_aborts, delete_recovery, outgoing_recovery_peer) = {
            let mut inner = self.inner.borrow_mut();
            let mut writers = Vec::new();
            let mut active_aborts = Vec::new();
            let mut delete_recovery = false;
            let mut outgoing_recovery_peer = None;

            if inner
                .outgoing
                .as_ref()
                .is_some_and(|state| state.transfer_id == transfer_id)
            {
                let mut outgoing = inner.outgoing.take().expect("outgoing was checked");
                outgoing.cancelled = true;
                outgoing.generation = outgoing.generation.saturating_add(1);
                if let Some(pending) = outgoing.pending_ack.as_mut() {
                    pending.sender.take();
                }
                outgoing_recovery_peer = outgoing.recovery_peer_id;
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
            if inner.restoring_transfer.as_deref() == Some(transfer_id.as_str()) {
                inner.restoring_transfer = None;
                delete_recovery = true;
            }
            if inner
                .receive
                .as_ref()
                .is_some_and(|state| state.offer.transfer_id == transfer_id)
            {
                let mut receive = inner.receive.take().expect("receiver was checked");
                receive.generation = receive.generation.saturating_add(1);
                if let ReceivePayload::Streamed { files, .. } = &mut receive.payload {
                    for file in files {
                        if let Some(abort) = file.active_abort.take() {
                            active_aborts.push(abort);
                        }
                        if let Some(writer) = file.writer.take() {
                            writers.push(writer);
                        }
                    }
                }
                delete_recovery = true;
            }
            (
                writers,
                active_aborts,
                delete_recovery,
                outgoing_recovery_peer,
            )
        };

        for abort in active_aborts {
            if let Err(error) = abort.abort().await
                && first_error.is_none()
            {
                first_error = Some(error);
            }
        }
        for writer in writers {
            if let Err(error) = writer.abort().await
                && first_error.is_none()
            {
                first_error = Some(error);
            }
        }
        if delete_recovery
            && let Err(error) = delete_stream_recovery(&transfer_id).await
            && first_error.is_none()
        {
            first_error = Some(error);
        }
        if let Some(peer_id) = outgoing_recovery_peer
            && let Err(error) = delete_outgoing_recovery(&peer_id).await
            && first_error.is_none()
        {
            first_error = Some(error);
        }
        self.emit(RtcEvent::TransferCancelled {
            transfer_id,
            reason,
        });
        first_error.map_or(Ok(()), Err)
    }
}
