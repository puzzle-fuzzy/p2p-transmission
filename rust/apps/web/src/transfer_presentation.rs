use super::{RoomRole, RtcPhase, TransferLinkState, TransferState};
use p2p_browser_platform::{TransferDirection, TransferFile};
use p2p_protocol::{CancelReason, StreamPauseReason, TransferMode};

pub(super) fn transfer_is_active(transfer: &TransferState) -> bool {
    matches!(
        transfer,
        TransferState::Offering { .. }
            | TransferState::OutgoingRecovery { .. }
            | TransferState::Active { .. }
    )
}

pub(super) fn transfer_progress(transfer: &TransferState) -> (u64, u64, f64) {
    let Some(file) = transfer_file(transfer) else {
        return (0, 0, 0.0);
    };
    let completed = match transfer {
        TransferState::Active {
            completed_bytes, ..
        } => *completed_bytes,
        TransferState::Completed { .. } => file.size_bytes,
        _ => 0,
    };
    let progress = if file.size_bytes == 0 && transfer_is_active(transfer) {
        100.0
    } else if file.size_bytes == 0 {
        0.0
    } else {
        (completed as f64 / file.size_bytes as f64 * 100.0).clamp(0.0, 100.0)
    };
    (completed, file.size_bytes, progress)
}

pub(super) fn owner_transfer_progress(transfers: &[TransferState]) -> (u64, u64, f64) {
    let (completed, total) = transfers.iter().fold((0_u64, 0_u64), |result, transfer| {
        let (completed, total, _) = transfer_progress(transfer);
        (
            result.0.saturating_add(completed),
            result.1.saturating_add(total),
        )
    });
    let progress = if total == 0 && !transfers.is_empty() {
        100.0
    } else if total == 0 {
        0.0
    } else {
        (completed as f64 / total as f64 * 100.0).clamp(0.0, 100.0)
    };
    (completed, total, progress)
}

pub(super) fn transfer_file_progress(
    transfer: &TransferState,
    files: &[TransferFile],
    index: usize,
) -> f64 {
    let Some(file) = files.get(index) else {
        return 0.0;
    };
    let preceding_bytes = files
        .iter()
        .take(index)
        .fold(0_u64, |total, file| total.saturating_add(file.size_bytes));
    let (completed_bytes, _, _) = transfer_progress(transfer);
    if file.size_bytes == 0 {
        return if matches!(transfer, TransferState::Completed { .. })
            || matches!(transfer, TransferState::Active { .. })
                && completed_bytes >= preceding_bytes
        {
            1.0
        } else {
            0.0
        };
    }

    let file_completed_bytes = completed_bytes
        .saturating_sub(preceding_bytes)
        .min(file.size_bytes);
    (file_completed_bytes as f64 / file.size_bytes as f64).clamp(0.0, 1.0)
}

pub(super) fn owner_transfer_file_progress(
    transfers: &[TransferState],
    files: &[TransferFile],
    index: usize,
) -> f64 {
    if transfers.is_empty() {
        return 0.0;
    }
    let progress = transfers
        .iter()
        .map(|transfer| transfer_file_progress(transfer, files, index))
        .sum::<f64>()
        / transfers.len() as f64;
    progress.clamp(0.0, 1.0)
}

pub(super) fn transfer_progress_value_text(transfer: &TransferState, progress: f64) -> String {
    match transfer {
        TransferState::Idle => "尚未开始".to_owned(),
        TransferState::Offering { .. } => "等待接收者确认".to_owned(),
        TransferState::OutgoingRecovery { .. } => "等待恢复传输".to_owned(),
        TransferState::Incoming { .. } => "等待确认接收".to_owned(),
        TransferState::Active {
            awaiting_verification: true,
            ..
        } => "传输完成，正在校验".to_owned(),
        TransferState::Active { .. } => format!("已传输 {:.0}%", progress.clamp(0.0, 100.0)),
        TransferState::Rejected { .. } => "传输已拒绝".to_owned(),
        TransferState::Completed { .. } => "传输已完成".to_owned(),
        TransferState::Cancelled { .. } => "传输已取消".to_owned(),
        TransferState::Failed { .. } => "传输失败".to_owned(),
    }
}

