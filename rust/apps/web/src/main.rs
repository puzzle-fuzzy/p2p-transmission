use std::collections::BTreeMap;

use dioxus::prelude::*;
use p2p_browser_platform::{
    BrowserPlatformError, LaunchIntent, RealtimeConnection, RealtimeEvent, RtcPeer,
    activate_app_mount, bootstrap_room, clear_room_session, copy_text, create_invite, create_room,
    create_session, decide_join, fetch_rtc_config, join_request_status, leave_room,
    mark_app_interactive, new_client_id, prime_notification_permission, request_join,
    show_modal_dialog, take_launch_intent,
};
use p2p_protocol::{
    JoinDecisionRequest, JoinRequestSnapshot, JoinRequestStateWire, ParticipantRoleWire,
    RoomBootstrapResponse, RtcConfigResponse, SessionResponse,
};
use p2p_ui_shell::{
    CREATE_ROOM_LABEL, JOIN_REQUEST_LABEL, LobbyFeedback, LobbyShell, ROOM_CODE_LENGTH,
};

mod about;
mod app_state;
mod browser_errors;
mod browser_lifecycle;
mod participant_presence;
mod realtime_connection;
mod realtime_runtime;
mod realtime_session;
mod realtime_target;
mod room_code_input;
mod room_session;
mod rtc_orchestration;
mod rtc_session;
mod rtc_transfer_events;
mod share_dialog;
mod transfer_actions;
mod transfer_panel;
mod transfer_presentation;

use about::{AboutDialog, FooterLinks};
use app_state::{
    AppModel, RealtimePhase, RoomRole, RtcPhase, Screen, StoredRoomSession, TransferState,
};
use browser_errors::friendly_error;
use browser_lifecycle::{sync_lifecycle_recovery_target, use_browser_lifecycle};
use participant_presence::{Avatar, PeerFlow};
use realtime_connection::{
    RealtimeLease, current_realtime_target_scope, realtime_target_is_suppressed,
    realtime_target_scope_is_current, use_realtime_connection,
};
use realtime_runtime::{
    LifecycleState, RealtimeConnectionRuntime, RealtimeConnectionState, RealtimeSessionRuntime,
    RtcRuntime,
};
use realtime_session::{
    apply_authoritative_snapshot, apply_snapshot, enter_receiver_room, handle_realtime_event,
    return_to_lobby, schedule_avatar_cleanup,
};
use realtime_target::{RealtimeTarget, RealtimeTargetScope, join_watch_target, member_target};
use room_code_input::RoomCodeInput;
use room_session::{persist_room_session, restored_room_session};
use rtc_session::{accept_rtc_signal, reset_all_rtc_peers, sync_rtc_peers};
use share_dialog::ShareDialog;
use transfer_panel::TransferPanel;

fn main() {
    console_error_panic_hook::set_once();
    dioxus::launch(App);
}

