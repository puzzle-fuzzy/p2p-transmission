use std::collections::BTreeMap;

use dioxus::prelude::*;
use p2p_browser_platform::{
    RtcPeerRegistry, begin_copy_text, close_modal_dialog, leave_room, new_client_id,
    show_modal_dialog,
};
use p2p_protocol::{
    CreateInviteResponse, ParticipantRoleWire, ParticipantSnapshot, RoomBootstrapResponse,
};

use crate::app_runtime::dispatch_app_event;
use crate::app_state::{
    AppModel, RealtimePhase, RoomRole, RtcPhase, Screen, TextTransferState, TransferState,
};
use crate::app_transition::AppEvent;
use crate::browser_errors::platform_error_event;
use crate::icons::{UiIcon, UiIconKind};
use crate::join_request::JoinRequestDialog;
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
    activity: Vec<RoomActivityItem>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct RoomActivityItem {
    tone: &'static str,
    message: String,
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
    rtc_peers: Signal<RtcPeerRegistry>,
) -> Element {
    let mut share_open = use_signal(|| false);
    let mut leave_open = use_signal(|| false);
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
        ..
    } = state;
    let receivers = snapshot
        .participants
        .iter()
        .filter(|participant| {
            participant.role == ParticipantRoleWire::Receiver && participant.online
        })
        .cloned()
        .collect::<Vec<_>>();
    let room_code_for_copy = snapshot.room_code.clone();
    let status_copy = match realtime {
        RealtimePhase::Connected => "房间连接已建立",
        RealtimePhase::Superseded => "已在另一个标签页接管，本页已停止重连",
        RealtimePhase::Reconnecting => "正在重新连接房间",
        RealtimePhase::Connecting => "正在连接房间",
        RealtimePhase::Disconnected => "房间连接已断开",
    };
    rsx! {
        section { class: "room-view", aria_label: "房间状态",
            p { class: "eyebrow mono", "ROOM STATUS / FILE DELIVERY" }
            section { class: "hero room-hero", aria_labelledby: "roomTitle",
                div {
                    h1 { id: "roomTitle", class: "hero-title", "传输", br {}, "会话面板" }
                    p { class: "hero-copy",
                        "你已经进入临时房间。左侧显示房间身份和设备状态，右侧用于添加文件、发送文本并查看传输队列。"
                    }
                }
                aside { class: "hero-note",
                    p { class: "mini mono", "ROOM CODE / LOCAL DEVICE / PEER DEVICE" }
                    p { class: "mini", "文件和文本通过加密 WebRTC 通道在设备之间传输。" }
                }
            }
            section { class: "room-layout", aria_label: "传输会话",
                div { class: "room-left",
                    article { class: "panel panel--blue room-identity",
                        p { class: "panel-number", aria_hidden: "true", if role == RoomRole::Owner { "01" } else { "02" } }
                        p { class: "panel-label mono", if role == RoomRole::Owner { "HOST MODE" } else { "GUEST MODE" } }
                        h2 { class: "panel-title room-code-title", "房间 {snapshot.room_code}" }
                        p { class: "panel-desc", "当前会话为一次性临时传输。离开页面后，演示状态会被清空。" }
                        div { class: "meta-row room-meta",
                            span { class: "chip chip--light",
                                span { class: "dot live" }
                                span { class: "mono", "LOCAL READY" }
                            }
                            span { class: "chip chip--light",
                                span { class: if peer_connected { "dot live" } else { "dot wait" } }
                                span {
                                    class: "mono",
                                    role: "status",
                                    aria_label: if peer_connected {
                                        format!("{} 位接收者已连接", receivers.len())
                                    } else {
                                        "等待其他成员连接".to_owned()
                                    },
                                    if peer_connected { "PEER CONNECTED" } else { "PEER WAITING" }
                                }
                            }
                        }
                        div { class: "actions room-actions",
                            button {
                                class: "btn btn--solid mono room-code-copy",
                                r#type: "button",
                                aria_label: "复制房间码 {snapshot.room_code}",
                                title: "复制房间码",
                                onclick: move |_| {
                                    let value = room_code_for_copy.clone();
                                    let copy = begin_copy_text(&value);
                                    spawn(async move {
                                        if copy.await.is_ok() {
                                            dispatch_app_event(model, AppEvent::SetNotice(Some("房间码已复制".to_owned())));
                                        } else {
                                            dispatch_app_event(model, AppEvent::SetError(Some("无法复制房间码，请手动选择后复制".to_owned())));
                                        }
                                    });
                                },
                                "{snapshot.room_code}"
                            }
                            if role == RoomRole::Owner && invite.is_some() {
                                button {
                                    class: "btn mono icon-button",
                                    r#type: "button",
                                    aria_label: "分享房间",
                                    title: "分享房间",
                                    onclick: move |_| share_open.set(true),
                                    UiIcon { kind: UiIconKind::Share2 }
                                    span { "分享" }
                                }
                            }
                            button {
                                class: "btn mono leave-button",
                                r#type: "button",
                                aria_label: "退出房间",
                                title: "退出房间",
                                disabled: busy,
                                onclick: move |_| leave_open.set(true),
                                UiIcon { kind: UiIconKind::LogOut }
                                span { if busy { "正在退出" } else { "离开房间" } }
                            }
                        }
                    }
                    div { class: "status-grid",
                        article { class: "status-item",
                            p { class: "key mono", "LOCAL DEVICE" }
                            p { class: "value", if role == RoomRole::Owner { "HOST" } else { "GUEST" } }
                            p { class: "sub", if role == RoomRole::Owner { "创建者 / 发起连接" } else { "加入者 / 请求连接" } }
                        }
                        article { class: "status-item",
                            p { class: "key mono", "PEER STATUS" }
                            p { class: "value", if peer_connected { "ONLINE" } else { "WAITING" } }
                            p { class: "sub", if peer_connected { "已连接，可开始传输" } else { "等待另一台设备接入" } }
                        }
                    }
                    div { class: "mini-list",
                        article { class: "mini-cell",
                            span { class: "n", aria_hidden: "true", "A" }
                            div { p { class: "t", "端到端会话" } p { class: "s mono", "DIRECT CHANNEL" } }
                        }
                        article { class: "mini-cell",
                            span { class: "n", aria_hidden: "true", "B" }
                            div { p { class: "t", "临时房间机制" } p { class: "s mono", "6 DIGIT CODE" } }
                        }
                        article { class: "mini-cell",
                            span { class: "n", aria_hidden: "true", "C" }
                            div { p { class: "t", "拖拽与发送" } p { class: "s mono", "DROP / SELECT / SEND" } }
                        }
                    }
                }
                div { class: "room-right",
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
                }
                footer { class: "footerline room-footer",
                    span { class: "mono", "WEBRTC / ENCRYPTED / SESSION ACTIVE" }
                    span { class: "mono", id: "fileCountFooter", "0 FILES" }
                }
            }
            p { class: "room-connection-copy sr-only", role: "status", aria_live: "polite", aria_atomic: "true", "{status_copy}" }
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
            if leave_open() {
                LeaveRoomDialog {
                    busy,
                    open: leave_open,
                    on_confirm: move |_| {
                        leave_open.set(false);
                        submit_leave(model, realtime_target);
                    },
                }
            }
        }
    }
}

