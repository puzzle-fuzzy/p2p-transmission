use std::collections::{BTreeMap, BTreeSet};

use p2p_browser_platform::{TransferDirection, TransferFile};
use p2p_protocol::{ParticipantSnapshot, StreamPauseReason, TransferMode};

use super::PeerRtcPresentation;
use crate::app_state::{RoomRole, RtcConfigPhase, RtcPhase, TransferLinkState, TransferState};
use crate::transfer_presentation::{
    owner_transfer_file_progress, owner_transfer_panel_copy, owner_transfer_progress,
    owner_transfer_progress_value_text, transfer_file, transfer_file_progress, transfer_files,
    transfer_is_active, transfer_panel_copy, transfer_progress, transfer_progress_value_text,
};

#[derive(Clone, Debug, PartialEq)]
pub(super) struct IncomingTransferRequest {
    pub(super) peer_id: String,
    pub(super) transfer_id: String,
    pub(super) mode: TransferMode,
    pub(super) files: Vec<TransferFile>,
    pub(super) recovery_available: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct StoragePauseRequest {
    pub(super) peer_id: String,
    pub(super) transfer_id: String,
    pub(super) reason: StreamPauseReason,
}

#[derive(Clone, Debug, PartialEq)]
pub(super) struct FileProgressViewModel {
    pub(super) file: Option<TransferFile>,
    pub(super) files: Vec<TransferFile>,
    pub(super) completed_bytes: u64,
    pub(super) total_bytes: u64,
    pub(super) progress: f64,
    pub(super) file_progresses: Vec<f64>,
    pub(super) file_progress_value_texts: Vec<String>,
    pub(super) fallback_file_progress: f64,
    pub(super) fallback_progress_value_text: String,
}

#[derive(Clone, Debug, PartialEq)]
pub(super) struct TransferPanelViewModel {
    pub(super) selected_ids: Vec<String>,
    pub(super) selected_peer_ids: Vec<String>,
    pub(super) current_batch_peer_ids: Vec<String>,
    pub(super) owner_states: Vec<TransferState>,
    pub(super) paused_peer_ids: Vec<String>,
    pub(super) active: bool,
    pub(super) can_offer: bool,
    pub(super) title: String,
    pub(super) description: String,
    pub(super) file_progress: FileProgressViewModel,
    pub(super) incoming_request: Option<IncomingTransferRequest>,
    pub(super) storage_pause_request: Option<StoragePauseRequest>,
    pub(super) selected_summary: String,
}

pub(super) struct TransferPanelViewInput<'a> {
    pub(super) role: RoomRole,
    pub(super) receivers: &'a [ParticipantSnapshot],
    pub(super) rtc_config_phase: RtcConfigPhase,
    pub(super) aggregate_rtc: RtcPhase,
    pub(super) transfer: &'a TransferState,
    pub(super) rtc_peer_presentations: &'a BTreeMap<String, PeerRtcPresentation>,
    pub(super) transfers_by_peer: &'a BTreeMap<String, TransferState>,
    pub(super) selected_receiver_ids: Option<&'a [String]>,
    pub(super) batch_peer_ids: &'a [String],
}

