use p2p_transfer::TransferDirection;

use super::{PlannedTransferEvent, TransferMutation};
use crate::app_state::{AppModel, RoomRole, Screen, TransferLinkState, TransferState};

pub(super) fn plan(
    model: &AppModel,
    peer_id: String,
    transfer_id: String,
    direction: TransferDirection,
    completed_bytes: u64,
) -> PlannedTransferEvent {
    let Some(current) = model.transfers_by_peer.get(&peer_id) else {
        return PlannedTransferEvent::none();
    };
    if !transfer_progress_is_valid(current, &transfer_id, direction, completed_bytes) {
        return PlannedTransferEvent::none();
    }
    PlannedTransferEvent {
        mutation: Some(TransferMutation::Progress {
            peer_id,
            transfer_id,
            direction,
            completed_bytes,
        }),
        notification: None,
    }
}

fn transfer_progress_is_valid(
    current: &TransferState,
    transfer_id: &str,
    direction: TransferDirection,
    completed_bytes: u64,
) -> bool {
    let TransferState::Active {
        transfer_id: current_id,
        direction: current_direction,
        file,
        completed_bytes: current_bytes,
        awaiting_verification,
        link_state,
        storage_pause,
        ..
    } = current
    else {
        return false;
    };
    current_id == transfer_id
        && *current_direction == direction
        && !*awaiting_verification
        && *link_state == TransferLinkState::Ready
        && storage_pause.is_none()
        && completed_bytes >= *current_bytes
        && completed_bytes <= file.size_bytes
}

pub(super) fn apply_transfer_progress(
    current: &mut TransferState,
    transfer_id: &str,
    direction: TransferDirection,
    completed_bytes: u64,
) -> bool {
    if !transfer_progress_is_valid(current, transfer_id, direction, completed_bytes) {
        return false;
    }
    let TransferState::Active {
        completed_bytes: current_bytes,
        ..
    } = current
    else {
        unreachable!("validated transfer progress must target an active transfer")
    };
    *current_bytes = completed_bytes;
    true
}

pub(super) fn apply_peer_transfer_progress(
    model: &mut AppModel,
    peer_id: &str,
    transfer_id: &str,
    direction: TransferDirection,
    completed_bytes: u64,
) -> bool {
    let is_receiver = matches!(
        model.screen,
        Screen::Room {
            role: RoomRole::Receiver,
            ..
        }
    );
    let Some(current) = model.transfers_by_peer.get_mut(peer_id) else {
        return false;
    };
    if !apply_transfer_progress(current, transfer_id, direction, completed_bytes) {
        return false;
    }
    if is_receiver
        && !apply_transfer_progress(&mut model.transfer, transfer_id, direction, completed_bytes)
    {
        model.transfer = model
            .transfers_by_peer
            .get(peer_id)
            .expect("updated receiver transfer should remain available")
            .clone();
    }
    true
}
