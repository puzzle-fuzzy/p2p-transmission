use super::progress::{apply_peer_transfer_progress, apply_transfer_progress};
use super::*;
use crate::app_state::TransferLinkState;
use p2p_protocol::{
    CURRENT_PROTOCOL, CancelReason, RoomBootstrapResponse, StreamPauseReason, TransferMode,
};
use p2p_transfer::{TransferDirection, TransferFile};

fn file(name: &str, size_bytes: u64) -> TransferFile {
    TransferFile {
        name: name.to_owned(),
        mime: Some("application/octet-stream".to_owned()),
        size_bytes,
    }
}

fn active_transfer(transfer_id: &str) -> TransferState {
    let first = file("first.bin", 100);
    TransferState::Active {
        transfer_id: transfer_id.to_owned(),
        direction: TransferDirection::Send,
        streamed: true,
        file: first.clone(),
        files: vec![first, file("second.bin", 200)],
        completed_bytes: 12,
        awaiting_verification: false,
        link_state: TransferLinkState::Ready,
        storage_pause: None,
    }
}

fn room_model(role: RoomRole) -> AppModel {
    let mut model = AppModel {
        screen: Screen::Room {
            role,
            snapshot: RoomBootstrapResponse {
                version: CURRENT_PROTOCOL,
                room_id: "room-1".to_owned(),
                room_code: "ABC234".to_owned(),
                revision: 1,
                expires_at_ms: 1_000,
                participants: Vec::new(),
                pending_join_requests: Vec::new(),
            },
            invite: None,
            invite_request_id: None,
        },
        ..AppModel::default()
    };
    let transfer = active_transfer("transfer-current");
    model
        .transfers_by_peer
        .insert("peer-1".to_owned(), transfer.clone());
    if role == RoomRole::Receiver {
        model.transfer = transfer;
    }
    model
}

fn completed_bytes(transfer: &TransferState) -> Option<u64> {
    let TransferState::Active {
        completed_bytes, ..
    } = transfer
    else {
        return None;
    };
    Some(*completed_bytes)
}

fn apply_event(model: &mut AppModel, peer_id: &str, event: RtcEvent) -> Option<NotificationEffect> {
    let plan = plan_transfer_event(model, peer_id.to_owned(), event);
    let notification = plan.notification().cloned();
    if plan.changes_model() {
        plan.apply(model);
    }
    notification
}

#[test]
fn incoming_offer_plans_notification_and_updates_receiver_aggregate() {
    let mut model = room_model(RoomRole::Receiver);
    let primary = file("request.bin", 90);
    let files = vec![primary.clone()];
    let notification = apply_event(
        &mut model,
        "peer-1",
        RtcEvent::IncomingOffered {
            transfer_id: "incoming-1".to_owned(),
            mode: TransferMode::Buffered,
            file: primary.clone(),
            files: files.clone(),
            recovery_available: false,
        },
    );

    assert_eq!(
        notification,
        Some(NotificationEffect {
            title: "收到文件请求".to_owned(),
            body: "收到文件：request.bin".to_owned(),
            tag: "file-incoming-1".to_owned(),
        })
    );
    let expected = TransferState::Incoming {
        transfer_id: "incoming-1".to_owned(),
        mode: TransferMode::Buffered,
        file: primary,
        files,
        recovery_available: false,
    };
    assert_eq!(model.transfers_by_peer.get("peer-1"), Some(&expected));
    assert_eq!(model.transfer, expected);
}

#[test]
fn transfer_started_restores_progress_for_the_same_active_transfer() {
    let mut model = room_model(RoomRole::Receiver);
    let primary = file("first.bin", 100);
    apply_event(
        &mut model,
        "peer-1",
        RtcEvent::TransferStarted {
            transfer_id: "transfer-current".to_owned(),
            direction: TransferDirection::Send,
            mode: TransferMode::Streamed {
                segment_bytes: 8 * 1024 * 1024,
            },
            file: primary.clone(),
            files: vec![primary],
        },
    );

    let TransferState::Active {
        completed_bytes,
        streamed,
        awaiting_verification,
        storage_pause,
        ..
    } = &model.transfer
    else {
        panic!("started transfer should be active");
    };
    assert_eq!(*completed_bytes, 12);
    assert!(*streamed);
    assert!(!*awaiting_verification);
    assert_eq!(*storage_pause, None);
    assert_eq!(model.transfer, model.transfers_by_peer["peer-1"]);
}