#[component]
fn LeaveRoomDialog(busy: bool, mut open: Signal<bool>, on_confirm: EventHandler<()>) -> Element {
    use_effect(move || {
        let _ = show_modal_dialog("leave-room-dialog");
    });

    rsx! {
        dialog {
            id: "leave-room-dialog",
            class: "leave-room-dialog",
            aria_labelledby: "leave-room-title",
            oncancel: move |event| {
                event.prevent_default();
                close_leave_dialog(open);
            },
            div { class: "leave-dialog-icon", aria_hidden: "true",
                UiIcon { kind: UiIconKind::LogOut }
            }
            p { class: "eyebrow", "End session" }
            h2 { id: "leave-room-title", "离开这个房间？" }
            p { class: "leave-dialog-copy",
                "离开后会结束当前设备上的连接与传输；已完成的下载不受影响。"
            }
            div { class: "dialog-actions",
                button {
                    class: "btn btn--ghost",
                    r#type: "button",
                    disabled: busy,
                    onclick: move |_| close_leave_dialog(open),
                    "继续留在房间"
                }
                button {
                    class: "btn btn--dark leave-confirm-button",
                    r#type: "button",
                    disabled: busy,
                    onclick: move |_| {
                        let _ = close_modal_dialog("leave-room-dialog");
                        on_confirm.call(());
                    },
                    if busy { "正在退出" } else { "确认离开" }
                }
            }
        }
    }
}

fn close_leave_dialog(mut open: Signal<bool>) {
    let _ = close_modal_dialog("leave-room-dialog");
    open.set(false);
}

