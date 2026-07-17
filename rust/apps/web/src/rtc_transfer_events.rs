use dioxus::prelude::*;
use p2p_browser_platform::{RtcEvent, TransferDirection, send_notification};
use p2p_protocol::TransferMode;

use crate::transfer_presentation::{transfer_file, transfer_is_streamed};

use super::{AppModel, RoomRole, Screen, TransferLinkState, TransferState};

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

fn project_transfer_progress(
    current: &TransferState,
    transfer_id: &str,
    direction: TransferDirection,
    completed_bytes: u64,
) -> Option<TransferState> {
    let TransferState::Active {
        transfer_id: current_id,
        direction: current_direction,
        streamed,
        file,
        files,
        completed_bytes: current_bytes,
        awaiting_verification,
        link_state,
        storage_pause,
    } = current
    else {
        return None;
    };
    if current_id != transfer_id
        || *current_direction != direction
        || *awaiting_verification
        || *link_state != TransferLinkState::Ready
        || storage_pause.is_some()
        || completed_bytes < *current_bytes
        || completed_bytes > file.size_bytes
    {
        return None;
    }
    Some(TransferState::Active {
        transfer_id: current_id.clone(),
        direction,
        streamed: *streamed,
        file: file.clone(),
        files: files.clone(),
        completed_bytes,
        awaiting_verification: false,
        link_state: TransferLinkState::Ready,
        storage_pause: None,
    })
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
            let projected = {
                let state = model.read();
                state.transfers_by_peer.get(&peer_id).and_then(|current| {
                    project_transfer_progress(current, &transfer_id, direction, completed_bytes)
                })
            };
            if let Some(projected) = projected {
                set_peer_transfer(&mut model.write(), peer_id, projected);
            }
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

    #[test]
    fn resumed_progress_for_current_active_transfer_moves_forward_and_preserves_metadata() {
        let projected = project_transfer_progress(
            &active_transfer("transfer-current"),
            "transfer-current",
            TransferDirection::Send,
            72,
        )
        .expect("current transfer progress should be projected");

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
        assert!(
            project_transfer_progress(
                &active_transfer("transfer-current"),
                "transfer-stale",
                TransferDirection::Send,
                72,
            )
            .is_none()
        );
    }

    #[test]
    fn progress_for_mismatched_direction_is_ignored() {
        assert!(
            project_transfer_progress(
                &active_transfer("transfer-current"),
                "transfer-current",
                TransferDirection::Receive,
                72,
            )
            .is_none()
        );
    }

    #[test]
    fn progress_while_connection_is_paused_is_ignored() {
        let mut current = active_transfer("transfer-current");
        let TransferState::Active { link_state, .. } = &mut current else {
            unreachable!();
        };
        *link_state = TransferLinkState::Paused;

        assert!(
            project_transfer_progress(&current, "transfer-current", TransferDirection::Send, 72,)
                .is_none()
        );
    }

    #[test]
    fn progress_while_storage_is_paused_is_ignored() {
        let mut current = active_transfer("transfer-current");
        let TransferState::Active { storage_pause, .. } = &mut current else {
            unreachable!();
        };
        *storage_pause = Some(p2p_protocol::StreamPauseReason::DestinationQuotaExceeded);

        assert!(
            project_transfer_progress(&current, "transfer-current", TransferDirection::Send, 72,)
                .is_none()
        );
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

        assert!(
            project_transfer_progress(&current, "transfer-current", TransferDirection::Send, 72,)
                .is_none()
        );
    }

    #[test]
    fn progress_that_moves_backwards_is_ignored() {
        assert!(
            project_transfer_progress(
                &active_transfer("transfer-current"),
                "transfer-current",
                TransferDirection::Send,
                11,
            )
            .is_none()
        );
    }

    #[test]
    fn progress_beyond_summary_size_is_ignored() {
        assert!(
            project_transfer_progress(
                &active_transfer("transfer-current"),
                "transfer-current",
                TransferDirection::Send,
                101,
            )
            .is_none()
        );
    }

    #[test]
    fn progress_for_non_active_transfer_is_ignored() {
        assert!(
            project_transfer_progress(
                &TransferState::Idle,
                "transfer-current",
                TransferDirection::Receive,
                72,
            )
            .is_none()
        );
    }
}