#[test]
fn pause_transition_preserves_checkpoint_and_clears_error() {
    let mut model = room_model(RoomRole::Receiver);
    model.error = Some("old error".to_owned());
    let notification = apply_event(
        &mut model,
        "peer-1",
        RtcEvent::TransferPaused {
            transfer_id: "transfer-current".to_owned(),
            direction: TransferDirection::Receive,
            reason: StreamPauseReason::DestinationQuotaExceeded,
            completed_bytes: 44,
            total_bytes: 100,
        },
    );

    assert_eq!(notification, None);
    assert_eq!(model.error, None);
    assert_eq!(
        model.notice.as_deref(),
        Some("传输已暂停，最后一个校验检查点已保留")
    );
    let TransferState::Active {
        direction,
        completed_bytes,
        storage_pause,
        ..
    } = model
        .transfers_by_peer
        .get("peer-1")
        .expect("paused peer transfer should remain")
    else {
        panic!("pause should keep an active transfer");
    };
    assert_eq!(*direction, TransferDirection::Receive);
    assert_eq!(*completed_bytes, 44);
    assert_eq!(
        *storage_pause,
        Some(StreamPauseReason::DestinationQuotaExceeded)
    );
    assert_eq!(model.transfer, model.transfers_by_peer["peer-1"]);
}

#[test]
fn completed_receive_preserves_download_url_and_plans_notification() {
    let mut model = room_model(RoomRole::Receiver);
    let primary = file("received.bin", 100);
    let files = vec![primary.clone()];
    let notification = apply_event(
        &mut model,
        "peer-1",
        RtcEvent::TransferCompleted {
            transfer_id: "transfer-current".to_owned(),
            direction: TransferDirection::Receive,
            file: primary.clone(),
            files: files.clone(),
            blake3: "digest".to_owned(),
            download_url: Some("blob:download-1".to_owned()),
        },
    );

    assert_eq!(
        notification,
        Some(NotificationEffect {
            title: "文件接收完成".to_owned(),
            body: "received.bin 已通过完整性校验".to_owned(),
            tag: "file-received-peer-1".to_owned(),
        })
    );
    let expected = TransferState::Completed {
        direction: TransferDirection::Receive,
        file: primary,
        files,
        blake3: "digest".to_owned(),
        download_url: Some("blob:download-1".to_owned()),
    };
    assert_eq!(model.transfers_by_peer.get("peer-1"), Some(&expected));
    assert_eq!(model.transfer, expected);
    assert_eq!(model.notice.as_deref(), Some("文件已接收并通过完整性校验"));
}

#[test]
fn owner_terminal_transition_only_updates_peer_map() {
    let mut model = room_model(RoomRole::Owner);
    let primary = file("sent.bin", 100);
    apply_event(
        &mut model,
        "peer-1",
        RtcEvent::TransferCompleted {
            transfer_id: "transfer-current".to_owned(),
            direction: TransferDirection::Send,
            file: primary.clone(),
            files: vec![primary],
            blake3: "digest".to_owned(),
            download_url: None,
        },
    );

    assert!(matches!(
        model.transfers_by_peer.get("peer-1"),
        Some(TransferState::Completed {
            direction: TransferDirection::Send,
            ..
        })
    ));
    assert_eq!(model.transfer, TransferState::Idle);
}

#[test]
fn cancellation_retains_the_current_file_summary() {
    let mut model = room_model(RoomRole::Receiver);
    apply_event(
        &mut model,
        "peer-1",
        RtcEvent::TransferCancelled {
            transfer_id: "transfer-current".to_owned(),
            reason: CancelReason::PeerClosed,
        },
    );

    assert_eq!(
        model.transfer,
        TransferState::Cancelled {
            file: Some(file("first.bin", 100)),
            reason: CancelReason::PeerClosed,
        }
    );
}

#[test]
fn resumed_progress_for_current_active_transfer_moves_forward_and_preserves_metadata() {
    let mut projected = active_transfer("transfer-current");
    assert!(apply_transfer_progress(
        &mut projected,
        "transfer-current",
        TransferDirection::Send,
        72,
    ));

    let TransferState::Active {
        transfer_id,
        direction,
        streamed,
        file: primary_file,
        files,
        completed_bytes,
        awaiting_verification,
        link_state,
        storage_pause,
    } = projected
    else {
        panic!("progress should stay active");
    };
    assert_eq!(transfer_id, "transfer-current");
    assert_eq!(direction, TransferDirection::Send);
    assert!(streamed);
    assert_eq!(primary_file, file("first.bin", 100));
    assert_eq!(files, vec![file("first.bin", 100), file("second.bin", 200)]);
    assert_eq!(completed_bytes, 72);
    assert!(!awaiting_verification);
    assert_eq!(link_state, TransferLinkState::Ready);
    assert_eq!(storage_pause, None);
}