pub(super) fn owner_transfer_progress_value_text(
    transfers: &[TransferState],
    progress: f64,
) -> String {
    if transfers.is_empty() {
        return "尚未开始".to_owned();
    }
    if transfers
        .iter()
        .all(|transfer| matches!(transfer, TransferState::Completed { .. }))
    {
        return "全部传输完成".to_owned();
    }
    if transfers
        .iter()
        .any(|transfer| matches!(transfer, TransferState::Active { .. }))
    {
        return format!("平均已传输 {:.0}%", progress.clamp(0.0, 100.0));
    }
    if transfers.iter().all(|transfer| {
        matches!(
            transfer,
            TransferState::Completed { .. }
                | TransferState::Rejected { .. }
                | TransferState::Cancelled { .. }
                | TransferState::Failed { .. }
        )
    }) {
        return format!(
            "本次传输已结束，平均完成 {:.0}%",
            progress.clamp(0.0, 100.0)
        );
    }
    "等待接收者确认".to_owned()
}

pub(super) fn completed_transfer_hash(transfers: &[TransferState]) -> Option<String> {
    if transfers.is_empty()
        || transfers
            .iter()
            .any(|transfer| !matches!(transfer, TransferState::Completed { .. }))
    {
        return None;
    }
    transfers.iter().find_map(|transfer| {
        if let TransferState::Completed { blake3, .. } = transfer {
            Some(blake3.clone())
        } else {
            None
        }
    })
}

pub(super) fn receiver_transfer_status(transfer: Option<&TransferState>) -> String {
    match transfer {
        Some(TransferState::Offering { .. }) => "等待确认".to_owned(),
        Some(TransferState::OutgoingRecovery { .. }) => "等待继续".to_owned(),
        Some(TransferState::Active {
            awaiting_verification: true,
            ..
        }) => "校验中".to_owned(),
        Some(TransferState::Active {
            storage_pause: Some(_),
            ..
        }) => "接收方暂停".to_owned(),
        Some(TransferState::Active {
            link_state: TransferLinkState::Paused,
            ..
        }) => "等待重连".to_owned(),
        Some(TransferState::Active {
            link_state: TransferLinkState::Waiting,
            ..
        }) => "重连中".to_owned(),
        Some(active @ TransferState::Active { .. }) => {
            let (_, _, progress) = transfer_progress(active);
            format!("{progress:.0}%")
        }
        Some(TransferState::Rejected { .. }) => "已拒绝".to_owned(),
        Some(TransferState::Completed { .. }) => "已完成".to_owned(),
        Some(TransferState::Cancelled { .. }) => "已取消".to_owned(),
        Some(TransferState::Failed { .. }) => "失败".to_owned(),
        Some(TransferState::Incoming { .. }) => "等待处理".to_owned(),
        Some(TransferState::Idle) | None => "正在准备".to_owned(),
    }
}

pub(super) fn owner_transfer_panel_copy(
    receiver_count: usize,
    selected_count: usize,
    ready_count: usize,
    transfers: &[TransferState],
) -> (String, String) {
    if transfers.len() == 1 {
        return transfer_panel_copy(
            RoomRole::Owner,
            receiver_count,
            RtcPhase::Ready,
            &transfers[0],
        );
    }
    if transfers
        .iter()
        .any(|transfer| matches!(transfer, TransferState::OutgoingRecovery { .. }))
    {
        return (
            "继续发送文件".to_owned(),
            "请重新允许读取原文件，传输会从已校验的位置继续。".to_owned(),
        );
    }
    if transfers.iter().any(|transfer| {
        matches!(
            transfer,
            TransferState::Active {
                storage_pause: Some(_),
                ..
            }
        )
    }) {
        return (
            "接收方已暂停".to_owned(),
            "部分接收方需要处理保存位置，其他接收方不受影响。".to_owned(),
        );
    }
    if transfers.iter().any(|transfer| {
        matches!(
            transfer,
            TransferState::Active {
                link_state: TransferLinkState::Paused,
                ..
            }
        )
    }) {
        return (
            "自动重连已暂停".to_owned(),
            "暂时无法恢复部分连接，可以重新连接或取消传输。".to_owned(),
        );
    }
    if transfers.iter().any(|transfer| {
        matches!(
            transfer,
            TransferState::Active {
                link_state: TransferLinkState::Waiting,
                ..
            }
        )
    }) {
        return (
            "等待接收者恢复连接".to_owned(),
            "连接暂时中断，正在从已校验的位置重试。".to_owned(),
        );
    }
    if transfers
        .iter()
        .any(|transfer| matches!(transfer, TransferState::Active { .. }))
    {
        return (
            "正在发送文件".to_owned(),
            format!("各接收者会独立确认和校验，当前共 {} 位。", transfers.len()),
        );
    }
    if transfers
        .iter()
        .any(|transfer| matches!(transfer, TransferState::Offering { .. }))
    {
        return (
            "等待接收者确认".to_owned(),
            format!("已向 {} 位接收者发送请求，结果彼此独立。", transfers.len()),
        );
    }
    if !transfers.is_empty() {
        let completed = transfers
            .iter()
            .filter(|transfer| matches!(transfer, TransferState::Completed { .. }))
            .count();
        let rejected = transfers
            .iter()
            .filter(|transfer| matches!(transfer, TransferState::Rejected { .. }))
            .count();
        let cancelled = transfers
            .iter()
            .filter(|transfer| matches!(transfer, TransferState::Cancelled { .. }))
            .count();
        let failed = transfers
            .iter()
            .filter(|transfer| matches!(transfer, TransferState::Failed { .. }))
            .count();
        return (
            "本次发送已结束".to_owned(),
            format!("完成 {completed} · 拒绝 {rejected} · 取消 {cancelled} · 失败 {failed}"),
        );
    }
    if receiver_count == 0 {
        return (
            "等待接收者加入".to_owned(),
            "分享房间邀请，接收者加入后会显示在上方。".to_owned(),
        );
    }
    if selected_count == 0 {
        return (
            "选择接收者".to_owned(),
            "至少选择一位接收者后才能发送文件。".to_owned(),
        );
    }
    if ready_count < selected_count {
        return (
            "正在建立点对点连接".to_owned(),
            format!("已连接 {ready_count} / {selected_count} 位接收者。"),
        );
    }
    (
        "选择要发送的文件".to_owned(),
        format!("最多选择 10 个文件，将直接发送给已选择的 {selected_count} 位接收者。"),
    )
}

