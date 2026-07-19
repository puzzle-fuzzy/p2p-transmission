use std::collections::BTreeMap;

use dioxus::prelude::*;
use p2p_browser_platform::{RtcPeer, show_modal_dialog};

use crate::app_state::AppModel;
use crate::transfer_actions::TransferActions;
use crate::transfer_presentation::format_bytes;

#[component]
pub(super) fn TextRequestDialog(
    model: Signal<AppModel>,
    rtc_peers: Signal<BTreeMap<String, RtcPeer>>,
    peer_id: String,
    transfer_id: String,
    character_count: u32,
    byte_length: u32,
) -> Element {
    let dialog_error = use_signal(|| None::<String>);
    let actions = TransferActions::new(model, rtc_peers).with_dialog_error(dialog_error);
    use_effect(|| {
        let _ = show_modal_dialog("text-request-dialog");
    });
    let reject_peer_id = peer_id.clone();
    let reject_transfer_id = transfer_id.clone();
    let accept_peer_id = peer_id;
    let accept_transfer_id = transfer_id;

    rsx! {
        dialog {
            id: "text-request-dialog",
            class: "transfer-request-dialog text-request-dialog",
            aria_labelledby: "text-request-title",
            oncancel: move |event| event.prevent_default(),
            h2 { id: "text-request-title", "接收文本" }
            p { "发送者想向你发送一段文本。只有同意后，正文才会通过加密通道传来。" }
            dl { class: "text-request-metadata",
                div {
                    dt { "字符数" }
                    dd { "{character_count}" }
                }
                div {
                    dt { "数据大小" }
                    dd { "{format_bytes(u64::from(byte_length))}" }
                }
            }
            if let Some(error) = dialog_error() {
                p { class: "dialog-error", role: "alert", "{error}" }
            }
            div { class: "dialog-actions",
                button {
                    class: "secondary-button",
                    r#type: "button",
                    autofocus: true,
                    onclick: move |_| {
                        actions.decide_incoming_text(
                            &reject_peer_id,
                            &reject_transfer_id,
                            false,
                        )
                    },
                    "拒绝接收"
                }
                button {
                    class: "primary-button",
                    r#type: "button",
                    onclick: move |_| {
                        actions.decide_incoming_text(
                            &accept_peer_id,
                            &accept_transfer_id,
                            true,
                        )
                    },
                    "接收文本"
                }
            }
        }
    }
}
