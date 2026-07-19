mod offer;
mod pause;
mod progress;
mod terminal;

use p2p_browser_platform::RtcEvent;
use p2p_transfer::TransferDirection;

use crate::app_state::{AppModel, RoomRole, Screen, TransferState};

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct NotificationEffect {
    pub(super) title: String,
    pub(super) body: String,
    pub(super) tag: String,
}

enum TransferMutation {
    SetPeerTransfer {
        peer_id: String,
        transfer: TransferState,
        notice: Option<String>,
        clear_error: bool,
    },
    Progress {
        peer_id: String,
        transfer_id: String,
        direction: TransferDirection,
        completed_bytes: u64,
    },
}

pub(super) struct PlannedTransferEvent {
    mutation: Option<TransferMutation>,
    notification: Option<NotificationEffect>,
}

impl PlannedTransferEvent {
    fn none() -> Self {
        Self {
            mutation: None,
            notification: None,
        }
    }

    fn set_peer_transfer(peer_id: String, transfer: TransferState) -> Self {
        Self {
            mutation: Some(TransferMutation::SetPeerTransfer {
                peer_id,
                transfer,
                notice: None,
                clear_error: false,
            }),
            notification: None,
        }
    }

    pub(super) fn notification(&self) -> Option<&NotificationEffect> {
        self.notification.as_ref()
    }

    pub(super) fn changes_model(&self) -> bool {
        self.mutation.is_some()
    }

    pub(super) fn apply(self, model: &mut AppModel) {
        let Some(mutation) = self.mutation else {
            return;
        };
        match mutation {
            TransferMutation::SetPeerTransfer {
                peer_id,
                transfer,
                notice,
                clear_error,
            } => {
                if clear_error {
                    model.error = None;
                }
                if let Some(notice) = notice {
                    model.notice = Some(notice);
                }
                set_peer_transfer(model, peer_id, transfer);
            }
            TransferMutation::Progress {
                peer_id,
                transfer_id,
                direction,
                completed_bytes,
            } => {
                let applied = progress::apply_peer_transfer_progress(
                    model,
                    &peer_id,
                    &transfer_id,
                    direction,
                    completed_bytes,
                );
                debug_assert!(applied, "validated progress should still be applicable");
            }
        }
    }
}

pub(super) fn plan_transfer_event(
    model: &AppModel,
    peer_id: String,
    event: RtcEvent,
) -> PlannedTransferEvent {
    match event {
        RtcEvent::OutgoingOffered {
            transfer_id,
            file,
            files,
        } => offer::outgoing(peer_id, transfer_id, file, files),
        RtcEvent::OutgoingRecoveryOffered {
            transfer_id,
            file,
            files,
        } => offer::outgoing_recovery(peer_id, transfer_id, file, files),
        RtcEvent::IncomingOffered {
            transfer_id,
            mode,
            file,
            files,
            recovery_available,
        } => offer::incoming(peer_id, transfer_id, mode, file, files, recovery_available),
        RtcEvent::TransferStarted {
            transfer_id,
            direction,
            mode,
            file,
            files,
        } => offer::started(model, peer_id, transfer_id, direction, mode, file, files),
        RtcEvent::AwaitingVerification {
            transfer_id,
            file,
            files,
        } => offer::awaiting_verification(model, peer_id, transfer_id, file, files),
        RtcEvent::TransferProgress {
            transfer_id,
            direction,
            completed_bytes,
            ..
        } => progress::plan(model, peer_id, transfer_id, direction, completed_bytes),
        RtcEvent::TransferPaused {
            transfer_id,
            direction,
            reason,
            completed_bytes,
            ..
        } => pause::plan(
            model,
            peer_id,
            transfer_id,
            direction,
            reason,
            completed_bytes,
        ),
        RtcEvent::TransferRejected {
            direction,
            file,
            files,
            ..
        } => terminal::rejected(peer_id, direction, file, files),
        RtcEvent::TransferCompleted {
            direction,
            file,
            files,
            blake3,
            download_url,
            ..
        } => terminal::completed(peer_id, direction, file, files, blake3, download_url),
        RtcEvent::TransferCancelled { reason, .. } => terminal::cancelled(model, peer_id, reason),
        RtcEvent::TransferFailed { message, .. } => terminal::failed(model, peer_id, message),
        RtcEvent::OutboundSignal { .. }
        | RtcEvent::ConnectionState(_)
        | RtcEvent::DataChannelReady
        | RtcEvent::NegotiationFailed { .. }
        | RtcEvent::TextOutgoingOffered { .. }
        | RtcEvent::TextIncomingOffered { .. }
        | RtcEvent::TextTransferAccepted { .. }
        | RtcEvent::TextTransferRejected { .. }
        | RtcEvent::TextTransferReceived { .. }
        | RtcEvent::TextTransferDelivered { .. }
        | RtcEvent::TextTransferCancelled { .. }
        | RtcEvent::TextTransferFailed { .. } => {
            unreachable!("control RTC event reached transfer event handler")
        }
    }
}

fn set_peer_transfer(model: &mut AppModel, peer_id: String, transfer: TransferState) {
    model.transfers_by_peer.insert(peer_id, transfer.clone());
    if matches!(
        model.screen,
        Screen::Room {
            role: RoomRole::Receiver,
            ..
        }
    ) {
        model.transfer = transfer;
    }
}

#[cfg(test)]
mod tests;
