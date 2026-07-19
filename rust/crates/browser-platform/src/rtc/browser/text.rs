use p2p_protocol::{
    CURRENT_PROTOCOL, ControlMessage, MAX_TEXT_TRANSFER_BYTES, MAX_TEXT_TRANSFER_CHARS, Validate,
};
use wasm_bindgen_futures::spawn_local;

use super::{
    BrowserPlatformError, IncomingTextOffer, OutgoingTextState, RtcEvent, RtcPeer,
    TransferDirection, lifecycle::random_binary_id, protocol_error, send_control_on,
};
use crate::sleep_ms;

const TEXT_DECISION_TIMEOUT_MS: u32 = 30_000;
const TEXT_PAYLOAD_TIMEOUT_MS: u32 = 15_000;

impl RtcPeer {
    pub fn offer_text(&self, text: String) -> Result<String, BrowserPlatformError> {
        let character_count = u32::try_from(text.chars().count()).map_err(|_| {
            BrowserPlatformError::Browser("text contains too many characters".to_owned())
        })?;
        let byte_length = u32::try_from(text.len())
            .map_err(|_| BrowserPlatformError::Browser("text payload is too large".to_owned()))?;
        let (transfer_id, _) = random_binary_id("text");
        let payload = ControlMessage::TextPayload {
            version: CURRENT_PROTOCOL,
            transfer_id: transfer_id.clone(),
            text: text.clone(),
        };
        payload.validate().map_err(protocol_error)?;
        let offer = ControlMessage::TextOffer {
            version: CURRENT_PROTOCOL,
            transfer_id: transfer_id.clone(),
            character_count,
            byte_length,
        };
        offer.validate().map_err(protocol_error)?;
        let channel = self.current_data_channel()?;
        {
            let mut inner = self.inner.borrow_mut();
            if file_or_text_transfer_active(&inner) {
                return Err(BrowserPlatformError::Browser(
                    "another transfer is already active".to_owned(),
                ));
            }
            inner.outgoing_text = Some(OutgoingTextState {
                transfer_id: transfer_id.clone(),
                text,
                accepted: false,
            });
        }
        if let Err(error) = send_control_on(&channel, &offer) {
            self.inner.borrow_mut().outgoing_text = None;
            return Err(error);
        }
        self.emit(RtcEvent::TextOutgoingOffered {
            transfer_id: transfer_id.clone(),
            character_count,
            byte_length,
        });
        self.schedule_outgoing_text_timeout(transfer_id.clone(), false, TEXT_DECISION_TIMEOUT_MS);
        Ok(transfer_id)
    }

    pub fn decide_text(
        &self,
        transfer_id: &str,
        accepted: bool,
    ) -> Result<(), BrowserPlatformError> {
        let channel = self.current_data_channel()?;
        let offer = {
            let inner = self.inner.borrow();
            let Some(offer) = inner.incoming_text.as_ref() else {
                return Err(BrowserPlatformError::Browser(
                    "incoming text is no longer available".to_owned(),
                ));
            };
            if offer.transfer_id != transfer_id {
                return Err(BrowserPlatformError::Browser(
                    "incoming text id does not match".to_owned(),
                ));
            }
            offer.clone()
        };
        send_control_on(
            &channel,
            &ControlMessage::TextDecision {
                version: CURRENT_PROTOCOL,
                transfer_id: transfer_id.to_owned(),
                accepted,
            },
        )?;
        self.inner.borrow_mut().incoming_text = None;
        if accepted {
            self.inner.borrow_mut().receiving_text = Some(offer);
            self.emit(RtcEvent::TextTransferAccepted {
                transfer_id: transfer_id.to_owned(),
                direction: TransferDirection::Receive,
            });
            self.schedule_incoming_text_timeout(transfer_id.to_owned(), TEXT_PAYLOAD_TIMEOUT_MS);
        } else {
            self.emit(RtcEvent::TextTransferRejected {
                transfer_id: transfer_id.to_owned(),
                direction: TransferDirection::Receive,
            });
        }
        Ok(())
    }

