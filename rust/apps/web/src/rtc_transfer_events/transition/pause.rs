use p2p_protocol::StreamPauseReason;
use p2p_transfer::TransferDirection;

use super::{PlannedTransferEvent, TransferMutation};
use crate::app_state::{AppModel, TransferLinkState, TransferState};

pub(super) fn plan(
    model: &AppModel,
    peer_id: String,
    transfer_id: String,
    direction: TransferDirection,
    reason: StreamPauseReason,
    completed_bytes: u64,
) -> PlannedTransferEvent {
    let Some(mut transfer) = model.transfers_by_peer.get(&peer_id).cloned() else {
        return PlannedTransferEvent::none();
    };
    let TransferState::Active {
        transfer_id: current_id,
        direction: current_direction,
        completed_bytes: current_bytes,
        awaiting_verification,
        link_state,
        storage_pause,
        ..
    } = &mut transfer
    else {
        return PlannedTransferEvent::none();
    };
    if current_id != &transfer_id {
        return PlannedTransferEvent::none();
    }

    *current_direction = direction;
    *current_bytes = completed_bytes;
    *awaiting_verification = false;
    *link_state = TransferLinkState::Ready;
    *storage_pause = Some(reason);

    PlannedTransferEvent {
        mutation: Some(TransferMutation::SetPeerTransfer {
            peer_id,
            transfer,
            notice: Some(
                if direction == TransferDirection::Receive {
                    "传输已暂停，最后一个校验检查点已保留"
                } else {
                    "接收方已暂停传输，当前进度已保留"
                }
                .to_owned(),
            ),
            clear_error: true,
        }),
        notification: None,
    }
}
