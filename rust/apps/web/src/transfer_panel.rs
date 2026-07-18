use std::collections::BTreeMap;

use dioxus::prelude::*;
use p2p_browser_platform::RtcPeer;
use p2p_protocol::ParticipantSnapshot;

mod file_progress_list;
mod receiver_transfer_list;
mod recipient_picker_dialog;
mod transfer_action_area;
mod transfer_request_dialog;
mod view_model;

use self::file_progress_list::FileProgressList;
use self::receiver_transfer_list::ReceiverTransferList;
use self::recipient_picker_dialog::RecipientPickerDialog;
use self::transfer_action_area::TransferActionArea;
use self::transfer_request_dialog::TransferRequestDialog;
use self::view_model::{
    TransferPanelViewInput, TransferPanelViewModel, derive_transfer_panel_view,
};

use crate::app_state::{AppModel, RoomRole, RtcConfigPhase, RtcPhase, TransferState};
use crate::transfer_presentation::format_bytes;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct PeerRtcPresentation {
    phase: RtcPhase,
    outgoing_recovery_checking: bool,
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
    rtc_peers: Signal<BTreeMap<String, RtcPeer>>,
    role: RoomRole,
    receivers: Vec<ParticipantSnapshot>,
    rtc_config_phase: RtcConfigPhase,
    aggregate_rtc: RtcPhase,
    transfer: TransferState,
    rtc_peer_presentations: BTreeMap<String, PeerRtcPresentation>,
    transfers_by_peer: BTreeMap<String, TransferState>,
) -> Element {
    let mut picker_open = use_signal(|| false);
    let selected_receiver_ids = use_signal(|| None::<Vec<String>>);
    let batch_peer_ids = use_signal(Vec::<String>::new);
    let selected_receiver_ids_value = selected_receiver_ids.read().clone();
    let batch_peer_ids_value = batch_peer_ids.read().clone();
    let TransferPanelViewModel {
        selected_ids,
        selected_peer_ids,
        current_batch_peer_ids,
        owner_states,
        paused_peer_ids,
        active,
        can_offer,
        title,
        description,
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
        selected_receiver_ids: selected_receiver_ids_value.as_deref(),
        batch_peer_ids: &batch_peer_ids_value,
    });
    let receiver_count = receivers.len();
    let completed_bytes = file_progress.completed_bytes;
    let total_bytes = file_progress.total_bytes;

    rsx! {
        section { class: "transfer-panel", aria_label: "文件传输",
            div {
                class: "transfer-panel-copy",
                role: "status",
                aria_live: "polite",
                aria_atomic: "true",
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
            FileProgressList {
                role,
                transfer: transfer.clone(),
                owner_states: owner_states.clone(),
                file_progress,
            }
            if role == RoomRole::Owner && !current_batch_peer_ids.is_empty() {
                ReceiverTransferList {
                    peer_ids: current_batch_peer_ids.clone(),
                    receivers: receivers.clone(),
                    transfers_by_peer: transfers_by_peer.clone(),
                }
            }
            if active {
                p { class: "transfer-progress-copy",
                    "{format_bytes(completed_bytes)} / {format_bytes(total_bytes)}"
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
                owner_states,
                storage_pause_request,
                transfer: transfer.clone(),
                batch_peer_ids,
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
