use dioxus::prelude::*;

use super::view_model::FileProgressViewModel;
use crate::app_state::{RoomRole, TransferState};
use crate::transfer_presentation::{completed_transfer_hash, format_bytes};

#[component]
pub(super) fn FileProgressList(
    role: RoomRole,
    transfer: TransferState,
    owner_states: Vec<TransferState>,
    file_progress: FileProgressViewModel,
) -> Element {
    let FileProgressViewModel {
        file,
        files,
        progress,
        file_progresses,
        file_progress_value_texts,
        fallback_file_progress,
        fallback_progress_value_text,
        ..
    } = file_progress;

    rsx! {
        if !files.is_empty() {
            div { class: "transfer-file-list", role: "list", aria_label: "传输文件列表",
                for (index, item) in files.iter().enumerate() {
                    div { class: "transfer-file-row", role: "listitem",
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
                            div { class: "transfer-file-secondary",
                                span { "{format_bytes(item.size_bytes)}" }
                                span {
                                    class: "transfer-file-status",
                                    aria_hidden: "true",
                                    "{file_progress_value_texts[index]}"
                                }
                            }
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
        } else if let Some(file) = file {
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
                    div { class: "transfer-file-secondary",
                        span { "{format_bytes(file.size_bytes)}" }
                        span {
                            class: "transfer-file-status",
                            aria_hidden: "true",
                            "{fallback_progress_value_text}"
                        }
                    }
                }
            }
        }
    }
}
