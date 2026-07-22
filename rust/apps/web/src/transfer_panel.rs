use std::collections::BTreeMap;

use dioxus::prelude::*;
use p2p_browser_platform::RtcPeerRegistry;
use p2p_protocol::ParticipantSnapshot;

mod file_mode;
mod file_progress_list;
mod receiver_transfer_list;
mod recipient_picker_dialog;
mod text_panel;
mod transfer_action_area;
mod transfer_request_dialog;
mod view_model;

use self::file_mode::FileTransferView;
use self::recipient_picker_dialog::RecipientPickerDialog;
use self::text_panel::{TextPanel, text_transfer_has_content, text_transfer_is_active};
use self::transfer_request_dialog::TransferRequestDialog;
use self::view_model::{
    TransferPanelViewInput, TransferPanelViewModel, derive_transfer_panel_view,
};

use crate::app_state::{
    AppModel, RoomRole, RtcConfigPhase, RtcPhase, TextTransferState, TransferState,
};
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct PeerRtcPresentation {
    phase: RtcPhase,
    outgoing_recovery_checking: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TransferKind {
    File,
    Text,
}

impl PeerRtcPresentation {
    pub(super) fn new(phase: RtcPhase, outgoing_recovery_checking: bool) -> Self {
        Self {
            phase,
            outgoing_recovery_checking,
        }
    }
}

#[component]
pub(super) fn TransferPanel(
    model: Signal<AppModel>,
    rtc_peers: Signal<RtcPeerRegistry>,
    role: RoomRole,
    receivers: Vec<ParticipantSnapshot>,
    rtc_config_phase: RtcConfigPhase,
    aggregate_rtc: RtcPhase,
    transfer: TransferState,
    rtc_peer_presentations: BTreeMap<String, PeerRtcPresentation>,
    transfers_by_peer: BTreeMap<String, TransferState>,
    text_transfer: TextTransferState,
    text_transfers_by_peer: BTreeMap<String, TextTransferState>,
) -> Element {
    let mut picker_open = use_signal(|| false);
    let mut transfer_kind = use_signal(|| TransferKind::File);
    let selected_receiver_ids = use_signal(|| None::<Vec<String>>);
    let batch_peer_ids = use_signal(Vec::<String>::new);
    let selected_receiver_ids_value = selected_receiver_ids.read().clone();
    let batch_peer_ids_value = batch_peer_ids.read().clone();
    let text_active = text_transfer_is_active(&text_transfer)
        || text_transfers_by_peer.values().any(text_transfer_is_active);
    let TransferPanelViewModel {
        selected_ids,
        selected_peer_ids,
        current_batch_peer_ids,
        owner_states,
        paused_peer_ids,
        active,
        can_offer,
        title,
        description: _description,
        file_progress,
        incoming_request,
        storage_pause_request,
        selected_summary,
    } = derive_transfer_panel_view(TransferPanelViewInput {
        role,
        receivers: &receivers,
        rtc_config_phase,
        aggregate_rtc,
        transfer: &transfer,
        rtc_peer_presentations: &rtc_peer_presentations,
        transfers_by_peer: &transfers_by_peer,
        text_transfer_active: text_active,
        selected_receiver_ids: selected_receiver_ids_value.as_deref(),
        batch_peer_ids: &batch_peer_ids_value,
    });
    let receiver_count = receivers.len();
    let global_active = active || text_active;
    let showing_text = transfer_kind() == TransferKind::Text
        || (role == RoomRole::Receiver && text_transfer_has_content(&text_transfer));
    let has_files = !file_progress.files.is_empty() || file_progress.file.is_some();
    rsx! {
        section { class: "transfer-panel", aria_label: "文件与文本传输",
            div { class: "transfer-kind-tabs", role: "tablist", aria_label: "传输类型",
                button {
                    id: "transfer-file-tab",
                    class: if !showing_text { "transfer-kind-tab is-active" } else { "transfer-kind-tab" },
                    r#type: "button",
                    role: "tab",
                    aria_selected: !showing_text,
                    aria_controls: "transfer-file-panel",
                    onclick: move |_| transfer_kind.set(TransferKind::File),
                    "文件"
                }
                button {
                    id: "transfer-text-tab",
                    class: if showing_text { "transfer-kind-tab is-active" } else { "transfer-kind-tab" },
                    r#type: "button",
                    role: "tab",
                    aria_selected: showing_text,
                    aria_controls: "transfer-text-panel",
                    onclick: move |_| transfer_kind.set(TransferKind::Text),
                    "文本"
                }
            }
            if role == RoomRole::Owner && receiver_count > 0 {
                button {
                    class: "recipient-picker-trigger",
                    r#type: "button",
                    disabled: global_active,
                    aria_label: "选择接收者，已选择 {selected_ids.len()} 位",
                    onclick: move |_| picker_open.set(true),
                    span { "接收者" }
                    strong { "{selected_summary}" }
                }
            }
            if showing_text {
                TextPanel {
                    model,
                    rtc_peers,
                    role,
                    receivers: receivers.clone(),
                    can_offer,
                    selected_peer_ids: selected_peer_ids.clone(),
                    text_transfer: text_transfer.clone(),
                    text_transfers_by_peer: text_transfers_by_peer.clone(),
                }
            } else {
                FileTransferView {
                    model,
                    rtc_peers,
                    role,
                    receivers: receivers.clone(),
                    can_offer,
                    active,
                    selected_peer_ids: selected_peer_ids.clone(),
                    current_batch_peer_ids: current_batch_peer_ids.clone(),
                    paused_peer_ids: paused_peer_ids.clone(),
                    owner_states: owner_states.clone(),
                    storage_pause_request: storage_pause_request.clone(),
                    transfer: transfer.clone(),
                    batch_peer_ids,
                    transfers_by_peer: transfers_by_peer.clone(),
                    file_progress,
                    has_files,
                    title,
                }
                if let Some(request) = incoming_request {
                    TransferRequestDialog {
                        key: "{request.transfer_id}",
                        model,
                        rtc_peers,
                        peer_id: request.peer_id,
                        transfer_id: request.transfer_id,
                        mode: request.mode,
                        files: request.files,
                        recovery_available: request.recovery_available,
                    }
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
