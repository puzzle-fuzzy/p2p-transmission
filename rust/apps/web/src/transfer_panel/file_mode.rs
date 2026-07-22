use std::collections::BTreeMap;

use dioxus::prelude::*;
use p2p_browser_platform::RtcPeerRegistry;
use p2p_protocol::ParticipantSnapshot;

use super::file_progress_list::FileProgressList;
use super::receiver_transfer_list::ReceiverTransferList;
use super::transfer_action_area::TransferActionArea;
use super::view_model::{FileProgressViewModel, StoragePauseRequest};
use crate::app_state::{AppModel, RoomRole, TransferState};
use crate::transfer_presentation::format_bytes;

#[component]
pub(super) fn FileTransferView(
    model: Signal<AppModel>,
    rtc_peers: Signal<RtcPeerRegistry>,
    role: RoomRole,
    receivers: Vec<ParticipantSnapshot>,
    can_offer: bool,
    active: bool,
    selected_peer_ids: Vec<String>,
    current_batch_peer_ids: Vec<String>,
    paused_peer_ids: Vec<String>,
    owner_states: Vec<TransferState>,
    storage_pause_request: Option<StoragePauseRequest>,
    transfer: TransferState,
    mut batch_peer_ids: Signal<Vec<String>>,
    transfers_by_peer: BTreeMap<String, TransferState>,
    file_progress: FileProgressViewModel,
    has_files: bool,
    title: String,
) -> Element {
    let completed_bytes = file_progress.completed_bytes;
    let total_bytes = file_progress.total_bytes;
    rsx! {
        article { class: "panel file-input-panel",
            p { class: "panel-label mono", "FILE INPUT" }
            div { class: "dropzone transfer-dropzone",
                div {
                    class: "transfer-panel-copy",
                    role: "status",
                    aria_live: "polite",
                    aria_atomic: "true",
                    h2 { class: "dropzone-title", aria_label: "{title}", "拖入文件", br {}, "或选择文件" }
                    span { class: "sr-only", "{title}" }
                    p { class: "dropzone-copy",
                        "把一个或多个文件拖到这里，也可以点击按钮选择文件。本原型会模拟发送进度并显示在文件队列中。"
                    }
                }
                TransferActionArea {
                    model,
                    rtc_peers,
                    role,
                    can_offer,
                    active,
                    selected_peer_ids,
                    current_batch_peer_ids: current_batch_peer_ids.clone(),
                    paused_peer_ids,
                    owner_states: owner_states.clone(),
                    storage_pause_request,
                    transfer: transfer.clone(),
                    batch_peer_ids,
                }
            }
        }
        article { class: "panel queue-panel",
            p { class: "panel-label mono", "TRANSFER QUEUE" }
            h2 { class: "panel-title queue-title", "文件队列" }
            div { class: "file-list", id: "file-list", tabindex: "0", aria_live: "polite",
                if has_files {
                    FileProgressList {
                        role,
                        transfer: transfer.clone(),
                        owner_states: owner_states.clone(),
                        file_progress,
                    }
                    if role == RoomRole::Owner && !current_batch_peer_ids.is_empty() {
                        ReceiverTransferList {
                            peer_ids: current_batch_peer_ids,
                            receivers,
                            transfers_by_peer,
                        }
                    }
                    if active {
                        p { class: "transfer-progress-copy",
                            "{format_bytes(completed_bytes)} / {format_bytes(total_bytes)}"
                        }
                    }
                } else {
                    p { class: "muted-block",
                        "还没有加入任何文件。"
                        br {}
                        "点击“选择文件”，或者把文件拖拽到上方区域。"
                    }
                }
            }
        }
    }
}
