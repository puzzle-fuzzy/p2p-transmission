use std::collections::BTreeMap;

use dioxus::prelude::*;
use p2p_browser_platform::{
    RtcPeer, StreamingStorageSupport, TransferFile, show_modal_dialog,
    streaming_batch_storage_supported, streaming_storage_support,
};
use p2p_protocol::TransferMode;

use crate::app_state::AppModel;
use crate::transfer_actions::TransferActions;
use crate::transfer_presentation::format_bytes;

#[component]
pub(super) fn TransferRequestDialog(
    mut model: Signal<AppModel>,
    rtc_peers: Signal<BTreeMap<String, RtcPeer>>,
    peer_id: String,
    transfer_id: String,
    mode: TransferMode,
    files: Vec<TransferFile>,
    recovery_available: bool,
) -> Element {
    let actions = TransferActions::new(model, rtc_peers);
    use_effect(|| {
        let _ = show_modal_dialog("transfer-request-dialog");
    });
    let streamed = matches!(mode, TransferMode::Streamed { .. });
    let batch = files.len() > 1;
    let stream_supported = if batch {
        streaming_batch_storage_supported()
    } else {
        streaming_storage_support() == StreamingStorageSupport::DirectFile
    };
    let accept_transfer_id = transfer_id.clone();
    let reselect_transfer_id = transfer_id.clone();
    let reject_transfer_id = transfer_id.clone();
    let accept_peer_id = peer_id.clone();
    let recovery_peer_id = peer_id.clone();
    let reject_peer_id = peer_id.clone();
    let accept_file_names = files
        .iter()
        .map(|file| file.name.clone())
        .collect::<Vec<_>>();
    rsx! {
        dialog {
                id: "transfer-request-dialog",
                class: "transfer-request-dialog",
                aria_labelledby: "transfer-request-title",
                oncancel: move |event| event.prevent_default(),
                h2 { id: "transfer-request-title",
                    if batch { "接收 {files.len()} 个文件" } else { "接收文件" }
                }
                if recovery_available {
                    p { "已找到未完成的接收记录。继续后会校验原文件，并从最后确认的位置恢复。" }
                } else if streamed && batch {
                    p { "选择目标文件夹后，文件会按列表顺序直接写入磁盘。" }
                } else if streamed {
                    p { "此文件较大，接收前请选择保存位置。数据会直接写入磁盘。" }
                } else {
                    p { "发送者希望向你发送这个文件。" }
                }
                div { class: "request-file-list",
                    for item in files.iter() {
                        div { class: "request-file-summary",
                            strong { title: "{item.name}", "{item.name}" }
                            span { "{format_bytes(item.size_bytes)}" }
                        }
                    }
                }
                if streamed && !stream_supported {
                    p { class: "stream-storage-error", role: "alert",
                        if batch {
                            "当前浏览器不支持批量文件夹保存，请使用桌面版 Chrome 或 Edge。"
                        } else {
                            "当前浏览器不支持大文件直接保存，请使用桌面版 Chrome 或 Edge。"
                        }
                    }
                }
                div { class: "dialog-actions dialog-actions-primary-first",
                    if streamed {
                        if recovery_available {
                            button {
                                class: "primary-button",
                                r#type: "button",
                                onclick: move |_| {
                                    let peer_id = recovery_peer_id.clone();
                                    let transfer_id = accept_transfer_id.clone();
                                    async move {
                                        actions
                                            .resume_streaming_transfer(peer_id, transfer_id)
                                            .await;
                                    }
                                },
                                "继续接收"
                            }
                            button {
                                class: "secondary-button",
                                r#type: "button",
                                disabled: !stream_supported,
                                onclick: move |_| {
                                    let peer_id = accept_peer_id.clone();
                                    let transfer_id = reselect_transfer_id.clone();
                                    let file_names = accept_file_names.clone();
                                    async move {
                                        actions
                                            .accept_streaming_transfer(
                                                peer_id,
                                                transfer_id,
                                                file_names,
                                            )
                                            .await;
                                    }
                                },
                                "重新选择位置"
                            }
                        } else {
                            button {
                                class: "primary-button",
                                r#type: "button",
                                disabled: !stream_supported,
                                onclick: move |_| {
                                    let peer_id = accept_peer_id.clone();
                                    let transfer_id = accept_transfer_id.clone();
                                    let file_names = accept_file_names.clone();
                                    async move {
                                        actions
                                            .accept_streaming_transfer(
                                                peer_id,
                                                transfer_id,
                                                file_names,
                                            )
                                            .await;
                                    }
                                },
                                if batch { "选择文件夹并接收" } else { "选择位置并接收" }
                            }
                        }
                    } else {
                        button {
                            class: "primary-button",
                            r#type: "button",
                            onclick: move |_| {
                                actions.decide_incoming_transfer(
                                    &accept_peer_id,
                                    &accept_transfer_id,
                                    true,
                                )
                            },
                            "接收文件"
                        }
                    }
                    button {
                        class: "secondary-button",
                        r#type: "button",
                        onclick: move |_| {
                            actions.decide_incoming_transfer(
                                &reject_peer_id,
                                &reject_transfer_id,
                                false,
                            )
                        },
                        "拒绝接收"
                    }
                }
        }
    }
}