pub(super) fn transfer_file(transfer: &TransferState) -> Option<&TransferFile> {
    match transfer {
        TransferState::Offering { file, .. }
        | TransferState::OutgoingRecovery { file, .. }
        | TransferState::Incoming { file, .. }
        | TransferState::Active { file, .. }
        | TransferState::Rejected { file, .. }
        | TransferState::Completed { file, .. } => Some(file),
        TransferState::Cancelled { file, .. } | TransferState::Failed { file, .. } => file.as_ref(),
        TransferState::Idle => None,
    }
}

pub(super) fn transfer_files(transfer: &TransferState) -> Option<&[TransferFile]> {
    match transfer {
        TransferState::Offering { files, .. }
        | TransferState::OutgoingRecovery { files, .. }
        | TransferState::Incoming { files, .. }
        | TransferState::Active { files, .. }
        | TransferState::Rejected { files, .. }
        | TransferState::Completed { files, .. } => Some(files),
        TransferState::Cancelled { .. } | TransferState::Failed { .. } | TransferState::Idle => {
            None
        }
    }
}

pub(super) fn transfer_is_streamed(transfer: &TransferState) -> bool {
    match transfer {
        TransferState::OutgoingRecovery { .. } => true,
        TransferState::Incoming { mode, .. } => matches!(mode, TransferMode::Streamed { .. }),
        TransferState::Active { streamed, .. } => *streamed,
        TransferState::Completed {
            direction: TransferDirection::Receive,
            download_url,
            ..
        } => download_url.is_none(),
        _ => false,
    }
}