#[allow(non_snake_case)]
fn App() -> Element {
    let mut model = use_signal(AppModel::default);
    let realtime_target = use_signal(|| None::<RealtimeTarget>);
    let connection = use_signal(|| None::<RealtimeConnection>);
    let realtime_connection = RealtimeConnectionRuntime {
        trigger: use_signal(|| 0_u64),
        state: use_signal(RealtimeConnectionState::default),
    };
    let rtc_peers = use_signal(BTreeMap::<String, RtcPeer>::new);
    let mut rtc_config = use_signal(|| None::<RtcConfigResponse>);
    let lifecycle_state = use_signal(LifecycleState::default);
    let rtc_runtime = RtcRuntime {
        connection,
        peers: rtc_peers,
        config: rtc_config,
    };
    let realtime_runtime = RealtimeSessionRuntime {
        model,
        target: realtime_target,
        connection: realtime_connection,
        rtc: rtc_runtime,
        lifecycle_state,
    };

    let apply_lifecycle_snapshot = Callback::new(
        move |(lease, snapshot): (RealtimeLease, RoomBootstrapResponse)| {
            if let Some(entering) = apply_authoritative_snapshot(realtime_runtime, &lease, snapshot)
            {
                schedule_avatar_cleanup(model, entering);
            }
        },
    );
    use_browser_lifecycle(realtime_runtime, apply_lifecycle_snapshot);

    let sync_lifecycle_target = Callback::new(move |scope: Option<RealtimeTargetScope>| {
        sync_lifecycle_recovery_target(lifecycle_state, scope.as_ref());
    });
    let dispatch_realtime_event =
        Callback::new(move |(lease, event): (RealtimeLease, RealtimeEvent)| {
            handle_realtime_event(realtime_runtime, lease, event);
        });
    use_realtime_connection(
        realtime_runtime,
        dispatch_realtime_event,
        sync_lifecycle_target,
    );

    use_effect(move || initialize(model, realtime_target));
    use_effect(move || {
        let state = model.read();
        if matches!(state.screen, Screen::Booting) {
            return;
        }
        let session_ready = state.session.is_some();
        drop(state);
        activate_app_mount();
        if !session_ready {
            return;
        }
        mark_app_interactive();
    });

    use_effect(move || {
        let target = realtime_target.read().clone();
        reset_all_rtc_peers(rtc_peers);
        rtc_config.set(None);
        if !target.as_ref().is_some_and(RealtimeTarget::is_member) {
            let mut state = model.write();
            state.rtc = RtcPhase::Inactive;
            state.transfer = TransferState::Idle;
            state.pending_signals.clear();
            state.rtc_by_peer.clear();
            state.transfers_by_peer.clear();
            return;
        }
        let Some(target_scope) = current_realtime_target_scope(realtime_target) else {
            return;
        };
        model.write().rtc = RtcPhase::WaitingPeer;
        spawn(async move {
            let config_result = fetch_rtc_config().await;
            if !realtime_target_scope_is_current(&target_scope, realtime_target)
                || realtime_target_is_suppressed(realtime_connection, realtime_target)
            {
                return;
            }
            let config = match config_result {
                Ok(config) => config,
                Err(error) => {
                    let mut state = model.write();
                    state.rtc = RtcPhase::Failed;
                    state.error = Some(friendly_error(&error));
                    return;
                }
            };
            rtc_config.set(Some(config));
            sync_rtc_peers(model, connection, rtc_peers, rtc_config);
            let pending = std::mem::take(&mut model.write().pending_signals);
            for (from_peer, signal) in pending {
                accept_rtc_signal(model, connection, rtc_peers, rtc_config, from_peer, signal);
            }
        });
    });

    let snapshot = model.read().clone();
    rsx! {
        match &snapshot.screen {
            Screen::Booting => rsx! {},
            Screen::Lobby { .. } => rsx! { LobbyView { model, realtime_target } },
            Screen::Waiting { .. } => rsx! {
                div { class: "app-shell",
                    main { class: "lobby",
                        WaitingView { model, realtime_target }
                    }
                }
            },
            Screen::Room { .. } => rsx! {
                div { class: "app-shell",
                    main { class: "workspace",
                        RoomView { model, realtime_target, rtc_peers }
                    }
                }
            },
        }
        if snapshot.about_open {
            AboutDialog { model }
        }
    }
}

fn initialize(mut model: Signal<AppModel>, target: Signal<Option<RealtimeTarget>>) {
    spawn(async move {
        let launch_intent = take_launch_intent().ok().flatten();
        let (initial_room_code, invite_capability) = match &launch_intent {
            Some(LaunchIntent::JoinRoom {
                room_code,
                capability,
            }) => (room_code.clone(), capability.clone()),
            _ => (String::new(), None),
        };
        let stored_room_session = restored_room_session();
        let identity = new_client_id("visitor");
        let suffix = identity
            .chars()
            .rev()
            .take(4)
            .collect::<String>()
            .chars()
            .rev()
            .collect::<String>()
            .to_ascii_uppercase();
        let session = match create_session(&format!("访客 {suffix}")).await {
            Ok(session) => session,
            Err(error) => {
                let mut state = model.write();
                state.screen = Screen::Lobby {
                    room_code: initial_room_code,
                    invite_capability,
                };
                state.error = Some(friendly_error(&error));
                return;
            }
        };
        model.write().session = Some(session.clone());

        if let Some(stored) = stored_room_session
            && restore_room(model, target, &session, stored).await
        {
            return;
        }

        model.write().screen = Screen::Lobby {
            room_code: initial_room_code,
            invite_capability,
        };
        match launch_intent {
            Some(LaunchIntent::CreateRoom) => submit_create_room(model, target),
            Some(LaunchIntent::JoinRoom { .. }) => submit_join(model, target),
            None => {}
        }
    });
}

