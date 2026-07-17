use p2p_protocol::CancelReason;
use p2p_transfer::{TransferDirection, TransferFile};

use super::{NotificationEffect, PlannedTransferEvent, TransferMutation};
use crate::app_state::{AppModel, TransferState};
use crate::transfer_presentation::transfer_file;

pub(super) fn rejected(
    peer_id: String,
    direction: TransferDirection,
    file: TransferFile,
    files: Vec<TransferFile>,
) -> PlannedTransferEvent {
    PlannedTransferEvent::set_peer_transfer(
        peer_id,
        TransferState::Rejected {
            direction,
            file,
            files,
        },
    )
}

pub(super) fn completed(
    peer_id: String,
    direction: TransferDirection,
    file: TransferFile,
    files: Vec<TransferFile>,
    blake3: String,
    download_url: Option<String>,
) -> PlannedTransferEvent {
    let notification = (direction == TransferDirection::Receive).then(|| {
        let file_count = files.len().max(1);
        let body = if file_count == 1 {
            format!("{} 已通过完整性校验", file.name)
        } else {
            format!("{file_count} 个文件已通过完整性校验")
        };
        NotificationEffect {
            title: "文件接收完成".to_owned(),
            body,
            tag: format!("file-received-{peer_id}"),
        }
    });
    let notice = if direction == TransferDirection::Send {
        "文件已发送并通过接收端校验"
    } else if download_url.is_none() {
        "文件已保存并通过完整性校验"
    } else {
        "文件已接收并通过完整性校验"
    }
    .to_owned();
    PlannedTransferEvent {
        mutation: Some(TransferMutation::SetPeerTransfer {
            peer_id,
            transfer: TransferState::Completed {
                direction,
                file,
                files,
                blake3,
                download_url,
            },
            notice: Some(notice),
            clear_error: false,
        }),
        notification,
    }
}

pub(super) fn cancelled(
    model: &AppModel,
    peer_id: String,
    reason: CancelReason,
) -> PlannedTransferEvent {
    let file = model
        .transfers_by_peer
        .get(&peer_id)
        .and_then(transfer_file)
        .cloned();
    PlannedTransferEvent::set_peer_transfer(peer_id, TransferState::Cancelled { file, reason })
}

pub(super) fn failed(model: &AppModel, peer_id: String, message: String) -> PlannedTransferEvent {
    let file = model
        .transfers_by_peer
        .get(&peer_id)
        .and_then(transfer_file)
        .cloned();
    PlannedTransferEvent::set_peer_transfer(peer_id, TransferState::Failed { file, message })
}