pub(super) fn transfer_panel_copy(
    role: RoomRole,
    receiver_count: usize,
    rtc: RtcPhase,
    transfer: &TransferState,
) -> (String, String) {
    match transfer {
        TransferState::Offering { .. } => (
            "等待接收者确认".to_owned(),
            "接收者确认后才会开始传输文件。".to_owned(),
        ),
        TransferState::OutgoingRecovery { .. } => (
            "继续发送文件".to_owned(),
            "请重新允许读取原文件，传输会从已校验的位置继续。".to_owned(),
        ),
        TransferState::Incoming { .. } => (
            "收到文件请求".to_owned(),
            "确认文件信息后选择是否接收。".to_owned(),
        ),
        TransferState::Active {
            direction,
            awaiting_verification,
            link_state,
            storage_pause,
            ..
        } => {
            if let Some(reason) = storage_pause {
                match (role, reason) {
                    (RoomRole::Receiver, StreamPauseReason::DestinationQuotaExceeded) => (
                        "存储空间不足".to_owned(),
                        "已保留最后一个校验检查点，释放空间后可以继续接收。".to_owned(),
                    ),
                    (RoomRole::Receiver, StreamPauseReason::DestinationPermissionDenied) => (
                        "保存权限已失效".to_owned(),
                        "已保留最后一个校验检查点，重新授权后可以继续接收。".to_owned(),
                    ),
                    (RoomRole::Owner, StreamPauseReason::DestinationQuotaExceeded) => (
                        "接收方存储空间不足".to_owned(),
                        "已暂停发送并保留进度，接收方处理后会从检查点继续。".to_owned(),
                    ),
                    (RoomRole::Owner, StreamPauseReason::DestinationPermissionDenied) => (
                        "接收方保存权限已失效".to_owned(),
                        "已暂停发送并保留进度，接收方重新授权后会从检查点继续。".to_owned(),
                    ),
                }
            } else if *link_state == TransferLinkState::Paused {
                let description = if role == RoomRole::Owner {
                    "暂时无法恢复连接，可以重新连接或取消传输。"
                } else {
                    "请等待发送者重新连接，或取消本次传输。"
                };
                ("自动重连已暂停".to_owned(), description.to_owned())
            } else if *link_state == TransferLinkState::Waiting {
                (
                    "等待对端恢复".to_owned(),
                    "连接暂时中断，正在从已校验的位置重试。".to_owned(),
                )
            } else if *awaiting_verification {
                (
                    "等待完整性校验".to_owned(),
                    "文件已经发送，正在等待接收端确认 BLAKE3 校验结果。".to_owned(),
                )
            } else if *direction == TransferDirection::Send {
                (
                    "正在发送文件".to_owned(),
                    "请保持当前页面打开，传输数据不会经过应用服务器。".to_owned(),
                )
            } else {
                let description = if transfer_is_streamed(transfer) {
                    "文件正在直接写入所选位置，请保持页面打开。"
                } else {
                    "接收完成并通过校验后才会提供保存按钮。"
                };
                ("正在接收文件".to_owned(), description.to_owned())
            }
        }
        TransferState::Rejected { direction, .. } => {
            let title = if *direction == TransferDirection::Send {
                "接收者已拒绝"
            } else {
                "已拒绝接收"
            };
            (
                title.to_owned(),
                "可以继续留在房间中等待下一次传输。".to_owned(),
            )
        }
        TransferState::Completed {
            direction,
            download_url,
            ..
        } => {
            let title = if *direction == TransferDirection::Send {
                "文件发送完成"
            } else {
                "文件接收完成"
            };
            let description = if *direction == TransferDirection::Receive && download_url.is_none()
            {
                "文件已保存到所选位置，字节数和 BLAKE3 校验均已通过。"
            } else {
                "文件字节数和 BLAKE3 完整性校验均已通过。"
            };
            (title.to_owned(), description.to_owned())
        }
        TransferState::Cancelled { reason, .. } => (
            "传输已取消".to_owned(),
            format!("{}，可以继续使用当前房间。", cancel_reason_copy(*reason)),
        ),
        TransferState::Failed { message, .. } => ("传输失败".to_owned(), message.clone()),
        TransferState::Idle => {
            if role == RoomRole::Owner && receiver_count == 0 {
                return (
                    "等待接收者加入".to_owned(),
                    "分享房间邀请，接收者加入后会显示在上方。".to_owned(),
                );
            }
            if receiver_count > 1 && role == RoomRole::Owner {
                return (
                    "当前支持单接收者".to_owned(),
                    "一个房间一次只向一位在线接收者发送文件。".to_owned(),
                );
            }
            match rtc {
                RtcPhase::Ready if role == RoomRole::Owner => (
                    "选择要发送的文件".to_owned(),
                    "文件通过加密的 WebRTC DataChannel 直接发送。".to_owned(),
                ),
                RtcPhase::Ready => (
                    "等待对方发送".to_owned(),
                    "收到文件请求后，你可以确认或拒绝。".to_owned(),
                ),
                RtcPhase::Failed => (
                    "点对点连接失败".to_owned(),
                    "请保持页面打开，或退出房间后重新连接。".to_owned(),
                ),
                RtcPhase::Disconnected => (
                    "点对点连接已断开".to_owned(),
                    "正在等待房间连接恢复。".to_owned(),
                ),
                RtcPhase::Inactive | RtcPhase::WaitingPeer | RtcPhase::Connecting => (
                    "正在建立点对点连接".to_owned(),
                    "连接就绪后即可开始传输文件。".to_owned(),
                ),
            }
        }
    }
}

