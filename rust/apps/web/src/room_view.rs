use std::collections::BTreeMap;

use dioxus::prelude::*;
use p2p_browser_platform::{RtcPeer, copy_text, leave_room, new_client_id};
use p2p_protocol::{
    CreateInviteResponse, ParticipantRoleWire, ParticipantSnapshot, RoomBootstrapResponse,
};

use crate::app_state::{AppModel, RealtimePhase, RoomRole, RtcPhase, Screen};
use crate::browser_errors::friendly_error;
use crate::icons::{UiIcon, UiIconKind};
use crate::join_request::JoinRequestDialog;
use crate::participant_presence::PeerFlow;
use crate::realtime_session::return_to_lobby;
use crate::realtime_target::{RealtimeTarget, RealtimeTargetScope};
use crate::share_dialog::ShareDialog;
use crate::transfer_panel::{PeerRtcPresentation, TransferPanel};

#[derive(Clone, PartialEq)]
struct RoomShellState {
    role: RoomRole,
    snapshot: RoomBootstrapResponse,
    invite: Option<CreateInviteResponse>,
    realtime: RealtimePhase,
    peer_connected: bool,
    busy: bool,
    notice: Option<String>,
    error: Option<String>,
    entering_receivers: Vec<String>,
}

#[derive(Clone)]
struct RoomLeaveScope {
    room_id: String,
    target: Option<RealtimeTargetScope>,
}

impl RoomLeaveScope {
    fn is_current(&self, state: &AppModel, target: Option<&RealtimeTarget>) -> bool {
        let same_room = matches!(
            &state.screen,
            Screen::Room { snapshot, .. } if snapshot.room_id == self.room_id
        );
        same_room
            && match &self.target {
                Some(scope) => scope.is_current(target),
                None => target.is_none(),
            }
    }
}

#[component]
pub(super) fn RoomView(
    mut model: Signal<AppModel>,
    mut realtime_target: Signal<Option<RealtimeTarget>>,
    rtc_peers: Signal<BTreeMap<String, RtcPeer>>,
) -> Element {
    let mut share_open = use_signal(|| false);
    let shell_state = use_memo(move || {
        let state = model.read();
        room_shell_state(&state)
    });
    let Some(state) = shell_state.read().as_ref().cloned() else {
        return rsx! {};
    };
    let RoomShellState {
        role,
        snapshot,
        invite,
        realtime,
        peer_connected,
        busy,
        notice,
        error,
        entering_receivers,
    } = state;
    let sender = snapshot
        .participants
        .iter()
        .find(|participant| participant.role == ParticipantRoleWire::Owner)
        .cloned();
    let receivers = snapshot
        .participants
        .iter()
        .filter(|participant| {
            participant.role == ParticipantRoleWire::Receiver && participant.online
        })
        .cloned()
        .collect::<Vec<_>>();
    let room_code_for_copy = snapshot.room_code.clone();
    let role_copy = if role == RoomRole::Owner {
        "发送者"
    } else {
        "接收者"
    };
    let status_copy = match realtime {
        RealtimePhase::Connected => "房间连接已建立",
        RealtimePhase::Superseded => "已在另一个标签页接管，本页已停止重连",
        RealtimePhase::Reconnecting => "正在重新连接房间",
        RealtimePhase::Connecting => "正在连接房间",
        RealtimePhase::Disconnected => "房间连接已断开",
    };

    rsx! {
        section { class: "room-view", aria_label: "房间状态",
            header { class: "room-header",
                div {
                    div { class: "room-label-row",
                        span { "房间码" }
                        span { class: "room-expiry", "临时房间" }
                    }
                    div { class: "room-code-row",
                        button {
                            class: "room-code-copy",
                            r#type: "button",
                            aria_label: "复制房间码 {snapshot.room_code}",
                            title: "复制房间码",
                            onclick: move |_| {
                                let value = room_code_for_copy.clone();
                                spawn(async move {
                                    if copy_text(&value).await.is_ok() {
                                        model.write().notice = Some("房间码已复制".to_owned());
                                    }
                                });
                            },
                            "{snapshot.room_code}"
                        }
                        if role == RoomRole::Owner && invite.is_some() {
                            button {
                                class: "icon-button",
                                r#type: "button",
                                aria_label: "分享房间",
                                title: "分享房间",
                                onclick: move |_| share_open.set(true),
                                UiIcon { kind: UiIconKind::Share2 }
                            }
                        }
                    }
                }
                div { class: "room-role",
                    div {
                        span { "{role_copy}" }
                        strong {
                            role: "status",
                            aria_live: "polite",
                            aria_atomic: "true",
                            "{status_copy}"
                        }
                    }
                    button {
                        class: "leave-button",
                        r#type: "button",
                        aria_label: "退出房间",
                        title: "退出房间",
                        disabled: busy,
                        onclick: move |_| submit_leave(model, realtime_target),
                        UiIcon { kind: UiIconKind::LogOut }
                    }
                }
            }
            PeerFlow {
                sender,
                receivers: receivers.clone(),
                entering_receivers,
                peer_connected,
            }
            RoomTransferPanel {
                model,
                rtc_peers,
                role,
                receivers: receivers.clone(),
            }
            if let Some(notice) = notice {
                p { class: "room-notice", role: "status", "{notice}" }
            }
            if let Some(error) = error {
                p { class: "inline-error", role: "alert", "{error}" }
            }
            if share_open()
                && let Some(invite) = invite
            {
                ShareDialog {
                    model,
                    share_open,
                    room_code: snapshot.room_code.clone(),
                    capability: invite.capability,
                }
            }
            if role == RoomRole::Owner
                && let Some(request) = snapshot.pending_join_requests.first()
            {
                JoinRequestDialog {
                    key: "{request.request_id}",
                    model,
                    realtime_target,
                    request: request.clone(),
                }
            }
        }
    }
}

