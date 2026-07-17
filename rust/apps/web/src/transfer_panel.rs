use std::collections::{BTreeMap, BTreeSet};

use dioxus::prelude::*;
use p2p_browser_platform::{
    RtcPeer, TransferDirection, TransferFile, persistent_source_file_support,
};
use p2p_protocol::{ParticipantSnapshot, StreamPauseReason};

mod recipient_picker_dialog;
mod transfer_request_dialog;

use self::recipient_picker_dialog::RecipientPickerDialog;
use self::transfer_request_dialog::TransferRequestDialog;

use crate::app_state::{AppModel, RoomRole, RtcPhase, TransferLinkState, TransferState};
use crate::transfer_actions::TransferActions;
use crate::transfer_presentation::{
    completed_transfer_hash, format_bytes, owner_transfer_file_progress, owner_transfer_panel_copy,
    owner_transfer_progress, owner_transfer_progress_value_text, receiver_transfer_status,
    transfer_file, transfer_file_progress, transfer_files, transfer_is_active, transfer_panel_copy,
    transfer_progress, transfer_progress_value_text,
};

#[component]
pub(super) fn TransferPanel(
    mut model: Signal<AppModel>,
    rtc_peers: Signal<BTreeMap<String, RtcPeer>>,
    role: RoomRole,
    receivers: Vec<ParticipantSnapshot>,
    rtc: RtcPhase,
    transfer: TransferState,
    rtc_by_peer: BTreeMap<String, RtcPhase>,
    transfers_by_peer: BTreeMap<String, TransferState>,
) -> Element {
    let actions = TransferActions::new(model, rtc_peers);
    let mut picker_open = use_signal(|| false);
    let selected_receiver_ids = use_signal(|| None::<Vec<String>>);
    let mut batch_peer_ids = use_signal(Vec::<String>::new);
    let online_receiver_ids = receivers
        .iter()
        .map(|receiver| receiver.session_id.clone())
        .collect::<BTreeSet<_>>();
    let selected_ids = selected_receiver_ids
        .read()
        .clone()
        .unwrap_or_else(|| online_receiver_ids.iter().cloned().collect())
        .into_iter()
        .filter(|session_id| online_receiver_ids.contains(session_id))
        .collect::<Vec<_>>();
    let selected_peer_ids = receivers
        .iter()
        .filter(|receiver| selected_ids.contains(&receiver.session_id))
        .filter_map(|receiver| receiver.peer_id.clone())
        .collect::<Vec<_>>();
    let ready_count = selected_peer_ids
        .iter()
        .filter(|peer_id| rtc_by_peer.get(*peer_id) == Some(&RtcPhase::Ready))
        .count();
    let mut current_batch_peer_ids = batch_peer_ids.read().clone();
    if current_batch_peer_ids.is_empty() {
        current_batch_peer_ids.extend(
            transfers_by_peer
                .iter()
                .filter(|(_, transfer)| !matches!(transfer, TransferState::Idle))
                .map(|(peer_id, _)| peer_id.clone()),
        );
    }
    let owner_states = current_batch_peer_ids
        .iter()
        .filter_map(|peer_id| transfers_by_peer.get(peer_id).cloned())
        .collect::<Vec<_>>();
    let paused_peer_ids = current_batch_peer_ids
        .iter()
        .filter(|peer_id| {
            matches!(
                transfers_by_peer.get(*peer_id),
                Some(TransferState::Active {
                    link_state: TransferLinkState::Paused,
                    ..
                })
            )
        })
        .cloned()
        .collect::<Vec<_>>();
    let owner_active = owner_states.iter().any(transfer_is_active);
    let receiver_active = transfer_is_active(&transfer);
    let active = if role == RoomRole::Owner {
        owner_active
    } else {
        receiver_active
    };
    let can_offer = role == RoomRole::Owner
        && !selected_peer_ids.is_empty()
        && ready_count == selected_peer_ids.len()
        && !owner_active;
    let receiver_count = receivers.len();
    let (title, description) = if role == RoomRole::Owner {
        owner_transfer_panel_copy(
            receiver_count,
            selected_ids.len(),
            ready_count,
            &owner_states,
        )
    } else {
        transfer_panel_copy(role, receiver_count, rtc, &transfer)
    };
    let file = if role == RoomRole::Owner {
        owner_states.iter().find_map(transfer_file).cloned()
    } else {
        transfer_file(&transfer).cloned()
    };
    let files = if role == RoomRole::Owner {
        owner_states
            .iter()
            .find_map(transfer_files)
            .map(<[TransferFile]>::to_vec)
            .unwrap_or_default()
    } else {
        transfer_files(&transfer)
            .map(<[TransferFile]>::to_vec)
            .unwrap_or_default()
    };
    let (completed_bytes, total_bytes, progress) = if role == RoomRole::Owner {
        owner_transfer_progress(&owner_states)
    } else {
        transfer_progress(&transfer)
    };
    let file_progresses = files
        .iter()
        .enumerate()
        .map(|(index, _)| {
            if role == RoomRole::Owner {
                owner_transfer_file_progress(&owner_states, &files, index)
            } else {
                transfer_file_progress(&transfer, &files, index)
            }
        })
        .collect::<Vec<_>>();
    let file_progress_value_texts = file_progresses
        .iter()
        .map(|progress| {
            if role == RoomRole::Owner {
                owner_transfer_progress_value_text(&owner_states, progress * 100.0)
            } else {
                transfer_progress_value_text(&transfer, progress * 100.0)
            }
        })
        .collect::<Vec<_>>();
    let fallback_file_progress = progress.clamp(0.0, 100.0) / 100.0;
    let fallback_progress_value_text = if role == RoomRole::Owner {
        owner_transfer_progress_value_text(&owner_states, progress)
    } else {
        transfer_progress_value_text(&transfer, progress)
    };
    let incoming_request = transfers_by_peer.iter().find_map(|(peer_id, state)| {
        if let TransferState::Incoming {
            transfer_id,
            mode,
            files,
            recovery_available,
            ..
        } = state
        {
            Some((
                peer_id.clone(),
                transfer_id.clone(),
                *mode,
                files.clone(),
                *recovery_available,
            ))
        } else {
            None
        }
    });
    let storage_pause_request = transfers_by_peer.iter().find_map(|(peer_id, state)| {
        if let TransferState::Active {
            transfer_id,
            direction: TransferDirection::Receive,
            storage_pause: Some(reason),
            ..
        } = state
        {
            Some((peer_id.clone(), transfer_id.clone(), *reason))
        } else {
            None
        }
    });
    let selected_summary = if selected_ids.len() == receiver_count {
        format!("全部 {} 位", selected_ids.len())
    } else {
        format!("{} 位", selected_ids.len())
    };

    rsx! {
        section { class: "transfer-panel", aria_label: "文件传输",
            div { class: "transfer-panel-copy",
                h1 { "{title}" }
                p { "{description}" }
            }
            if role == RoomRole::Owner && receiver_count > 0 {
                button {
                    class: "recipient-picker-trigger",
                    r#type: "button",
                    disabled: active,
                    aria_label: "选择接收者，已选择 {selected_ids.len()} 位",
                    onclick: move |_| picker_open.set(true),
                    span { "接收者" }
                    strong { "{selected_summary}" }
                }
            }
            if !files.is_empty() {
                div { class: "transfer-file-list", aria_label: "传输文件列表",
                    for (index, item) in files.iter().enumerate() {
                        div { class: "transfer-file-row",
                            span {
                                class: "transfer-file-progress",
                                style: "--file-progress-scale:{file_progresses[index]:.4}",
                                role: "progressbar",
                                aria_label: "{item.name} 传输进度",
                                aria_valuemin: "0",
                                aria_valuemax: "100",
                                aria_valuenow: "{file_progresses[index] * 100.0:.0}",
                                aria_valuetext: "{file_progress_value_texts[index]}",
                            }
                            div { class: "transfer-file-meta",
                                strong { title: "{item.name}", "{item.name}" }
                                span { "{format_bytes(item.size_bytes)}" }
                            }
                            if index + 1 == files.len() {
                                if role == RoomRole::Owner
                                    && let Some(blake3) = completed_transfer_hash(&owner_states)
                                {
                                    code { title: "BLAKE3 {blake3}",
                                        if files.len() > 1 { "全部校验通过" } else { "校验通过" }
                                    }
                                } else if let TransferState::Completed { blake3, .. } = &transfer {
                                    code { title: "BLAKE3 {blake3}",
                                        if files.len() > 1 { "全部校验通过" } else { "校验通过" }
                                    }
                                }
                            }
                        }
                    }
                }
            } else if let Some(file) = file.clone() {
                div { class: "transfer-file-row",
                    span {
                        class: "transfer-file-progress",
                        style: "--file-progress-scale:{fallback_file_progress:.4}",
                        role: "progressbar",
                        aria_label: "{file.name} 传输进度",
                        aria_valuemin: "0",
                        aria_valuemax: "100",
                        aria_valuenow: "{progress:.0}",
                        aria_valuetext: "{fallback_progress_value_text}",
                    }
                    div { class: "transfer-file-meta",
                        strong { title: "{file.name}", "{file.name}" }
                        span { "{format_bytes(file.size_bytes)}" }
                    }
                }
            }
            if role == RoomRole::Owner && !current_batch_peer_ids.is_empty() {
                div { class: "receiver-transfer-list", aria_label: "接收者传输结果",
                    for peer_id in current_batch_peer_ids.iter() {
                        if let Some(receiver) = receivers.iter().find(|receiver| {
                            receiver.peer_id.as_deref() == Some(peer_id.as_str())
                        }) {
                            div { class: "receiver-transfer-row",
                                span { title: "{receiver.display_name}", "{receiver.display_name}" }
                                strong { "{receiver_transfer_status(transfers_by_peer.get(peer_id))}" }
                            }
                        }
                    }
                }
            }
            if active {
                p { class: "transfer-progress-copy",
                    "{format_bytes(completed_bytes)} / {format_bytes(total_bytes)}"
                }
            }
            div { class: "transfer-actions",
                if can_offer && !active {
                    if persistent_source_file_support() {
                        button {
                            class: "primary-button file-picker-button",
                            r#type: "button",
                            onclick: {
                                let selected_peer_ids = selected_peer_ids.clone();
                                move |_| {
                                    let selected_peer_ids = selected_peer_ids.clone();
                                    spawn(async move {
                                        let offered = actions
                                            .submit_persistent_source_files(selected_peer_ids)
                                            .await;
                                        if !offered.is_empty() {
                                            batch_peer_ids.set(offered);
                                        }
                                    });
                                }
                            },
                            "选择文件"
                        }
                    } else {
                        input {
                            id: "transfer-file-input",
                            class: "sr-only",
                            r#type: "file",
                            multiple: true,
                            aria_label: "选择要发送的文件",
                            onchange: {
                                let selected_peer_ids = selected_peer_ids.clone();
                                move |_| {
                                    let offered = actions
                                        .submit_selected_files(selected_peer_ids.clone());
                                    if !offered.is_empty() {
                                        batch_peer_ids.set(offered);
                                    }
                                }
                            },
                        }
                        label { class: "primary-button file-picker-button", r#for: "transfer-file-input",
                            "选择文件"
                        }
                    }
                }
                if let Some((peer_id, transfer_id, reason)) = storage_pause_request.clone() {
                    button {
                        class: "primary-button",
                        r#type: "button",
                        onclick: move |_| {
                            let peer_id = peer_id.clone();
                            let transfer_id = transfer_id.clone();
                            spawn(async move {
                                actions
                                    .resume_streaming_transfer(peer_id, transfer_id)
                                    .await;
                            });
                        },
                        if reason == StreamPauseReason::DestinationQuotaExceeded {
                            "释放空间后继续接收"
                        } else {
                            "重新授权"
                        }
                    }
                } else if role == RoomRole::Owner
                    && owner_states
                        .iter()
                        .any(|state| matches!(state, TransferState::OutgoingRecovery { .. }))
                {
                    button {
                        class: "primary-button",
                        r#type: "button",
                        onclick: {
                            let current_batch_peer_ids = current_batch_peer_ids.clone();
                            move |_| {
                                actions.resume_outgoing_transfers(current_batch_peer_ids.clone())
                            }
                        },
                        "继续发送"
                    }
                } else if role == RoomRole::Owner && !paused_peer_ids.is_empty() {
                    button {
                        class: "primary-button",
                        r#type: "button",
                        onclick: {
                            let paused_peer_ids = paused_peer_ids.clone();
                            move |_| actions.retry_paused_transfers(paused_peer_ids.clone())
                        },
                        "重新连接"
                    }
                }
                if active {
                    button {
                        class: "secondary-button transfer-cancel-button",
                        r#type: "button",
                        onclick: {
                            let current_batch_peer_ids = current_batch_peer_ids.clone();
                            move |_| {
                                actions.cancel_current_transfers(
                                    role,
                                    current_batch_peer_ids.clone(),
                                )
                            }
                        },
                        "取消传输"
                    }
                }
                if let TransferState::Completed {
                    direction: TransferDirection::Receive,
                    download_url: Some(download_url),
                    file,
                    ..
                } = &transfer
                {
                    a {
                        class: "primary-button transfer-download",
                        href: "{download_url}",
                        download: "{file.name}",
                        "保存文件"
                    }
                }
            }
            if let Some((peer_id, transfer_id, mode, files, recovery_available)) = incoming_request {
                TransferRequestDialog {
                    model,
                    rtc_peers,
                    peer_id,
                    transfer_id,
                    mode,
                    files,
                    recovery_available,
                }
            }
            if picker_open() {
                RecipientPickerDialog {
                    receivers: receivers.clone(),
                    selected_ids: selected_ids.clone(),
                    picker_open,
                    selected_receiver_ids,
                }
            }
        }
    }
}
