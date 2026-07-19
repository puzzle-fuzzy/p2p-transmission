use std::collections::BTreeMap;

use dioxus::prelude::*;
use p2p_browser_platform::{RtcPeer, TransferDirection, copy_text};
use p2p_protocol::{MAX_TEXT_TRANSFER_BYTES, MAX_TEXT_TRANSFER_CHARS, ParticipantSnapshot};

use super::text_request_dialog::TextRequestDialog;
use crate::app_state::{AppModel, RoomRole, TextTransferState};
use crate::transfer_actions::TransferActions;

#[component]
pub(super) fn TextPanel(
    mut model: Signal<AppModel>,
    rtc_peers: Signal<BTreeMap<String, RtcPeer>>,
    role: RoomRole,
    receivers: Vec<ParticipantSnapshot>,
    can_offer: bool,
    selected_peer_ids: Vec<String>,
    text_transfer: TextTransferState,
    text_transfers_by_peer: BTreeMap<String, TextTransferState>,
) -> Element {
    let mut draft = use_signal(String::new);
    let actions = TransferActions::new(model, rtc_peers);
    let draft_value = draft();
    let character_count = draft_value.chars().count();
    let byte_length = draft_value.len();
    let input_valid = character_count > 0
        && character_count <= MAX_TEXT_TRANSFER_CHARS
        && byte_length <= MAX_TEXT_TRANSFER_BYTES;
    let active_peer_ids = text_transfers_by_peer
        .iter()
        .filter(|(_, state)| text_transfer_is_active(state))
        .map(|(peer_id, _)| peer_id.clone())
        .collect::<Vec<_>>();
    let active = !active_peer_ids.is_empty() || text_transfer_is_active(&text_transfer);
    let incoming_request = text_transfers_by_peer.iter().find_map(|(peer_id, state)| {
        let TextTransferState::Incoming {
            transfer_id,
            character_count,
            byte_length,
        } = state
        else {
            return None;
        };
        Some((
            peer_id.clone(),
            transfer_id.clone(),
            *character_count,
            *byte_length,
        ))
    });
    let current_peer_id = text_transfers_by_peer
        .iter()
        .find(|(_, state)| !matches!(state, TextTransferState::Idle))
        .map(|(peer_id, _)| peer_id.clone());

    rsx! {
        div { class: "text-transfer-panel",
            if role == RoomRole::Owner {
                div {
                    class: "transfer-panel-copy",
                    role: "status",
                    aria_live: "polite",
                    aria_atomic: "true",
                    h1 { "发送文本" }
                    p {
                        if receivers.is_empty() {
                            "接收者加入后即可发送。正文不会经过服务器。"
                        } else if active {
                            "正在等待接收者确认或回执。"
                        } else {
                            "对方同意后，正文才会通过点对点加密通道发送。"
                        }
                    }
                }
                div { class: "text-composer",
                    label { r#for: "transfer-text-input", "文本内容" }
                    textarea {
                        id: "transfer-text-input",
                        value: "{draft_value}",
                        maxlength: MAX_TEXT_TRANSFER_CHARS,
                        rows: 7,
                        disabled: active,
                        placeholder: "输入或粘贴最多 500 个字符",
                        oninput: move |event| {
                            let limited = event
                                .value()
                                .chars()
                                .take(MAX_TEXT_TRANSFER_CHARS)
                                .collect::<String>();
                            draft.set(limited);
                        },
                    }
                    div { class: "text-composer-footer",
                        span {
                            class: if input_valid || character_count == 0 { "text-counter" } else { "text-counter text-counter-error" },
                            aria_live: "polite",
                            "{character_count} / {MAX_TEXT_TRANSFER_CHARS}"
                        }
                        button {
                            class: "primary-button",
                            r#type: "button",
                            disabled: !can_offer || !input_valid || active,
                            onclick: {
                                let peer_ids = selected_peer_ids.clone();
                                let text = draft_value.clone();
                                move |_| {
                                    let offered = actions.submit_text(peer_ids.clone(), text.clone());
                                    if !offered.is_empty() {
                                        draft.set(String::new());
                                    }
                                }
                            },
                            "发送文本"
                        }
                    }
                }
                if !text_transfers_by_peer.is_empty() {
                    ul { class: "receiver-transfer-list text-recipient-status", aria_label: "文本发送状态",
                        for (peer_id, state) in text_transfers_by_peer.iter() {
                            if !matches!(state, TextTransferState::Idle) {
                                li { class: "receiver-transfer-row", key: "{peer_id}",
                                    span { "{receiver_name(&receivers, peer_id)}" }
                                    strong { "{text_status(state)}" }
                                }
                            }
                        }
                    }
                }
                if active {
                    button {
                        class: "secondary-button transfer-cancel-button",
                        r#type: "button",
                        onclick: move |_| actions.cancel_text_transfers(active_peer_ids.clone()),
                        "取消传输"
                    }
                }
            } else {
                ReceiverTextView {
                    model,
                    rtc_peers,
                    state: text_transfer.clone(),
                    peer_id: current_peer_id,
                }
            }
            if let Some((peer_id, transfer_id, character_count, byte_length)) = incoming_request {
                TextRequestDialog {
                    key: "{transfer_id}",
                    model,
                    rtc_peers,
                    peer_id,
                    transfer_id,
                    character_count,
                    byte_length,
                }
            }
        }
    }
}

#[component]
fn ReceiverTextView(
    mut model: Signal<AppModel>,
    rtc_peers: Signal<BTreeMap<String, RtcPeer>>,
    state: TextTransferState,
    peer_id: Option<String>,
) -> Element {
    let actions = TransferActions::new(model, rtc_peers);
    rsx! {
        div {
            class: "transfer-panel-copy",
            role: "status",
            aria_live: "polite",
            aria_atomic: "true",
            h1 { "{receiver_text_title(&state)}" }
            p { "{receiver_text_description(&state)}" }
        }
        if let TextTransferState::Received { text } = &state {
            div { class: "received-text-card",
                pre { tabindex: 0, "{text}" }
                div { class: "transfer-actions",
                    button {
                        class: "primary-button",
                        r#type: "button",
                        onclick: {
                            let value = text.clone();
                            move |_| {
                                let value = value.clone();
                                spawn(async move {
                                    if copy_text(&value).await.is_ok() {
                                        model.write().notice = Some("文本已复制".to_owned());
                                    }
                                });
                            }
                        },
                        "复制文本"
                    }
                    button {
                        class: "secondary-button",
                        r#type: "button",
                        onclick: move |_| actions.clear_text_result(peer_id.as_deref()),
                        "完成"
                    }
                }
            }
        } else if matches!(
            state,
            TextTransferState::Rejected { .. }
                | TextTransferState::Cancelled
                | TextTransferState::Failed { .. }
        ) {
            button {
                class: "secondary-button",
                r#type: "button",
                onclick: move |_| actions.clear_text_result(peer_id.as_deref()),
                "返回等待"
            }
        }
    }
}

pub(super) fn text_transfer_is_active(state: &TextTransferState) -> bool {
    matches!(
        state,
        TextTransferState::Offering { .. }
            | TextTransferState::Incoming { .. }
            | TextTransferState::Sending { .. }
            | TextTransferState::Receiving { .. }
    )
}

pub(super) fn text_transfer_has_content(state: &TextTransferState) -> bool {
    !matches!(state, TextTransferState::Idle)
}

fn receiver_name(receivers: &[ParticipantSnapshot], peer_id: &str) -> String {
    receivers
        .iter()
        .find(|receiver| receiver.peer_id.as_deref() == Some(peer_id))
        .map(|receiver| receiver.display_name.clone())
        .unwrap_or_else(|| "接收者".to_owned())
}

fn text_status(state: &TextTransferState) -> &'static str {
    match state {
        TextTransferState::Idle => "等待发送",
        TextTransferState::Offering { .. } => "等待同意",
        TextTransferState::Incoming { .. } => "等待确认",
        TextTransferState::Sending { .. } => "等待回执",
        TextTransferState::Receiving { .. } => "正在接收",
        TextTransferState::Rejected { .. } => "已拒绝",
        TextTransferState::Delivered { .. } => "已送达",
        TextTransferState::Received { .. } => "已接收",
        TextTransferState::Cancelled => "已取消",
        TextTransferState::Failed { .. } => "失败",
    }
}

