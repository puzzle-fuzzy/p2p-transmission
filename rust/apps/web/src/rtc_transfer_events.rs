use dioxus::prelude::*;
use p2p_browser_platform::{RtcEvent, TransferDirection, send_notification};
use p2p_protocol::TransferMode;

use crate::app_state::{AppModel, RoomRole, Screen, TransferLinkState, TransferState};
use crate::transfer_presentation::{transfer_file, transfer_is_streamed};

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

fn apply_transfer_progress(
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

fn apply_peer_transfer_progress(
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

pub(super) fn handle_transfer_event(mut model: Signal<AppModel>, peer_id: String, event: RtcEvent) {
    match event {
        RtcEvent::OutgoingOffered {
            transfer_id,
            file,
            files,
        } => {
            set_peer_transfer(
                &mut model.write(),
                peer_id,
                TransferState::Offering {
                    transfer_id,
                    file,
                    files,
                },
            );
        }
        RtcEvent::OutgoingRecoveryOffered {
            transfer_id,
            file,
            files,
        } => {
            set_peer_transfer(
                &mut model.write(),
                peer_id,
                TransferState::OutgoingRecovery {
                    transfer_id,
                    file,
                    files,
                },
            );
        }
        RtcEvent::IncomingOffered {
            transfer_id,
            mode,
            file,
            files,
            recovery_available,
        } => {
            let file_count = files.len().max(1);
            let body = if file_count == 1 {
                format!("收到文件：{}", file.name)
            } else {
                format!("收到 {} 等 {file_count} 个文件", file.name)
            };
            let _ = send_notification("收到文件请求", &body, &format!("file-{transfer_id}"));
            set_peer_transfer(
                &mut model.write(),
                peer_id,
                TransferState::Incoming {
                    transfer_id,
                    mode,
                    file,
                    files,
                    recovery_available,
                },
            );
        }
        RtcEvent::TransferStarted {
            transfer_id,
            direction,
            mode,
            file,
            files,
        } => {
            let completed_bytes = model
                .read()
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
            set_peer_transfer(
                &mut model.write(),
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
            );
        }
        RtcEvent::TransferProgress {
            transfer_id,
            direction,
            completed_bytes,
            ..
        } => {
            let should_apply = {
                let state = model.peek();
                state
                    .transfers_by_peer
                    .get(&peer_id)
                    .is_some_and(|current| {
                        transfer_progress_is_valid(
                            current,
                            &transfer_id,
                            direction,
                            completed_bytes,
                        )
                    })
            };
            if !should_apply {
                return;
            }
            let mut state = model.write();
            let applied = apply_peer_transfer_progress(
                &mut state,
                &peer_id,
                &transfer_id,
                direction,
                completed_bytes,
            );
            debug_assert!(applied, "validated progress should still be applicable");
        }
        RtcEvent::TransferPaused {
            transfer_id,
            direction,
            reason,
            completed_bytes,
            ..
        } => {
            let paused = {
                let state = model.read();
                state
                    .transfers_by_peer
                    .get(&peer_id)
                    .cloned()
                    .and_then(|mut transfer| {
                        if let TransferState::Active {
                            transfer_id: current_id,
                            direction: current_direction,
                            completed_bytes: current_bytes,
                            awaiting_verification,
                            link_state,
                            storage_pause,
                            ..
                        } = &mut transfer
                            && current_id == &transfer_id
                        {
                            *current_direction = direction;
                            *current_bytes = completed_bytes;
                            *awaiting_verification = false;
                            *link_state = TransferLinkState::Ready;
                            *storage_pause = Some(reason);
                            Some(transfer)
                        } else {
                            None
                        }
                    })
            };
            if let Some(paused) = paused {
                let mut state = model.write();
                state.error = None;
                state.notice = Some(if direction == TransferDirection::Receive {
                    "传输已暂停，最后一个校验检查点已保留".to_owned()
                } else {
                    "接收方已暂停传输，当前进度已保留".to_owned()
                });
                set_peer_transfer(&mut state, peer_id, paused);
            }
        }
        RtcEvent::AwaitingVerification {
            transfer_id,
            file,
            files,
        } => {
            let streamed = model
                .read()
                .transfers_by_peer
                .get(&peer_id)
                .is_some_and(transfer_is_streamed);
            set_peer_transfer(
                &mut model.write(),
                peer_id,
                TransferState::Active {
                    transfer_id,
                    direction: TransferDirection::Send,
                    streamed,
                    completed_bytes: file.size_bytes,
                    file,
                    files,
                    awaiting_verification: true,
                    link_state: TransferLinkState::Ready,
                    storage_pause: None,
                },
            );
        }
        RtcEvent::TransferRejected {
            direction,
            file,
            files,
            ..
        } => {
            set_peer_transfer(
                &mut model.write(),
                peer_id,
                TransferState::Rejected {
                    direction,
                    file,
                    files,
                },
            );
        }
        RtcEvent::TransferCompleted {
            direction,
            file,
            files,
            blake3,
            download_url,
            ..
        } => {
            if direction == TransferDirection::Receive {
                let file_count = files.len().max(1);
                let body = if file_count == 1 {
                    format!("{} 已通过完整性校验", file.name)
                } else {
                    format!("{file_count} 个文件已通过完整性校验")
                };
                let _ =
                    send_notification("文件接收完成", &body, &format!("file-received-{peer_id}"));
            }
            let mut state = model.write();
            state.notice = Some(if direction == TransferDirection::Send {
                "文件已发送并通过接收端校验".to_owned()
            } else if download_url.is_none() {
                "文件已保存并通过完整性校验".to_owned()
            } else {
                "文件已接收并通过完整性校验".to_owned()
            });
            set_peer_transfer(
                &mut state,
                peer_id,
                TransferState::Completed {
                    direction,
                    file,
                    files,
                    blake3,
                    download_url,
                },
            );
        }
        RtcEvent::TransferCancelled { reason, .. } => {
            let file = {
                let state = model.read();
                state
                    .transfers_by_peer
                    .get(&peer_id)
                    .and_then(transfer_file)
                    .cloned()
            };
            set_peer_transfer(
                &mut model.write(),
                peer_id,
                TransferState::Cancelled { file, reason },
            );
        }
        RtcEvent::TransferFailed { message, .. } => {
            let file = {
                let state = model.read();
                state
                    .transfers_by_peer
                    .get(&peer_id)
                    .and_then(transfer_file)
                    .cloned()
            };
            set_peer_transfer(
                &mut model.write(),
                peer_id,
                TransferState::Failed { file, message },
            );
        }
        RtcEvent::OutboundSignal { .. }
        | RtcEvent::ConnectionState(_)
        | RtcEvent::DataChannelReady => {
            unreachable!("control RTC event reached transfer event handler")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use p2p_browser_platform::TransferFile;
    use p2p_protocol::{CURRENT_PROTOCOL, RoomBootstrapResponse};

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
        *storage_pause = Some(p2p_protocol::StreamPauseReason::DestinationQuotaExceeded);

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
}