async fn restore_room(
    mut model: Signal<AppModel>,
    mut target: Signal<Option<RealtimeTarget>>,
    session: &SessionResponse,
    stored: StoredRoomSession,
) -> bool {
    let Ok(snapshot) = bootstrap_room(&stored.room_code).await else {
        let _ = clear_room_session();
        return false;
    };
    if let Some(participant) = snapshot
        .participants
        .iter()
        .find(|participant| participant.session_id == session.session_id)
    {
        let role = match participant.role {
            ParticipantRoleWire::Owner => RoomRole::Owner,
            ParticipantRoleWire::Receiver => RoomRole::Receiver,
        };
        let invite = if role == RoomRole::Owner {
            if let Some(request_id) = &stored.invite_request_id {
                create_invite(&stored.room_code, request_id).await.ok()
            } else {
                None
            }
        } else {
            None
        };
        let revision = snapshot.revision;
        let room_code = snapshot.room_code.clone();
        {
            let mut state = model.write();
            state.screen = Screen::Room {
                role,
                snapshot,
                invite,
                invite_request_id: stored.invite_request_id.clone(),
            };
            if role == RoomRole::Owner {
                state.notice = Some("房间已创建，可以分享邀请链接".to_owned());
            }
        }
        let peer_id = stored.peer_id.clone();
        persist_room_session(&StoredRoomSession {
            room_code: room_code.clone(),
            role,
            join_request_id: stored.join_request_id,
            invite_request_id: stored.invite_request_id.clone(),
            peer_id: peer_id.clone(),
        });
        target.set(Some(member_target(room_code, revision, peer_id)));
        return true;
    }

    if let Some(request_id) = stored.join_request_id
        && let Ok(status) = join_request_status(&stored.room_code, &request_id).await
    {
        match status.state {
            JoinRequestStateWire::Pending => {
                model.write().screen = Screen::Waiting {
                    room_code: stored.room_code.clone(),
                    request_id: request_id.clone(),
                    peer_id: stored.peer_id.clone(),
                    revision: status.revision,
                    expires_at_ms: status.expires_at_ms,
                };
                target.set(Some(join_watch_target(
                    stored.room_code.clone(),
                    request_id.clone(),
                    status.revision,
                )));
                return true;
            }
            JoinRequestStateWire::Approved => {
                enter_receiver_room(model, target, snapshot, request_id, stored.peer_id);
                return true;
            }
            JoinRequestStateWire::Rejected
            | JoinRequestStateWire::Cancelled
            | JoinRequestStateWire::Expired => {}
        }
    }
    let _ = clear_room_session();
    false
}

#[component]
fn LobbyView(
    mut model: Signal<AppModel>,
    mut realtime_target: Signal<Option<RealtimeTarget>>,
) -> Element {
    let snapshot = model.read().clone();
    let (room_code, invite_capability) = match &snapshot.screen {
        Screen::Lobby {
            room_code,
            invite_capability,
        } => (room_code.clone(), invite_capability.clone()),
        _ => return rsx! {},
    };
    let can_join =
        room_code.len() == ROOM_CODE_LENGTH && !snapshot.busy && snapshot.session.is_some();
    let feedback = snapshot
        .error
        .clone()
        .map(LobbyFeedback::error)
        .unwrap_or_default();
    let primary_label = if snapshot.busy {
        "申请中…"
    } else if invite_capability.is_some() {
        "加入房间"
    } else {
        JOIN_REQUEST_LABEL
    };
    let secondary_label = if snapshot.busy {
        "创建中…"
    } else {
        CREATE_ROOM_LABEL
    };

    rsx! {
        LobbyShell {
            room_code: rsx! {
                RoomCodeInput {
                    value: room_code,
                    disabled: snapshot.busy,
                    invalid: snapshot.error.is_some(),
                    on_change: move |value| {
                        let mut state = model.write();
                        if let Screen::Lobby { room_code, invite_capability } = &mut state.screen {
                            *room_code = value;
                            *invite_capability = None;
                        }
                        state.error = None;
                    }
                }
            },
            footer: rsx! { FooterLinks { model } },
            feedback,
            invite_ready: invite_capability.is_some(),
            primary_label: primary_label.to_owned(),
            primary_disabled: !can_join,
            secondary_label: secondary_label.to_owned(),
            secondary_disabled: snapshot.busy || snapshot.session.is_none(),
            on_submit: move |_| {
                let join_ready = {
                    let state = model.read();
                    !state.busy
                        && state.session.is_some()
                        && matches!(
                            &state.screen,
                            Screen::Lobby { room_code, .. }
                                if room_code.len() == ROOM_CODE_LENGTH
                        )
                };
                if join_ready {
                    let _ = prime_notification_permission();
                    submit_join(model, realtime_target);
                }
            },
            on_create: move |_| {
                let _ = prime_notification_permission();
                submit_create_room(model, realtime_target);
            },
        }
    }
}

