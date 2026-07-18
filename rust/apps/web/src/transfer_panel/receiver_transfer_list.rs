use std::collections::BTreeMap;

use dioxus::prelude::*;
use p2p_protocol::ParticipantSnapshot;

use crate::app_state::TransferState;
use crate::transfer_presentation::receiver_transfer_status;

#[component]
pub(super) fn ReceiverTransferList(
    peer_ids: Vec<String>,
    receivers: Vec<ParticipantSnapshot>,
    transfers_by_peer: BTreeMap<String, TransferState>,
) -> Element {
    rsx! {
        div { class: "receiver-transfer-list", role: "list", aria_label: "接收者传输结果",
            for peer_id in peer_ids.iter() {
                if let Some(receiver) = receivers.iter().find(|receiver| {
                    receiver.peer_id.as_deref() == Some(peer_id.as_str())
                }) {
                    div { class: "receiver-transfer-row", role: "listitem",
                        span { title: "{receiver.display_name}", "{receiver.display_name}" }
                        strong { "{receiver_transfer_status(transfers_by_peer.get(peer_id))}" }
                    }
                }
            }
        }
    }
}