pub(super) fn derive_transfer_panel_view(
    input: TransferPanelViewInput<'_>,
) -> TransferPanelViewModel {
    let receiver_count = input.receivers.len();
    let online_receiver_ids = input
        .receivers
        .iter()
        .map(|receiver| receiver.session_id.clone())
        .collect::<BTreeSet<_>>();
    let selected_ids = input
        .selected_receiver_ids
        .map(<[String]>::to_vec)
        .unwrap_or_else(|| online_receiver_ids.iter().cloned().collect())
        .into_iter()
        .filter(|session_id| online_receiver_ids.contains(session_id))
        .collect::<Vec<_>>();
    let selected_id_set = selected_ids
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    let selected_peer_ids = input
        .receivers
        .iter()
        .filter(|receiver| selected_id_set.contains(receiver.session_id.as_str()))
        .filter_map(|receiver| receiver.peer_id.clone())
        .collect::<Vec<_>>();
    let selected_count = selected_ids.len();
    let ready_count = selected_peer_ids
        .iter()
        .filter(|peer_id| {
            input
                .rtc_peer_presentations
                .get(*peer_id)
                .is_some_and(|peer_state| peer_state.phase == RtcPhase::Ready)
        })
        .count();
    let restoring_selected = selected_peer_ids.iter().any(|peer_id| {
        input
            .rtc_peer_presentations
            .get(peer_id)
            .is_some_and(|peer_state| peer_state.outgoing_recovery_checking)
    });
    let selected_rtc_phases = selected_peer_ids
        .iter()
        .filter_map(|peer_id| {
            input
                .rtc_peer_presentations
                .get(peer_id)
                .map(|peer_state| peer_state.phase)
        })
        .collect::<Vec<_>>();

    let mut current_batch_peer_ids = input.batch_peer_ids.to_vec();
    if current_batch_peer_ids.is_empty() {
        current_batch_peer_ids.extend(
            input
                .transfers_by_peer
                .iter()
                .filter(|(_, transfer)| !matches!(transfer, TransferState::Idle))
                .map(|(peer_id, _)| peer_id.clone()),
        );
    }
    let owner_states = current_batch_peer_ids
        .iter()
        .filter_map(|peer_id| input.transfers_by_peer.get(peer_id).cloned())
        .collect::<Vec<_>>();
    let paused_peer_ids = current_batch_peer_ids
        .iter()
        .filter(|peer_id| {
            matches!(
                input.transfers_by_peer.get(*peer_id),
                Some(TransferState::Active {
                    link_state: TransferLinkState::Paused,
                    ..
                })
            )
        })
        .cloned()
        .collect::<Vec<_>>();
    let owner_active = owner_states.iter().any(transfer_is_active);
    let receiver_active = transfer_is_active(input.transfer);
    let active = if input.role == RoomRole::Owner {
        owner_active
    } else {
        receiver_active
    };
    let can_offer = input.role == RoomRole::Owner
        && input.rtc_config_phase == RtcConfigPhase::Ready
        && selected_count > 0
        && ready_count == selected_count
        && !restoring_selected
        && !owner_active;

    let (title, description) = if input.role == RoomRole::Owner
        && restoring_selected
        && ready_count == selected_count
        && owner_states.is_empty()
    {
        (
            "正在恢复传输状态".to_owned(),
            "正在检查是否有可继续的未完成传输。".to_owned(),
        )
    } else if input.role == RoomRole::Owner {
        owner_transfer_panel_copy(
            receiver_count,
            selected_count,
            input.rtc_config_phase,
            &selected_rtc_phases,
            &owner_states,
        )
    } else {
        transfer_panel_copy(
            input.role,
            receiver_count,
            input.rtc_config_phase,
            input.aggregate_rtc,
            input.transfer,
        )
    };

    let file = if input.role == RoomRole::Owner {
        owner_states.iter().find_map(transfer_file).cloned()
    } else {
        transfer_file(input.transfer).cloned()
    };
    let files = if input.role == RoomRole::Owner {
        owner_states
            .iter()
            .find_map(transfer_files)
            .map(<[TransferFile]>::to_vec)
            .unwrap_or_default()
    } else {
        transfer_files(input.transfer)
            .map(<[TransferFile]>::to_vec)
            .unwrap_or_default()
    };
    let (completed_bytes, total_bytes, progress) = if input.role == RoomRole::Owner {
        owner_transfer_progress(&owner_states)
    } else {
        transfer_progress(input.transfer)
    };
    let file_progresses = files
        .iter()
        .enumerate()
        .map(|(index, _)| {
            if input.role == RoomRole::Owner {
                owner_transfer_file_progress(&owner_states, &files, index)
            } else {
                transfer_file_progress(input.transfer, &files, index)
            }
        })
        .collect::<Vec<_>>();
    let file_progress_value_texts = file_progresses
        .iter()
        .map(|progress| {
            if input.role == RoomRole::Owner {
                owner_transfer_progress_value_text(&owner_states, progress * 100.0)
            } else {
                transfer_progress_value_text(input.transfer, progress * 100.0)
            }
        })
        .collect::<Vec<_>>();
    let fallback_file_progress = progress.clamp(0.0, 100.0) / 100.0;
    let fallback_progress_value_text = if input.role == RoomRole::Owner {
        owner_transfer_progress_value_text(&owner_states, progress)
    } else {
        transfer_progress_value_text(input.transfer, progress)
    };

    let incoming_request = input.transfers_by_peer.iter().find_map(|(peer_id, state)| {
        if let TransferState::Incoming {
            transfer_id,
            mode,
            files,
            recovery_available,
            ..
        } = state
        {
            Some(IncomingTransferRequest {
                peer_id: peer_id.clone(),
                transfer_id: transfer_id.clone(),
                mode: *mode,
                files: files.clone(),
                recovery_available: *recovery_available,
            })
        } else {
            None
        }
    });
    let storage_pause_request = input.transfers_by_peer.iter().find_map(|(peer_id, state)| {
        if let TransferState::Active {
            transfer_id,
            direction: TransferDirection::Receive,
            storage_pause: Some(reason),
            ..
        } = state
        {
            Some(StoragePauseRequest {
                peer_id: peer_id.clone(),
                transfer_id: transfer_id.clone(),
                reason: *reason,
            })
        } else {
            None
        }
    });
    let selected_summary = if selected_ids.len() == receiver_count {
        format!("全部 {} 位", selected_ids.len())
    } else {
        format!("{} 位", selected_ids.len())
    };

    TransferPanelViewModel {
        selected_ids,
        selected_peer_ids,
        current_batch_peer_ids,
        owner_states,
        paused_peer_ids,
        active,
        can_offer,
        title,
        description,
        file_progress: FileProgressViewModel {
            file,
            files,
            completed_bytes,
            total_bytes,
            progress,
            file_progresses,
            file_progress_value_texts,
            fallback_file_progress,
            fallback_progress_value_text,
        },
        incoming_request,
        storage_pause_request,
        selected_summary,
    }
}