fn submit_create_room(
    mut model: Signal<AppModel>,
    mut realtime_target: Signal<Option<RealtimeTarget>>,
) {
    if model.read().busy || model.read().session.is_none() {
        return;
    }
    model.write().busy = true;
    model.write().error = None;
    spawn(async move {
        let create_request_id = new_client_id("create");
        let invite_request_id = new_client_id("invite");
        let result = async {
            let room = create_room(&create_request_id).await?;
            let invite = create_invite(&room.room_code, &invite_request_id).await?;
            let snapshot = bootstrap_room(&room.room_code).await?;
            Ok::<_, BrowserPlatformError>((snapshot, invite))
        }
        .await;
        match result {
            Ok((snapshot, invite)) => {
                let peer_id = new_client_id("peer");
                let stored = StoredRoomSession {
                    room_code: snapshot.room_code.clone(),
                    role: RoomRole::Owner,
                    join_request_id: None,
                    invite_request_id: Some(invite_request_id.clone()),
                    peer_id: peer_id.clone(),
                };
                persist_room_session(&stored);
                let revision = snapshot.revision;
                let room_code = snapshot.room_code.clone();
                {
                    let mut state = model.write();
                    state.busy = false;
                    state.notice = Some("房间已创建，可以分享邀请链接".to_owned());
                    state.screen = Screen::Room {
                        role: RoomRole::Owner,
                        snapshot,
                        invite: Some(invite),
                        invite_request_id: Some(invite_request_id),
                    };
                }
                realtime_target.set(Some(member_target(room_code, revision, peer_id)));
            }
            Err(error) => {
                let mut state = model.write();
                state.busy = false;
                state.error = Some(friendly_error(&error));
            }
        }
    });
}

fn submit_join(mut model: Signal<AppModel>, mut realtime_target: Signal<Option<RealtimeTarget>>) {
    let snapshot = model.read().clone();
    let Screen::Lobby {
        room_code,
        invite_capability,
    } = snapshot.screen
    else {
        return;
    };
    if snapshot.busy || room_code.len() != ROOM_CODE_LENGTH || snapshot.session.is_none() {
        return;
    }
    model.write().busy = true;
    model.write().error = None;
    spawn(async move {
        let request_id = new_client_id("join");
        match request_join(&room_code, &request_id, None, invite_capability.clone()).await {
            Ok(response) => {
                let peer_id = new_client_id("peer");
                persist_room_session(&StoredRoomSession {
                    room_code: room_code.clone(),
                    role: RoomRole::Receiver,
                    join_request_id: Some(request_id.clone()),
                    invite_request_id: None,
                    peer_id: peer_id.clone(),
                });
                {
                    let mut state = model.write();
                    state.busy = false;
                    state.screen = Screen::Waiting {
                        room_code: room_code.clone(),
                        request_id: request_id.clone(),
                        peer_id,
                        revision: response.revision,
                        expires_at_ms: response.expires_at_ms,
                    };
                }
                realtime_target.set(Some(join_watch_target(
                    room_code.clone(),
                    request_id.clone(),
                    response.revision,
                )));
            }
            Err(error) => {
                let mut state = model.write();
                state.busy = false;
                state.error = Some(friendly_error(&error));
            }
        }
    });
}

#[component]
fn WaitingView(
    mut model: Signal<AppModel>,
    mut realtime_target: Signal<Option<RealtimeTarget>>,
) -> Element {
    let snapshot = model.read().clone();
    let Screen::Waiting {
        room_code,
        expires_at_ms,
        ..
    } = snapshot.screen
    else {
        return rsx! {};
    };
    let session = snapshot.session.clone();
    let realtime_copy = match snapshot.realtime {
        RealtimePhase::Connected => "已送达发送者，正在等待确认",
        RealtimePhase::Reconnecting => "连接中断，正在重新连接",
        RealtimePhase::Superseded => "已在另一个标签页接管，本页已停止重连",
        _ => "正在连接房间",
    };

    rsx! {
        section { class: "waiting-view", aria_labelledby: "waiting-title",
            if let Some(session) = session {
                Avatar { seed: session.session_id, label: session.display_name.clone(), entering: false, highlighted: false }
                p { class: "participant-name", "{session.display_name}" }
            }
            p { class: "subtle-copy", "正在申请加入房间" }
            div { class: "waiting-card",
                h1 { id: "waiting-title", "等待发送者确认" }
                p { class: "waiting-code", "{room_code}" }
                p { class: "waiting-status", role: "status", "{realtime_copy}" }
                p { class: "waiting-expiry", "申请会在房间授权过期后自动失效" }
                span { class: "sr-only", "授权过期时间 {expires_at_ms}" }
            }
            if let Some(error) = snapshot.error {
                p { class: "inline-error", role: "alert", "{error}" }
            }
            button {
                class: "secondary-button waiting-change-button",
                r#type: "button",
                disabled: snapshot.busy,
                onclick: move |_| submit_cancel_waiting(model, realtime_target),
                if snapshot.busy { "正在取消…" } else { "更换房间" }
            }
        }
    }
}

