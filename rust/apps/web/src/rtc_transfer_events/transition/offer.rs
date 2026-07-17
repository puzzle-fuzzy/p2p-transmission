use p2p_protocol::TransferMode;
use p2p_transfer::{TransferDirection, TransferFile};

use super::{NotificationEffect, PlannedTransferEvent};
use crate::app_state::{AppModel, TransferLinkState, TransferState};
use crate::transfer_presentation::transfer_is_streamed;

pub(super) fn outgoing(
    peer_id: String,
    transfer_id: String,
    file: TransferFile,
    files: Vec<TransferFile>,
) -> PlannedTransferEvent {
    PlannedTransferEvent::set_peer_transfer(
        peer_id,
        TransferState::Offering {
            transfer_id,
            file,
            files,
        },
    )
}

pub(super) fn outgoing_recovery(
    peer_id: String,
    transfer_id: String,
    file: TransferFile,
    files: Vec<TransferFile>,
) -> PlannedTransferEvent {
    PlannedTransferEvent::set_peer_transfer(
        peer_id,
        TransferState::OutgoingRecovery {
            transfer_id,
            file,
            files,
        },
    )
}

pub(super) fn incoming(
    peer_id: String,
    transfer_id: String,
    mode: TransferMode,
    file: TransferFile,
    files: Vec<TransferFile>,
    recovery_available: bool,
) -> PlannedTransferEvent {
    let file_count = files.len().max(1);
    let body = if file_count == 1 {
        format!("收到文件：{}", file.name)
    } else {
        format!("收到 {} 等 {file_count} 个文件", file.name)
    };
    let tag = format!("file-{transfer_id}");
    let mut plan = PlannedTransferEvent::set_peer_transfer(
        peer_id,
        TransferState::Incoming {
            transfer_id,
            mode,
            file,
            files,
            recovery_available,
        },
    );
    plan.notification = Some(NotificationEffect {
        title: "收到文件请求".to_owned(),
        body,
        tag,
    });
    plan
}

#[allow(clippy::too_many_arguments)]
pub(super) fn started(
    model: &AppModel,
    peer_id: String,
    transfer_id: String,
    direction: TransferDirection,
    mode: TransferMode,
    file: TransferFile,
    files: Vec<TransferFile>,
) -> PlannedTransferEvent {
    let completed_bytes = model
        .transfers_by_peer
        .get(&peer_id)
        .and_then(|transfer| match transfer {
            TransferState::Active {
                transfer_id: current_id,
                completed_bytes,
                ..
            } if current_id == &transfer_id => Some(*completed_bytes),
            _ => None,
        })
        .unwrap_or(0);
    PlannedTransferEvent::set_peer_transfer(
        peer_id,
        TransferState::Active {
            transfer_id,
            direction,
            streamed: matches!(mode, TransferMode::Streamed { .. }),
            completed_bytes,
            file,
            files,
            awaiting_verification: false,
            link_state: TransferLinkState::Ready,
            storage_pause: None,
        },
    )
}

pub(super) fn awaiting_verification(
    model: &AppModel,
    peer_id: String,
    transfer_id: String,
    file: TransferFile,
    files: Vec<TransferFile>,
) -> PlannedTransferEvent {
    let streamed = model
        .transfers_by_peer
        .get(&peer_id)
        .is_some_and(transfer_is_streamed);
    let completed_bytes = file.size_bytes;
    PlannedTransferEvent::set_peer_transfer(
        peer_id,
        TransferState::Active {
            transfer_id,
            direction: TransferDirection::Send,
            streamed,
            completed_bytes,
            file,
            files,
            awaiting_verification: true,
            link_state: TransferLinkState::Ready,
            storage_pause: None,
        },
    )
}