#[cfg(test)]
mod tests {
    use p2p_protocol::ParticipantRoleWire;

    use super::*;

    fn receiver(session_id: &str, peer_id: Option<&str>) -> ParticipantSnapshot {
        ParticipantSnapshot {
            session_id: session_id.to_owned(),
            display_name: session_id.to_owned(),
            role: ParticipantRoleWire::Receiver,
            online: true,
            peer_id: peer_id.map(str::to_owned),
        }
    }

    fn file() -> TransferFile {
        TransferFile {
            name: "example.bin".to_owned(),
            mime: Some("application/octet-stream".to_owned()),
            size_bytes: 100,
        }
    }

    #[test]
    fn selection_drops_absent_receivers_and_requires_each_selected_peer_to_be_ready() {
        let receivers = vec![receiver("session-a", Some("peer-a"))];
        let rtc_peer_presentations = BTreeMap::from([(
            "peer-a".to_owned(),
            PeerRtcPresentation::new(RtcPhase::Ready, false),
        )]);
        let transfers_by_peer = BTreeMap::new();
        let selected_receiver_ids = vec!["absent".to_owned(), "session-a".to_owned()];

        let view = derive_transfer_panel_view(TransferPanelViewInput {
            role: RoomRole::Owner,
            receivers: &receivers,
            rtc_config_phase: RtcConfigPhase::Ready,
            aggregate_rtc: RtcPhase::Ready,
            transfer: &TransferState::Idle,
            rtc_peer_presentations: &rtc_peer_presentations,
            transfers_by_peer: &transfers_by_peer,
            selected_receiver_ids: Some(&selected_receiver_ids),
            batch_peer_ids: &[],
        });

        assert_eq!(view.selected_ids, ["session-a"]);
        assert_eq!(view.selected_peer_ids, ["peer-a"]);
        assert!(view.can_offer);
        assert_eq!(view.selected_summary, "全部 1 位");
    }

    #[test]
    fn empty_batch_uses_only_non_idle_peer_transfers() {
        let receivers = vec![
            receiver("session-a", Some("peer-a")),
            receiver("session-b", Some("peer-b")),
        ];
        let rtc_peer_presentations = BTreeMap::new();
        let transfers_by_peer = BTreeMap::from([
            ("peer-a".to_owned(), TransferState::Idle),
            (
                "peer-b".to_owned(),
                TransferState::Offering {
                    transfer_id: "transfer-b".to_owned(),
                    file: file(),
                    files: vec![file()],
                },
            ),
        ]);

        let view = derive_transfer_panel_view(TransferPanelViewInput {
            role: RoomRole::Owner,
            receivers: &receivers,
            rtc_config_phase: RtcConfigPhase::Ready,
            aggregate_rtc: RtcPhase::Ready,
            transfer: &TransferState::Idle,
            rtc_peer_presentations: &rtc_peer_presentations,
            transfers_by_peer: &transfers_by_peer,
            selected_receiver_ids: None,
            batch_peer_ids: &[],
        });

        assert_eq!(view.current_batch_peer_ids, ["peer-b"]);
        assert_eq!(view.owner_states.len(), 1);
        assert!(view.active);
    }
}