fn submit_cancel_waiting(
    mut model: Signal<AppModel>,
    realtime_target: Signal<Option<RealtimeTarget>>,
) {
    let (room_code, revision) = {
        let state = model.read();
        let Screen::Waiting {
            room_code,
            revision,
            ..
        } = &state.screen
        else {
            return;
        };
        (room_code.clone(), *revision)
    };
    model.write().busy = true;
    spawn(async move {
        match leave_room(&room_code, &new_client_id("cancel_join"), Some(revision)).await {
            Ok(_) => return_to_lobby(model, realtime_target, None),
            Err(error) => {
                let mut state = model.write();
                state.busy = false;
                state.error = Some(friendly_error(&error));
            }
        }
    });
}

#[component]
fn RoomView(
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

#[component]
fn JoinRequestDialog(
    mut model: Signal<AppModel>,
    realtime_target: Signal<Option<RealtimeTarget>>,
    request: JoinRequestSnapshot,
) -> Element {
    use_effect(|| {
        let _ = show_modal_dialog("join-request-dialog");
    });
    let state = model.read().clone();
    let pending = state.decision_request_id.is_some();
    rsx! {
        dialog {
                id: "join-request-dialog",
                class: "join-request-dialog",
                aria_labelledby: "join-request-title",
                oncancel: move |event| event.prevent_default(),
                div { class: "request-person",
                    Avatar { seed: request.session_id.clone(), label: request.display_name.clone(), entering: false, highlighted: false }
                    div {
                        h2 { id: "join-request-title", "加入申请" }
                        p { "{request.display_name}" }
                    }
                }
                div { class: "request-summary",
                    p { "请求加入当前房间" }
                    span { "申请将在授权时间结束后失效" }
                }
                div { class: "dialog-actions",
                    button {
                        class: "secondary-button",
                        r#type: "button",
                        disabled: pending,
                        onclick: {
                            let request_id = request.request_id.clone();
                            move |_| {
                                submit_decision(
                                    model,
                                    realtime_target,
                                    request_id.clone(),
                                    JoinDecisionRequest::Reject,
                                )
                            }
                        },
                        if pending { "处理中…" } else { "拒绝" }
                    }
                    button {
                        class: "primary-button",
                        r#type: "button",
                        disabled: pending,
                        onclick: {
                            let request_id = request.request_id.clone();
                            move |_| {
                                submit_decision(
                                    model,
                                    realtime_target,
                                    request_id.clone(),
                                    JoinDecisionRequest::Approve,
                                )
                            }
                        },
                        if pending { "处理中…" } else { "允许加入" }
                    }
                }
        }
    }
}

fn decision_operation_is_current(
    model: Signal<AppModel>,
    realtime_target: Signal<Option<RealtimeTarget>>,
    target_scope: &RealtimeTargetScope,
    request_id: &str,
) -> bool {
    realtime_target_scope_is_current(target_scope, realtime_target)
        && model.peek().decision_request_id.as_deref() == Some(request_id)
}

fn submit_decision(
    mut model: Signal<AppModel>,
    realtime_target: Signal<Option<RealtimeTarget>>,
    request_id: String,
    decision: JoinDecisionRequest,
) {
    if model.read().decision_request_id.is_some() {
        return;
    }
    let Some(target_scope) = current_realtime_target_scope(realtime_target) else {
        return;
    };
    let (room_code, revision) = {
        let state = model.read();
        let Screen::Room { snapshot, .. } = &state.screen else {
            return;
        };
        (snapshot.room_code.clone(), snapshot.revision)
    };
    model.write().decision_request_id = Some(request_id.clone());
    spawn(async move {
        let decision_result = decide_join(&room_code, &request_id, decision, Some(revision)).await;
        if !decision_operation_is_current(model, realtime_target, &target_scope, &request_id) {
            return;
        }

        let result = match decision_result {
            Ok(_) => bootstrap_room(&room_code).await,
            Err(error) => Err(error),
        };
        if !decision_operation_is_current(model, realtime_target, &target_scope, &request_id) {
            return;
        }

        match result {
            Ok(snapshot) => {
                let entering = apply_snapshot(&mut model.write(), snapshot);
                if let Some(entering) = entering {
                    schedule_avatar_cleanup(model, entering);
                }
            }
            Err(error) => model.write().error = Some(friendly_error(&error)),
        }
        if decision_operation_is_current(model, realtime_target, &target_scope, &request_id) {
            model.write().decision_request_id = None;
        }
    });
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
