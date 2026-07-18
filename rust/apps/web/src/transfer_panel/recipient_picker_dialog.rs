use dioxus::prelude::*;
use p2p_browser_platform::{close_modal_dialog, show_modal_dialog};
use p2p_protocol::ParticipantSnapshot;

use crate::participant_presence::Avatar;

#[component]
pub(super) fn RecipientPickerDialog(
    receivers: Vec<ParticipantSnapshot>,
    selected_ids: Vec<String>,
    mut picker_open: Signal<bool>,
    mut selected_receiver_ids: Signal<Option<Vec<String>>>,
) -> Element {
    use_effect(|| {
        let _ = show_modal_dialog("recipient-picker-dialog");
    });
    let mut draft_ids = use_signal(|| selected_ids);
    let mut error = use_signal(String::new);
    let selected_count = draft_ids.read().len();
    rsx! {
        dialog {
                id: "recipient-picker-dialog",
                class: "recipient-picker-dialog",
                aria_labelledby: "recipient-picker-title",
                oncancel: move |event| {
                    event.prevent_default();
                    let _ = close_modal_dialog("recipient-picker-dialog");
                    picker_open.set(false);
                },
                div { class: "recipient-picker-heading",
                    div {
                        h2 { id: "recipient-picker-title", "选择接收者" }
                        p { "选择本次文件要发送给谁。" }
                    }
                    span {
                        role: "status",
                        aria_live: "polite",
                        aria_atomic: "true",
                        "已选 {selected_count} 人"
                    }
                }
                div { class: "recipient-picker-tools",
                    button {
                        r#type: "button",
                        onclick: {
                            let receivers = receivers.clone();
                            move |_| {
                                error.set(String::new());
                                draft_ids.set(receivers.iter().map(|item| item.session_id.clone()).collect());
                            }
                        },
                        "全选"
                    }
                    button {
                        r#type: "button",
                        onclick: move |_| {
                            error.set(String::new());
                            draft_ids.set(Vec::new());
                        },
                        "清空选择"
                    }
                }
                div { class: "recipient-picker-list", role: "group", aria_label: "可选接收者",
                    for receiver in receivers.iter() {
                        {
                            let receiver_id = receiver.session_id.clone();
                            let checked = draft_ids.read().contains(&receiver_id);
                            rsx! {
                                label { class: if checked { "recipient-option selected" } else { "recipient-option" },
                                    input {
                                        r#type: "checkbox",
                                        checked,
                                        aria_label: "{receiver.display_name}",
                                        onchange: move |_| {
                                            error.set(String::new());
                                            let mut next = draft_ids.read().clone();
                                            if let Some(index) = next.iter().position(|id| id == &receiver_id) {
                                                next.remove(index);
                                            } else {
                                                next.push(receiver_id.clone());
                                            }
                                            draft_ids.set(next);
                                        },
                                    }
                                    Avatar {
                                        seed: receiver.session_id.clone(),
                                        label: receiver.display_name.clone(),
                                        entering: false,
                                        highlighted: false,
                                    }
                                    span { title: "{receiver.display_name}", "{receiver.display_name}" }
                                }
                            }
                        }
                    }
                }
                if !error.read().is_empty() {
                    p { class: "recipient-picker-error", role: "alert", "{error}" }
                }
                div { class: "dialog-actions",
                    button {
                        class: "secondary-button",
                        r#type: "button",
                        onclick: move |_| {
                            let _ = close_modal_dialog("recipient-picker-dialog");
                            picker_open.set(false);
                        },
                        "取消"
                    }
                    button {
                        class: "primary-button",
                        r#type: "button",
                        onclick: move |_| {
                            let selected = draft_ids.read().clone();
                            if selected.is_empty() {
                                error.set("至少选择一位接收者".to_owned());
                                return;
                            }
                            selected_receiver_ids.set(Some(selected));
                            let _ = close_modal_dialog("recipient-picker-dialog");
                            picker_open.set(false);
                        },
                        "确定"
                    }
                }
        }
    }
}