    pub fn cancel_text(&self) -> Result<(), BrowserPlatformError> {
        let transfer_id = {
            let inner = self.inner.borrow();
            active_text_transfer_id(&inner)
        };
        let Some(transfer_id) = transfer_id else {
            return Ok(());
        };
        if let Ok(channel) = self.current_data_channel() {
            send_control_on(
                &channel,
                &ControlMessage::TextCancel {
                    version: CURRENT_PROTOCOL,
                    transfer_id: transfer_id.clone(),
                },
            )?;
        }
        self.clear_text_transfer(&transfer_id);
        self.emit(RtcEvent::TextTransferCancelled { transfer_id });
        Ok(())
    }

    pub(super) fn handle_text_offer(
        &self,
        transfer_id: String,
        character_count: u32,
        byte_length: u32,
    ) {
        let busy = {
            let inner = self.inner.borrow();
            file_or_text_transfer_active(&inner)
        };
        if busy {
            if let Ok(channel) = self.current_data_channel() {
                let _ = send_control_on(
                    &channel,
                    &ControlMessage::TextDecision {
                        version: CURRENT_PROTOCOL,
                        transfer_id: transfer_id.clone(),
                        accepted: false,
                    },
                );
            }
            return;
        }
        self.inner.borrow_mut().incoming_text = Some(IncomingTextOffer {
            transfer_id: transfer_id.clone(),
            character_count,
            byte_length,
        });
        self.emit(RtcEvent::TextIncomingOffered {
            transfer_id,
            character_count,
            byte_length,
        });
    }

    pub(super) fn handle_text_decision(&self, transfer_id: String, accepted: bool) {
        let outgoing = {
            let mut inner = self.inner.borrow_mut();
            let Some(outgoing) = inner.outgoing_text.as_mut() else {
                drop(inner);
                self.text_fail(Some(transfer_id), "text decision arrived without an offer");
                return;
            };
            if outgoing.transfer_id != transfer_id {
                drop(inner);
                self.text_fail(Some(transfer_id), "text decision id does not match");
                return;
            }
            if outgoing.accepted {
                drop(inner);
                self.text_fail(Some(transfer_id), "duplicate text decision");
                return;
            }
            if !accepted {
                inner.outgoing_text.take()
            } else {
                outgoing.accepted = true;
                Some(outgoing.clone())
            }
        };
        let Some(outgoing) = outgoing else {
            return;
        };
        if !accepted {
            self.emit(RtcEvent::TextTransferRejected {
                transfer_id,
                direction: TransferDirection::Send,
            });
            return;
        }
        let result = self.current_data_channel().and_then(|channel| {
            send_control_on(
                &channel,
                &ControlMessage::TextPayload {
                    version: CURRENT_PROTOCOL,
                    transfer_id: transfer_id.clone(),
                    text: outgoing.text,
                },
            )
        });
        if let Err(error) = result {
            self.clear_text_transfer(&transfer_id);
            self.text_fail(Some(transfer_id), &error.to_string());
            return;
        }
        self.emit(RtcEvent::TextTransferAccepted {
            transfer_id: transfer_id.clone(),
            direction: TransferDirection::Send,
        });
        self.schedule_outgoing_text_timeout(transfer_id, true, TEXT_PAYLOAD_TIMEOUT_MS);
    }

    pub(super) fn handle_text_payload(&self, transfer_id: String, text: String) {
        let offer = {
            let mut inner = self.inner.borrow_mut();
            let Some(offer) = inner.receiving_text.take() else {
                drop(inner);
                self.text_fail(Some(transfer_id), "text payload arrived before acceptance");
                return;
            };
            if offer.transfer_id != transfer_id {
                inner.receiving_text = Some(offer);
                drop(inner);
                self.text_fail(Some(transfer_id), "text payload id does not match");
                return;
            }
            offer
        };
        let actual_characters = text.chars().count();
        if actual_characters != offer.character_count as usize
            || text.len() != offer.byte_length as usize
        {
            self.text_fail(
                Some(transfer_id.clone()),
                "text payload metadata does not match",
            );
            if let Ok(channel) = self.current_data_channel() {
                let _ = send_control_on(
                    &channel,
                    &ControlMessage::TextCancel {
                        version: CURRENT_PROTOCOL,
                        transfer_id,
                    },
                );
            }
            return;
        }
        if actual_characters > MAX_TEXT_TRANSFER_CHARS || text.len() > MAX_TEXT_TRANSFER_BYTES {
            self.text_fail(
                Some(transfer_id),
                "text payload exceeds the supported limit",
            );
            return;
        }
        if let Ok(channel) = self.current_data_channel() {
            let _ = send_control_on(
                &channel,
                &ControlMessage::TextReceipt {
                    version: CURRENT_PROTOCOL,
                    transfer_id: transfer_id.clone(),
                },
            );
        }
        self.emit(RtcEvent::TextTransferReceived { transfer_id, text });
    }