#[component]
fn RoomTransferPanel(
    model: Signal<AppModel>,
    rtc_peers: Signal<BTreeMap<String, RtcPeer>>,
    role: RoomRole,
    receivers: Vec<ParticipantSnapshot>,
) -> Element {
    let panel_state = use_memo(move || {
        let state = model.read();
        (
            state.rtc_config_phase,
            state.rtc_aggregate_phase,
            state.transfer.clone(),
            state
                .rtc_peer_states
                .iter()
                .map(|(peer_id, peer_state)| {
                    (
                        peer_id.clone(),
                        PeerRtcPresentation::new(
                            peer_state.phase,
                            peer_state.outgoing_recovery_is_checking(),
                        ),
                    )
                })
                .collect::<BTreeMap<_, _>>(),
            state.transfers_by_peer.clone(),
            state.text_transfer.clone(),
            state.text_transfers_by_peer.clone(),
        )
    });
    let (
        rtc_config_phase,
        aggregate_rtc,
        transfer,
        rtc_peer_presentations,
        transfers_by_peer,
        text_transfer,
        text_transfers_by_peer,
    ) = panel_state.read().clone();

    rsx! {
        TransferPanel {
            model,
            rtc_peers,
            role,
            receivers,
            rtc_config_phase,
            aggregate_rtc,
            transfer,
            rtc_peer_presentations,
            transfers_by_peer,
            text_transfer,
            text_transfers_by_peer,
        }
    }
}

fn room_shell_state(state: &AppModel) -> Option<RoomShellState> {
    let Screen::Room {
        role,
        snapshot,
        invite,
        ..
    } = &state.screen
    else {
        return None;
    };
    Some(RoomShellState {
        role: *role,
        snapshot: snapshot.clone(),
        invite: invite.clone(),
        realtime: state.realtime,
        peer_connected: state.rtc_aggregate_phase == RtcPhase::Ready,
        busy: state.busy,
        notice: state.notice.clone(),
        error: state.error.clone(),
        entering_receivers: state.entering_receivers.clone(),
    })
}

fn submit_leave(mut model: Signal<AppModel>, realtime_target: Signal<Option<RealtimeTarget>>) {
    let (room_id, room_code, revision) = {
        let state = model.read();
        let Screen::Room { snapshot, .. } = &state.screen else {
            return;
        };
        (
            snapshot.room_id.clone(),
            snapshot.room_code.clone(),
            snapshot.revision,
        )
    };
    let leave_scope = RoomLeaveScope {
        room_id,
        target: realtime_target
            .read()
            .as_ref()
            .cloned()
            .map(RealtimeTargetScope::new),
    };
    model.write().busy = true;
    spawn(async move {
        let result = leave_room(&room_code, &new_client_id("leave"), Some(revision)).await;
        if !leave_scope.is_current(&model.read(), realtime_target.read().as_ref()) {
            return;
        }
        if let Err(error) = result {
            let mut state = model.write();
            state.busy = false;
            state.error = Some(friendly_error(&error));
            return;
        }
        return_to_lobby(model, realtime_target, Some("已退出房间".to_owned()));
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_state::TransferState;
    use crate::realtime_target::member_target;
    use p2p_protocol::CURRENT_PROTOCOL;

    fn room_model() -> AppModel {
        AppModel {
            screen: Screen::Room {
                role: RoomRole::Owner,
                snapshot: RoomBootstrapResponse {
                    version: CURRENT_PROTOCOL,
                    room_id: "room-1".to_owned(),
                    room_code: "ABC234".to_owned(),
                    revision: 1,
                    expires_at_ms: 1_000,
                    participants: Vec::new(),
                    pending_join_requests: Vec::new(),
                },
                invite: None,
                invite_request_id: None,
            },
            ..AppModel::default()
        }
    }

    #[test]
    fn room_shell_selector_ignores_transfer_only_updates() {
        let mut model = room_model();
        let initial = room_shell_state(&model);

        model
            .transfers_by_peer
            .insert("peer-1".to_owned(), TransferState::Idle);
        assert!(room_shell_state(&model) == initial);

        model.notice = Some("传输完成".to_owned());
        assert!(room_shell_state(&model) != initial);
    }

    #[test]
    fn leave_scope_rejects_a_replacement_room_target() {
        let mut model = room_model();
        let target = member_target("ABC234".to_owned(), 1, "peer-owner".to_owned());
        let scope = RoomLeaveScope {
            room_id: "room-1".to_owned(),
            target: Some(RealtimeTargetScope::new(target.clone())),
        };

        assert!(scope.is_current(&model, Some(&target)));

        let replacement = member_target("ABC234".to_owned(), 1, "peer-owner".to_owned());
        assert!(!scope.is_current(&model, Some(&replacement)));

        model.screen = Screen::Lobby {
            room_code: String::new(),
            invite_capability: None,
        };
        assert!(!scope.is_current(&model, Some(&target)));
    }
}