fn cancel_reason_copy(reason: CancelReason) -> &'static str {
    match reason {
        CancelReason::SenderCancelled => "发送者取消了本次传输",
        CancelReason::ReceiverCancelled => "接收者取消了本次传输",
        CancelReason::Timeout => "本次传输已经超时",
        CancelReason::PeerClosed => "对方的点对点连接已经关闭",
    }
}

pub(super) fn format_bytes(bytes: u64) -> String {
    const KIB: f64 = 1024.0;
    const MIB: f64 = KIB * 1024.0;
    const GIB: f64 = MIB * 1024.0;
    let value = bytes as f64;
    if value >= GIB {
        format!("{:.2} GiB", value / GIB)
    } else if value >= MIB {
        format!("{:.2} MiB", value / MIB)
    } else if value >= KIB {
        format!("{:.1} KiB", value / KIB)
    } else {
        format!("{bytes} B")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file() -> TransferFile {
        TransferFile {
            name: "example.bin".to_owned(),
            mime: Some("application/octet-stream".to_owned()),
            size_bytes: 100,
        }
    }

    #[test]
    fn multi_receiver_summary_keeps_terminal_outcomes_independent() {
        let transfers = vec![
            TransferState::Completed {
                direction: TransferDirection::Send,
                file: file(),
                files: vec![file()],
                blake3: "a".repeat(64),
                download_url: None,
            },
            TransferState::Rejected {
                direction: TransferDirection::Send,
                file: file(),
                files: vec![file()],
            },
        ];

        assert_eq!(
            owner_transfer_panel_copy(2, 2, 2, &transfers),
            (
                "本次发送已结束".to_owned(),
                "完成 1 · 拒绝 1 · 取消 0 · 失败 0".to_owned(),
            )
        );
        assert_eq!(receiver_transfer_status(transfers.first()), "已完成");
        assert_eq!(receiver_transfer_status(transfers.get(1)), "已拒绝");
    }

    #[test]
    fn aggregate_progress_counts_each_receiver_without_overstating_completion() {
        let transfers = vec![
            TransferState::Completed {
                direction: TransferDirection::Send,
                file: file(),
                files: vec![file()],
                blake3: "b".repeat(64),
                download_url: None,
            },
            TransferState::Active {
                transfer_id: "transfer_2".to_owned(),
                direction: TransferDirection::Send,
                streamed: false,
                file: file(),
                files: vec![file()],
                completed_bytes: 50,
                awaiting_verification: false,
                link_state: TransferLinkState::Ready,
                storage_pause: None,
            },
        ];

        assert_eq!(owner_transfer_progress(&transfers), (150, 200, 75.0));
        assert!(completed_transfer_hash(&transfers).is_none());
    }

    #[test]
    fn batch_file_progress_fills_each_row_in_sequence() {
        let files = vec![
            file(),
            TransferFile {
                name: "second.bin".to_owned(),
                mime: None,
                size_bytes: 300,
            },
        ];
        let transfer = TransferState::Active {
            transfer_id: "transfer_batch".to_owned(),
            direction: TransferDirection::Send,
            streamed: false,
            file: TransferFile {
                name: "2 个文件".to_owned(),
                mime: None,
                size_bytes: 400,
            },
            files: files.clone(),
            completed_bytes: 150,
            awaiting_verification: false,
            link_state: TransferLinkState::Ready,
            storage_pause: None,
        };

        assert_eq!(transfer_file_progress(&transfer, &files, 0), 1.0);
        assert!((transfer_file_progress(&transfer, &files, 1) - (1.0 / 6.0)).abs() < f64::EPSILON);
    }

    #[test]
    fn zero_byte_batch_file_waits_for_preceding_bytes() {
        let files = vec![
            file(),
            TransferFile {
                name: "empty.bin".to_owned(),
                mime: None,
                size_bytes: 0,
            },
        ];
        let mut transfer = TransferState::Active {
            transfer_id: "transfer_zero".to_owned(),
            direction: TransferDirection::Send,
            streamed: false,
            file: file(),
            files: files.clone(),
            completed_bytes: 50,
            awaiting_verification: false,
            link_state: TransferLinkState::Ready,
            storage_pause: None,
        };

        assert_eq!(transfer_file_progress(&transfer, &files, 1), 0.0);
        if let TransferState::Active {
            completed_bytes, ..
        } = &mut transfer
        {
            *completed_bytes = 100;
        }
        assert_eq!(transfer_file_progress(&transfer, &files, 1), 1.0);
    }

    #[test]
    fn owner_file_progress_averages_receivers_and_describes_terminal_results() {
        let files = vec![
            file(),
            TransferFile {
                name: "second.bin".to_owned(),
                mime: None,
                size_bytes: 300,
            },
        ];
        let active = |id: &str, completed_bytes| TransferState::Active {
            transfer_id: id.to_owned(),
            direction: TransferDirection::Send,
            streamed: false,
            file: TransferFile {
                name: "2 个文件".to_owned(),
                mime: None,
                size_bytes: 400,
            },
            files: files.clone(),
            completed_bytes,
            awaiting_verification: false,
            link_state: TransferLinkState::Ready,
            storage_pause: None,
        };
        let active_transfers = vec![active("transfer_1", 150), active("transfer_2", 50)];

        assert_eq!(
            owner_transfer_file_progress(&active_transfers, &files, 0),
            0.75
        );
        assert!(
            (owner_transfer_file_progress(&active_transfers, &files, 1) - (1.0 / 12.0)).abs()
                < f64::EPSILON
        );

        let terminal_transfers = vec![
            TransferState::Completed {
                direction: TransferDirection::Send,
                file: file(),
                files: files.clone(),
                blake3: "d".repeat(64),
                download_url: None,
            },
            TransferState::Rejected {
                direction: TransferDirection::Send,
                file: file(),
                files: files.clone(),
            },
        ];
        assert_eq!(
            owner_transfer_file_progress(&terminal_transfers, &files, 0),
            0.5
        );
        assert_eq!(
            owner_transfer_progress_value_text(&terminal_transfers, 50.0),
            "本次传输已结束，平均完成 50%"
        );
        assert_eq!(
            transfer_progress_value_text(&terminal_transfers[1], 0.0),
            "传输已拒绝"
        );
    }

    #[test]
    fn paused_stream_keeps_progress_and_exposes_recovery_copy() {
        let transfer = TransferState::Active {
            transfer_id: "transfer_paused".to_owned(),
            direction: TransferDirection::Send,
            streamed: true,
            file: file(),
            files: vec![file()],
            completed_bytes: 50,
            awaiting_verification: false,
            link_state: TransferLinkState::Paused,
            storage_pause: None,
        };

        assert_eq!(transfer_progress(&transfer), (50, 100, 50.0));
        assert_eq!(receiver_transfer_status(Some(&transfer)), "等待重连");
        assert_eq!(
            transfer_panel_copy(RoomRole::Owner, 1, RtcPhase::Failed, &transfer),
            (
                "自动重连已暂停".to_owned(),
                "暂时无法恢复连接，可以重新连接或取消传输。".to_owned(),
            )
        );
    }

    #[test]
    fn storage_pause_keeps_checkpoint_and_specific_recovery_copy() {
        let transfer = TransferState::Active {
            transfer_id: "transfer_storage_paused".to_owned(),
            direction: TransferDirection::Receive,
            streamed: true,
            file: file(),
            files: vec![file()],
            completed_bytes: 50,
            awaiting_verification: false,
            link_state: TransferLinkState::Ready,
            storage_pause: Some(StreamPauseReason::DestinationQuotaExceeded),
        };

        assert_eq!(transfer_progress(&transfer), (50, 100, 50.0));
        assert_eq!(receiver_transfer_status(Some(&transfer)), "接收方暂停");
        assert_eq!(
            transfer_panel_copy(RoomRole::Receiver, 1, RtcPhase::Ready, &transfer),
            (
                "存储空间不足".to_owned(),
                "已保留最后一个校验检查点，释放空间后可以继续接收。".to_owned(),
            )
        );
    }

    #[test]
    fn one_storage_paused_receiver_does_not_hide_other_terminal_results() {
        let paused = TransferState::Active {
            transfer_id: "transfer_paused".to_owned(),
            direction: TransferDirection::Send,
            streamed: true,
            file: file(),
            files: vec![file()],
            completed_bytes: 40,
            awaiting_verification: false,
            link_state: TransferLinkState::Ready,
            storage_pause: Some(StreamPauseReason::DestinationPermissionDenied),
        };
        let completed = TransferState::Completed {
            direction: TransferDirection::Send,
            file: file(),
            files: vec![file()],
            blake3: "c".repeat(64),
            download_url: None,
        };

        assert_eq!(
            owner_transfer_panel_copy(2, 2, 2, &[paused, completed]),
            (
                "接收方已暂停".to_owned(),
                "部分接收方需要处理保存位置，其他接收方不受影响。".to_owned(),
            )
        );
    }
}