    pub(super) fn handle_text_receipt(&self, transfer_id: String) {
        let delivered = {
            let mut inner = self.inner.borrow_mut();
            inner
                .outgoing_text
                .as_ref()
                .is_some_and(|outgoing| outgoing.transfer_id == transfer_id && outgoing.accepted)
                .then(|| inner.outgoing_text.take())
                .flatten()
                .is_some()
        };
        if delivered {
            self.emit(RtcEvent::TextTransferDelivered { transfer_id });
        } else {
            self.text_fail(
                Some(transfer_id),
                "text receipt does not match an active transfer",
            );
        }
    }

    pub(super) fn handle_text_cancel(&self, transfer_id: String) {
        if self.clear_text_transfer(&transfer_id) {
            self.emit(RtcEvent::TextTransferCancelled { transfer_id });
        }
    }

    pub(super) fn clear_text_transfer(&self, transfer_id: &str) -> bool {
        let mut inner = self.inner.borrow_mut();
        let mut cleared = false;
        if inner
            .outgoing_text
            .as_ref()
            .is_some_and(|state| state.transfer_id == transfer_id)
        {
            inner.outgoing_text = None;
            cleared = true;
        }
        if inner
            .incoming_text
            .as_ref()
            .is_some_and(|state| state.transfer_id == transfer_id)
        {
            inner.incoming_text = None;
            cleared = true;
        }
        if inner
            .receiving_text
            .as_ref()
            .is_some_and(|state| state.transfer_id == transfer_id)
        {
            inner.receiving_text = None;
            cleared = true;
        }
        cleared
    }

    fn text_fail(&self, transfer_id: Option<String>, message: &str) {
        self.emit(RtcEvent::TextTransferFailed {
            transfer_id,
            message: message.to_owned(),
        });
    }

    fn schedule_outgoing_text_timeout(&self, transfer_id: String, accepted: bool, timeout_ms: u32) {
        let peer = self.clone();
        spawn_local(async move {
            sleep_ms(timeout_ms).await;
            let timed_out = {
                let inner = peer.inner.borrow();
                inner.outgoing_text.as_ref().is_some_and(|state| {
                    state.transfer_id == transfer_id && state.accepted == accepted
                })
            };
            if timed_out {
                peer.timeout_text_transfer(transfer_id);
            }
        });
    }

    fn schedule_incoming_text_timeout(&self, transfer_id: String, timeout_ms: u32) {
        let peer = self.clone();
        spawn_local(async move {
            sleep_ms(timeout_ms).await;
            let timed_out = peer
                .inner
                .borrow()
                .receiving_text
                .as_ref()
                .is_some_and(|state| state.transfer_id == transfer_id);
            if timed_out {
                peer.timeout_text_transfer(transfer_id);
            }
        });
    }

    fn timeout_text_transfer(&self, transfer_id: String) {
        if let Ok(channel) = self.current_data_channel() {
            let _ = send_control_on(
                &channel,
                &ControlMessage::TextCancel {
                    version: CURRENT_PROTOCOL,
                    transfer_id: transfer_id.clone(),
                },
            );
        }
        if self.clear_text_transfer(&transfer_id) {
            self.text_fail(Some(transfer_id), "text transfer timed out");
        }
    }
}

fn active_text_transfer_id(inner: &super::Inner) -> Option<String> {
    inner
        .outgoing_text
        .as_ref()
        .map(|state| state.transfer_id.clone())
        .or_else(|| {
            inner
                .incoming_text
                .as_ref()
                .map(|state| state.transfer_id.clone())
        })
        .or_else(|| {
            inner
                .receiving_text
                .as_ref()
                .map(|state| state.transfer_id.clone())
        })
}

fn file_or_text_transfer_active(inner: &super::Inner) -> bool {
    inner.outgoing.is_some()
        || inner.pending_outgoing_recovery.is_some()
        || inner.restoring_outgoing
        || inner.incoming.is_some()
        || inner.pending_recovery.is_some()
        || inner.restoring_transfer.is_some()
        || inner.receive.is_some()
        || active_text_transfer_id(inner).is_some()
}