#[component]
fn RoomTransferPanel(
    model: Signal<AppModel>,
    rtc_peers: Signal<RtcPeerRegistry>,
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
        activity: room_activity(state),
    })
}

fn room_activity(state: &AppModel) -> Vec<RoomActivityItem> {
    let mut activity = vec![RoomActivityItem {
        tone: if state.realtime == RealtimePhase::Connected {
            "ready"
        } else {
            "pending"
        },
        message: match state.realtime {
            RealtimePhase::Connected => "加密房间连接已建立".to_owned(),
            RealtimePhase::Reconnecting => "房间连接中断，正在恢复".to_owned(),
            RealtimePhase::Superseded => "房间已在另一个标签页接管".to_owned(),
            RealtimePhase::Connecting => "正在连接房间".to_owned(),
            RealtimePhase::Disconnected => "房间连接已断开".to_owned(),
        },
    }];

    activity.push(RoomActivityItem {
        tone: if state.rtc_aggregate_phase == RtcPhase::Ready {
            "ready"
        } else {
            "pending"
        },
        message: match state.rtc_aggregate_phase {
            RtcPhase::Ready => "点对点数据通道已就绪".to_owned(),
            RtcPhase::Connecting => "正在协商点对点数据通道".to_owned(),
            RtcPhase::WaitingPeer => "等待其他成员建立数据通道".to_owned(),
            RtcPhase::Failed => "数据通道建立失败，可以稍后重试".to_owned(),
            RtcPhase::Disconnected => "数据通道已断开".to_owned(),
            RtcPhase::Inactive => "等待成员加入房间".to_owned(),
        },
    });

    if let Some(message) = transfer_activity(&state.transfer) {
        activity.push(message);
    }
    if let Some(message) = text_activity(&state.text_transfer) {
        activity.push(message);
    }
    activity
}

fn transfer_activity(transfer: &TransferState) -> Option<RoomActivityItem> {
    let (tone, message) = match transfer {
        TransferState::Idle => return None,
        TransferState::Offering { files, .. } => (
            "pending",
            format!("已发起 {} 个文件的传输请求", files.len().max(1)),
        ),
        TransferState::OutgoingRecovery { .. } => ("pending", "正在恢复文件发送".to_owned()),
        TransferState::Incoming { files, .. } => (
            "pending",
            format!("收到 {} 个文件的传输请求", files.len().max(1)),
        ),
        TransferState::Active { .. } => ("active", "文件正在通过加密通道传输".to_owned()),
        TransferState::Rejected { .. } => ("muted", "文件传输请求已拒绝".to_owned()),
        TransferState::Completed { .. } => ("ready", "文件传输与完整性校验已完成".to_owned()),
        TransferState::Cancelled { .. } => ("muted", "文件传输已取消".to_owned()),
        TransferState::Failed { message, .. } => ("error", format!("文件传输失败：{message}")),
    };
    Some(RoomActivityItem { tone, message })
}

fn text_activity(transfer: &TextTransferState) -> Option<RoomActivityItem> {
    let (tone, message) = match transfer {
        TextTransferState::Idle => return None,
        TextTransferState::Offering { .. } | TextTransferState::Incoming { .. } => {
            ("pending", "文本传输正在等待确认".to_owned())
        }
        TextTransferState::Sending { .. } | TextTransferState::Receiving { .. } => {
            ("active", "文本正在通过加密通道传输".to_owned())
        }
        TextTransferState::Delivered { .. } | TextTransferState::Received { .. } => {
            ("ready", "文本已送达".to_owned())
        }
        TextTransferState::Rejected { .. } => ("muted", "文本传输请求已拒绝".to_owned()),
        TextTransferState::Cancelled => ("muted", "文本传输已取消".to_owned()),
        TextTransferState::Failed { message } => ("error", format!("文本传输失败：{message}")),
    };
    Some(RoomActivityItem { tone, message })
}

fn submit_leave(model: Signal<AppModel>, realtime_target: Signal<Option<RealtimeTarget>>) {
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
    dispatch_app_event(model, AppEvent::SetBusy(true));
    spawn(async move {
        let result = leave_room(&room_code, &new_client_id("leave"), Some(revision)).await;
        if !leave_scope.is_current(&model.read(), realtime_target.read().as_ref()) {
            return;
        }
        if let Err(error) = result {
            dispatch_app_event(model, AppEvent::SetBusy(false));
            dispatch_app_event(model, platform_error_event(&error));
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