fn receiver_text_title(state: &TextTransferState) -> &'static str {
    match state {
        TextTransferState::Idle => "等待对方发送",
        TextTransferState::Incoming { .. } => "收到文本请求",
        TextTransferState::Receiving { .. } => "正在接收文本",
        TextTransferState::Received { .. } => "文本接收完成",
        TextTransferState::Rejected { .. } => "已拒绝文本",
        TextTransferState::Cancelled => "文本传输已取消",
        TextTransferState::Failed { .. } => "文本接收失败",
        _ => "文本传输",
    }
}

fn receiver_text_description(state: &TextTransferState) -> String {
    match state {
        TextTransferState::Idle => "对方发起文本请求后，会先征得你的同意。".to_owned(),
        TextTransferState::Incoming {
            character_count, ..
        } => format!("一段 {character_count} 字符的文本正在等待确认。"),
        TextTransferState::Receiving { .. } => "已同意，正在等待正文通过加密通道送达。".to_owned(),
        TextTransferState::Received { .. } => "正文只保留在当前页面中，请按需复制。".to_owned(),
        TextTransferState::Rejected { direction } => {
            if *direction == TransferDirection::Receive {
                "正文没有发送到本设备。".to_owned()
            } else {
                "文本请求已被拒绝。".to_owned()
            }
        }
        TextTransferState::Cancelled => "本次文本传输没有完成。".to_owned(),
        TextTransferState::Failed { message } => format!("传输失败：{message}"),
        _ => "文本正在通过点对点加密通道传输。".to_owned(),
    }
}
