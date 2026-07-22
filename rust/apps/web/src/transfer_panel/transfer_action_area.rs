use dioxus::prelude::*;
use p2p_browser_platform::{
    RtcPeerRegistry, TransferDirection, click_element_by_id, persistent_source_file_support,
};
use p2p_protocol::StreamPauseReason;

use super::view_model::StoragePauseRequest;
use crate::app_state::{AppModel, RoomRole, TransferState};
use crate::transfer_actions::TransferActions;

#[component]
pub(super) fn TransferActionArea(
    model: Signal<AppModel>,
    rtc_peers: Signal<RtcPeerRegistry>,
    role: RoomRole,
    can_offer: bool,
    active: bool,
    selected_peer_ids: Vec<String>,
    current_batch_peer_ids: Vec<String>,
    paused_peer_ids: Vec<String>,
    owner_states: Vec<TransferState>,
    storage_pause_request: Option<StoragePauseRequest>,
    transfer: TransferState,
    mut batch_peer_ids: Signal<Vec<String>>,
) -> Element {
    let actions = TransferActions::new(model, rtc_peers);

    rsx! {
        div { class: "transfer-actions",
            if can_offer && !active {
                if persistent_source_file_support() {
                    button {
                        class: "btn btn--dark mono file-picker-button",
                        r#type: "button",
                        aria_label: "选择文件",
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
                        class: "file-picker-input",
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
                    label {
                        class: "btn btn--dark mono file-picker-button",
                        r#for: "transfer-file-input",
                        role: "button",
                        tabindex: "0",
                        aria_label: "选择要发送的文件",
                        onkeydown: move |event| match event.key() {
                            Key::Enter => {
                                event.prevent_default();
                                let _ = click_element_by_id("transfer-file-input");
                            }
                            Key::Character(value) if value == " " => {
                                event.prevent_default();
                                let _ = click_element_by_id("transfer-file-input");
                            }
                            _ => {}
                        },
                        "选择文件"
                    }
                }
            }
            if let Some(request) = storage_pause_request {
                button {
                    class: "primary-button",
                    r#type: "button",
                    onclick: {
                        let request = request.clone();
                        move |_| {
                            let peer_id = request.peer_id.clone();
                            let transfer_id = request.transfer_id.clone();
                            spawn(async move {
                                actions
                                    .resume_streaming_transfer(peer_id, transfer_id)
                                    .await;
                            });
                        }
                    },
                    if request.reason == StreamPauseReason::DestinationQuotaExceeded {
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
    }
}