#[test]
fn progress_for_stale_transfer_id_is_ignored() {
    let mut current = active_transfer("transfer-current");
    let before = current.clone();
    assert!(!apply_transfer_progress(
        &mut current,
        "transfer-stale",
        TransferDirection::Send,
        72,
    ));
    assert_eq!(current, before);
}

#[test]
fn progress_for_mismatched_direction_is_ignored() {
    let mut current = active_transfer("transfer-current");
    assert!(!apply_transfer_progress(
        &mut current,
        "transfer-current",
        TransferDirection::Receive,
        72,
    ));
}

#[test]
fn progress_while_connection_is_paused_is_ignored() {
    let mut current = active_transfer("transfer-current");
    let TransferState::Active { link_state, .. } = &mut current else {
        unreachable!();
    };
    *link_state = TransferLinkState::Paused;

    assert!(!apply_transfer_progress(
        &mut current,
        "transfer-current",
        TransferDirection::Send,
        72,
    ));
}

#[test]
fn progress_while_storage_is_paused_is_ignored() {
    let mut current = active_transfer("transfer-current");
    let TransferState::Active { storage_pause, .. } = &mut current else {
        unreachable!();
    };
    *storage_pause = Some(StreamPauseReason::DestinationQuotaExceeded);

    assert!(!apply_transfer_progress(
        &mut current,
        "transfer-current",
        TransferDirection::Send,
        72,
    ));
}

#[test]
fn progress_while_awaiting_verification_is_ignored() {
    let mut current = active_transfer("transfer-current");
    let TransferState::Active {
        awaiting_verification,
        ..
    } = &mut current
    else {
        unreachable!();
    };
    *awaiting_verification = true;

    assert!(!apply_transfer_progress(
        &mut current,
        "transfer-current",
        TransferDirection::Send,
        72,
    ));
}

#[test]
fn progress_that_moves_backwards_is_ignored() {
    let mut current = active_transfer("transfer-current");
    assert!(!apply_transfer_progress(
        &mut current,
        "transfer-current",
        TransferDirection::Send,
        11,
    ));
}

#[test]
fn progress_beyond_summary_size_is_ignored() {
    let mut current = active_transfer("transfer-current");
    assert!(!apply_transfer_progress(
        &mut current,
        "transfer-current",
        TransferDirection::Send,
        101,
    ));
}

#[test]
fn progress_for_non_active_transfer_is_ignored() {
    let mut current = TransferState::Idle;
    assert!(!apply_transfer_progress(
        &mut current,
        "transfer-current",
        TransferDirection::Receive,
        72,
    ));
}

#[test]
fn invalid_progress_plan_does_not_request_a_model_write() {
    let model = room_model(RoomRole::Receiver);
    let plan = plan_transfer_event(
        &model,
        "peer-1".to_owned(),
        RtcEvent::TransferProgress {
            transfer_id: "transfer-stale".to_owned(),
            direction: TransferDirection::Send,
            completed_bytes: 72,
            total_bytes: 100,
        },
    );
    assert!(!plan.changes_model());
    assert_eq!(plan.notification(), None);
}

#[test]
fn receiver_progress_updates_peer_and_aggregate_without_rebuilding_metadata() {
    let mut model = room_model(RoomRole::Receiver);

    assert!(apply_peer_transfer_progress(
        &mut model,
        "peer-1",
        "transfer-current",
        TransferDirection::Send,
        72,
    ));

    assert_eq!(
        model
            .transfers_by_peer
            .get("peer-1")
            .and_then(completed_bytes),
        Some(72)
    );
    assert_eq!(completed_bytes(&model.transfer), Some(72));
}

#[test]
fn owner_progress_leaves_aggregate_transfer_untouched() {
    let mut model = room_model(RoomRole::Owner);

    assert!(apply_peer_transfer_progress(
        &mut model,
        "peer-1",
        "transfer-current",
        TransferDirection::Send,
        72,
    ));

    assert_eq!(
        model
            .transfers_by_peer
            .get("peer-1")
            .and_then(completed_bytes),
        Some(72)
    );
    assert_eq!(model.transfer, TransferState::Idle);
}
