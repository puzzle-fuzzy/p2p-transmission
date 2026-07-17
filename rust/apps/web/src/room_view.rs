use std::collections::BTreeMap;

use dioxus::prelude::*;
use p2p_browser_platform::{RtcPeer, copy_text, leave_room, new_client_id};
use p2p_protocol::ParticipantRoleWire;

use crate::app_state::{AppModel, RealtimePhase, RoomRole, RtcPhase, Screen};
use crate::browser_errors::friendly_error;
use crate::join_request::JoinRequestDialog;
use crate::participant_presence::PeerFlow;
use crate::realtime_session::return_to_lobby;
use crate::realtime_target::RealtimeTarget;
use crate::share_dialog::ShareDialog;
use crate::transfer_panel::TransferPanel;

#[component]
pub(super) fn RoomView(
    mut model: Signal<AppModel>,
    mut realtime_target: Signal<Option<RealtimeTarget>>,
    rtc_peers: Signal<BTreeMap<String, RtcPeer>>,
) -> Element {
    let mut share_open = use_signal(|| false);
    let state = model.read().clone();
    let Screen::Room {
        role,
        snapshot,
        invite,
        ..
    } = state.screen
    else {
        return rsx! {};
    };
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
    let status_copy = match state.realtime {
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
                                "分享"
                            }
                        }
                    }
                }
                div { class: "room-role",
                    div {
                        span { "{role_copy}" }
                        strong { "{status_copy}" }
                    }
                    button {
                        class: "leave-button",
                        r#type: "button",
                        aria_label: "退出房间",
                        title: "退出房间",
                        disabled: state.busy,
                        onclick: move |_| submit_leave(model, realtime_target),
                        svg {
                            class: "leave-icon",
                            view_box: "0 0 24 24",
                            role: "presentation",
                            path {
                                d: "M13 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4",
                                fill: "none",
                                stroke: "currentColor",
                                stroke_width: "1.75",
                                stroke_linecap: "round",
                                stroke_linejoin: "round",
                            }
                            path {
                                d: "M11 8l-4 4 4 4M7 12h9",
                                fill: "none",
                                stroke: "currentColor",
                                stroke_width: "1.75",
                                stroke_linecap: "round",
                                stroke_linejoin: "round",
                            }
                        }
                    }
                }
            }
            PeerFlow {
                sender,
                receivers: receivers.clone(),
                entering_receivers: state.entering_receivers.clone(),
                peer_connected: state.rtc == RtcPhase::Ready,
            }
            TransferPanel {
                model,
                rtc_peers,
                role,
                receivers,
                rtc: state.rtc,
                transfer: state.transfer.clone(),
                rtc_by_peer: state.rtc_by_peer.clone(),
                transfers_by_peer: state.transfers_by_peer.clone(),
            }
            if let Some(notice) = state.notice {
                p { class: "room-notice", role: "status", "{notice}" }
            }
            if let Some(error) = state.error {
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
                    model,
                    realtime_target,
                    request: request.clone(),
                }
            }
        }
    }
}

fn submit_leave(mut model: Signal<AppModel>, realtime_target: Signal<Option<RealtimeTarget>>) {
    let (room_code, revision) = {
        let state = model.read();
        let Screen::Room { snapshot, .. } = &state.screen else {
            return;
        };
        (snapshot.room_code.clone(), snapshot.revision)
    };
    model.write().busy = true;
    spawn(async move {
        let result = leave_room(&room_code, &new_client_id("leave"), Some(revision)).await;
        if let Err(error) = result {
            let mut state = model.write();
            state.busy = false;
            state.error = Some(friendly_error(&error));
            return;
        }
        return_to_lobby(model, realtime_target, Some("已退出房间".to_owned()));
    });
}
