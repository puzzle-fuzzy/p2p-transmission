use std::{collections::BTreeMap, fmt::Write as _};

use dioxus::prelude::*;
use p2p_browser_platform::{
    BrowserPlatformError, BrowserStorageErrorKind, LaunchIntent, NativeShareOutcome,
    RealtimeConnection, RtcPeer, TransferDirection, TransferFile, activate_app_mount,
    bootstrap_room, build_invite_url, clear_room_session, close_modal_dialog, copy_text,
    create_invite, create_room, create_session, decide_join, fetch_rtc_config, join_request_status,
    leave_room, load_room_session, mark_app_interactive, native_share_supported, new_client_id,
    prime_notification_permission, request_join, save_room_session, share_url, show_modal_dialog,
    take_launch_intent,
};
use p2p_protocol::{
    CancelReason, CreateInviteResponse, JoinDecisionRequest, JoinRequestSnapshot,
    JoinRequestStateWire, ParticipantRoleWire, ParticipantSnapshot, RoomBootstrapResponse,
    RtcConfigResponse, SessionResponse, Signal as ProtocolSignal, StreamPauseReason, TransferMode,
};
use serde::{Deserialize, Serialize};

mod browser_lifecycle;
mod realtime_connection;
mod realtime_session;
mod room_code_input;
mod rtc_orchestration;
mod rtc_session;
mod rtc_transfer_events;
mod transfer_actions;
mod transfer_panel;
mod transfer_presentation;

use browser_lifecycle::{LifecycleState, complete_lifecycle_recovery, use_browser_lifecycle};
use realtime_connection::{
    RealtimeConnectionRuntime, RealtimeConnectionState, RealtimeTargetScope,
    current_realtime_target_scope, realtime_target_is_suppressed, realtime_target_scope_is_current,
    use_realtime_connection,
};
use realtime_session::{
    RealtimeSessionRuntime, RealtimeTarget, apply_snapshot, enter_receiver_room, join_watch_target,
    member_target, return_to_lobby, schedule_avatar_cleanup,
};
use room_code_input::RoomCodeInput;
use rtc_session::{accept_rtc_signal, reset_all_rtc_peers, sync_rtc_peers};
use transfer_panel::TransferPanel;

const QR_QUIET_ZONE_MODULES: usize = 4;

#[derive(Clone, Debug, Eq, PartialEq)]
struct InviteQrCode {
    view_box: String,
    path: String,
}

fn invite_qr_code(url: &str) -> Option<InviteQrCode> {
    let code = qrcode::QrCode::new(url.as_bytes()).ok()?;
    let width = code.width();
    let mut path = String::new();

    for (index, color) in code.into_colors().into_iter().enumerate() {
        if color == qrcode::Color::Dark {
            let x = index % width + QR_QUIET_ZONE_MODULES;
            let y = index / width + QR_QUIET_ZONE_MODULES;
            write!(&mut path, "M{x} {y}h1v1h-1z").ok()?;
        }
    }

    let size = width + QR_QUIET_ZONE_MODULES * 2;
    Some(InviteQrCode {
        view_box: format!("0 0 {size} {size}"),
        path,
    })
}

fn main() {
    console_error_panic_hook::set_once();
    dioxus::launch(App);
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum RoomRole {
    Owner,
    Receiver,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
struct StoredRoomSession {
    room_code: String,
    role: RoomRole,
    join_request_id: Option<String>,
    invite_request_id: Option<String>,
    peer_id: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RealtimePhase {
    Disconnected,
    Connecting,
    Connected,
    Reconnecting,
    Superseded,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RtcPhase {
    Inactive,
    WaitingPeer,
    Connecting,
    Ready,
    Disconnected,
    Failed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TransferLinkState {
    Ready,
    Waiting,
    Paused,
}

#[derive(Clone, Debug, PartialEq)]
enum TransferState {
    Idle,
    Offering {
        transfer_id: String,
        file: TransferFile,
        files: Vec<TransferFile>,
    },
    OutgoingRecovery {
        transfer_id: String,
        file: TransferFile,
        files: Vec<TransferFile>,
    },
    Incoming {
        transfer_id: String,
        mode: TransferMode,
        file: TransferFile,
        files: Vec<TransferFile>,
        recovery_available: bool,
    },
    Active {
        transfer_id: String,
        direction: TransferDirection,
        streamed: bool,
        file: TransferFile,
        files: Vec<TransferFile>,
        completed_bytes: u64,
        awaiting_verification: bool,
        link_state: TransferLinkState,
        storage_pause: Option<StreamPauseReason>,
    },
    Rejected {
        direction: TransferDirection,
        file: TransferFile,
        files: Vec<TransferFile>,
    },
    Completed {
        direction: TransferDirection,
        file: TransferFile,
        files: Vec<TransferFile>,
        blake3: String,
        download_url: Option<String>,
    },
    Cancelled {
        file: Option<TransferFile>,
        reason: CancelReason,
    },
    Failed {
        file: Option<TransferFile>,
        message: String,
    },
}

#[derive(Clone, Debug, PartialEq)]
enum Screen {
    Booting,
    Lobby {
        room_code: String,
        invite_capability: Option<String>,
    },
    Waiting {
        room_code: String,
        request_id: String,
        peer_id: String,
        revision: u64,
        expires_at_ms: u64,
    },
    Room {
        role: RoomRole,
        snapshot: RoomBootstrapResponse,
        invite: Option<CreateInviteResponse>,
        invite_request_id: Option<String>,
    },
}

#[derive(Clone, Debug, PartialEq)]
struct AppModel {
    session: Option<SessionResponse>,
    screen: Screen,
    realtime: RealtimePhase,
    rtc: RtcPhase,
    transfer: TransferState,
    busy: bool,
    error: Option<String>,
    notice: Option<String>,
    about_open: bool,
    decision_request_id: Option<String>,
    entering_receivers: Vec<String>,
    pending_signals: Vec<(String, ProtocolSignal)>,
    rtc_by_peer: BTreeMap<String, RtcPhase>,
    transfers_by_peer: BTreeMap<String, TransferState>,
}

impl Default for AppModel {
    fn default() -> Self {
        Self {
            session: None,
            screen: Screen::Booting,
            realtime: RealtimePhase::Disconnected,
            rtc: RtcPhase::Inactive,
            transfer: TransferState::Idle,
            busy: false,
            error: None,
            notice: None,
            about_open: false,
            decision_request_id: None,
            entering_receivers: Vec::new(),
            pending_signals: Vec::new(),
            rtc_by_peer: BTreeMap::new(),
            transfers_by_peer: BTreeMap::new(),
        }
    }
}

#[derive(Clone, Copy)]
struct RtcRuntime {
    connection: Signal<Option<RealtimeConnection>>,
    peers: Signal<BTreeMap<String, RtcPeer>>,
    config: Signal<Option<RtcConfigResponse>>,
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

    use_browser_lifecycle(realtime_runtime);
    use_realtime_connection(realtime_runtime);

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
        let Some(RealtimeTarget::Member { .. }) = target else {
            let mut state = model.write();
            state.rtc = RtcPhase::Inactive;
            state.transfer = TransferState::Idle;
            state.pending_signals.clear();
            state.rtc_by_peer.clear();
            state.transfers_by_peer.clear();
            return;
        };
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
        div { class: "app-shell",
            main { class: if matches!(snapshot.screen, Screen::Room { .. }) { "workspace" } else { "lobby" },
                match &snapshot.screen {
                    Screen::Booting => rsx! { BootingView {} },
                    Screen::Lobby { .. } => rsx! { LobbyView { model, realtime_target } },
                    Screen::Waiting { .. } => rsx! { WaitingView { model, realtime_target } },
                    Screen::Room { .. } => rsx! { RoomView { model, realtime_target, rtc_peers } },
                }
            }
            if snapshot.about_open {
                AboutDialog { model }
            }
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
fn BootingView() -> Element {
    rsx! {
        section { class: "booting-view", role: "status", aria_live: "polite",
            span { class: "service-dot", aria_hidden: "true" }
            p { "正在准备安全会话…" }
        }
    }
}

#[component]
fn LobbyView(
    mut model: Signal<AppModel>,
    mut realtime_target: Signal<Option<RealtimeTarget>>,
) -> Element {
    let snapshot = model.read().clone();
    let Screen::Lobby {
        room_code,
        invite_capability,
    } = snapshot.screen
    else {
        return rsx! {};
    };
    let can_join = room_code.len() == 6 && !snapshot.busy && snapshot.session.is_some();

    rsx! {
        form {
            class: "lobby-panel",
            aria_labelledby: "join-title",
            onsubmit: move |event| {
                event.prevent_default();
                let join_ready = {
                    let state = model.read();
                    !state.busy
                        && state.session.is_some()
                        && matches!(
                            &state.screen,
                            Screen::Lobby { room_code, .. } if room_code.len() == 6
                        )
                };
                if join_ready {
                    let _ = prime_notification_permission();
                    submit_join(model, realtime_target);
                }
            },
            h1 { id: "join-title", "加入房间" }
            p { class: "join-copy", "输入发送者提供的 6 位房间码，或直接打开邀请链接" }
            if invite_capability.is_some() {
                div { class: "invite-notice", role: "status",
                    span { class: "invite-mark", aria_hidden: "true", "✓" }
                    span { "已读取邀请链接，确认后加入房间" }
                }
            }
            div { class: "room-code-control",
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
            }
            div { class: "form-message",
                if let Some(error) = snapshot.error {
                    p { id: "room-code-error", role: "alert", "{error}" }
                }
            }
            button {
                class: "primary-button",
                r#type: "submit",
                disabled: !can_join,
                if snapshot.busy { "申请中…" } else if invite_capability.is_some() { "加入房间" } else { "请求加入" }
            }
            div { class: "divider", aria_hidden: "true",
                span {}
                strong { "OR" }
                span {}
            }
            button {
                class: "secondary-button",
                r#type: "button",
                disabled: snapshot.busy || snapshot.session.is_none(),
                onclick: move |_| {
                    let _ = prime_notification_permission();
                    submit_create_room(model, realtime_target);
                },
                if snapshot.busy { "创建中…" } else { "创建房间" }
            }
            p { class: "privacy-copy",
                "文件和文本正文通过加密的 WebRTC 通道传输，优先尝试设备直连，必要时经加密中继转发；应用服务器只协调连接，不保存传输内容。接收完成的文件会暂存在当前页面中，关闭结果或退出房间后释放。"
            }
            FooterLinks { model }
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
    if snapshot.busy || room_code.len() != 6 || snapshot.session.is_none() {
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
fn PeerFlow(
    sender: Option<ParticipantSnapshot>,
    receivers: Vec<ParticipantSnapshot>,
    entering_receivers: Vec<String>,
    peer_connected: bool,
) -> Element {
    let accessible = if receivers.is_empty() {
        "暂无接收者，正在等待连接".to_owned()
    } else {
        format!("{} 位接收者已连接", receivers.len())
    };
    rsx! {
        div {
            class: if receivers.is_empty() { "peer-flow peer-flow-solo" } else { "peer-flow" },
            role: "status",
            aria_live: "polite",
            aria_label: "{accessible}",
            span { class: "peer-side sender-side", aria_hidden: "true",
                if let Some(sender) = sender {
                    Avatar { seed: sender.session_id, label: sender.display_name, entering: false, highlighted: false }
                }
            }
            if !receivers.is_empty() {
                span { class: if peer_connected { "peer-track connected" } else { "peer-track waiting" }, aria_hidden: "true",
                    if peer_connected {
                        span { class: "peer-line" }
                    } else {
                        span { class: "peer-dot" }
                        span { class: "peer-dot" }
                        span { class: "peer-dot" }
                    }
                }
                span { class: "peer-side receiver-side", aria_hidden: "true",
                    for (index, receiver) in receivers.iter().take(5).enumerate() {
                        Avatar {
                            seed: receiver.session_id.clone(),
                            label: receiver.display_name.clone(),
                            entering: entering_receivers.contains(&receiver.session_id),
                            highlighted: false,
                            overlap: index > 0,
                        }
                    }
                }
            }
        }
    }
}

#[component]
fn Avatar(
    seed: String,
    label: String,
    #[props(default = false)] entering: bool,
    #[props(default = false)] highlighted: bool,
    #[props(default = false)] overlap: bool,
) -> Element {
    let hash = hash_seed(&seed);
    let cells = avatar_cells(hash);
    let class = format!(
        "avatar{}{}{}",
        if entering { " avatar-entering" } else { "" },
        if highlighted {
            " avatar-highlighted"
        } else {
            ""
        },
        if overlap { " avatar-overlap" } else { "" },
    );
    rsx! {
        span {
            class: "{class}",
            role: "img",
            aria_label: "{label}",
            title: "{label}",
            for (index, active) in cells.into_iter().enumerate() {
                if active {
                    span {
                        class: if (index + hash as usize).is_multiple_of(4) {
                            "avatar-cell avatar-cell-strong"
                        } else {
                            "avatar-cell"
                        },
                        style: format!(
                            "grid-column:{};grid-row:{}",
                            index % 5 + 1,
                            index / 5 + 1,
                        )
                    }
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

#[component]
fn ShareDialog(
    mut model: Signal<AppModel>,
    mut share_open: Signal<bool>,
    room_code: String,
    capability: String,
) -> Element {
    let invite_url = build_invite_url(&room_code, &capability).ok();
    let qr_code = invite_url.as_deref().and_then(invite_qr_code);
    let has_native_share = native_share_supported();
    use_effect(|| {
        let _ = show_modal_dialog("share-dialog");
    });
    rsx! {
        dialog {
            id: "share-dialog",
            class: "share-dialog",
            aria_labelledby: "share-title",
            oncancel: move |event| {
                event.prevent_default();
                let _ = close_modal_dialog("share-dialog");
                share_open.set(false);
            },
                h2 { id: "share-title", "分享房间" }
                p { "使用手机扫描二维码，或复制邀请链接加入；房间码可用于核对。" }
                if let Some(qr_code) = qr_code {
                    div {
                        class: "share-qr",
                        role: "img",
                        aria_label: "房间 {room_code} 的二维码",
                        svg {
                            class: "share-qr-code",
                            view_box: "{qr_code.view_box}",
                            role: "presentation",
                            path { d: "{qr_code.path}", fill: "currentColor" }
                        }
                    }
                } else {
                    p { class: "share-qr-error", role: "status", "暂时无法生成二维码，请复制邀请链接。" }
                }
                div { class: "share-code",
                    span { "房间码" }
                    strong { "{room_code}" }
                }
                button {
                    class: "primary-button",
                    r#type: "button",
                    onclick: move |_| {
                        let room_code = room_code.clone();
                        let capability = capability.clone();
                        spawn(async move {
                            let result = async {
                                let url = build_invite_url(&room_code, &capability)?;
                                match share_url(
                                    "P2P Transmission 房间邀请",
                                    "打开邀请链接加入临时点对点传输房间",
                                    &url,
                                ).await {
                                    Ok(NativeShareOutcome::Shared) => {
                                        Ok::<_, BrowserPlatformError>(Some("邀请链接已分享"))
                                    }
                                    Ok(NativeShareOutcome::Cancelled) => {
                                        Ok::<_, BrowserPlatformError>(None)
                                    }
                                    Ok(NativeShareOutcome::Unsupported) | Err(_) => {
                                        copy_text(&url).await?;
                                        Ok(Some("邀请链接已复制"))
                                    }
                                }
                            }.await;
                            match result {
                                Ok(Some(notice)) => {
                                    model.write().notice = Some(notice.to_owned());
                                    let _ = close_modal_dialog("share-dialog");
                                    share_open.set(false);
                                }
                                Ok(None) => {}
                                Err(_) => {
                                    model.write().notice = Some(
                                        "无法自动分享，请改用房间码加入".to_owned(),
                                    );
                                }
                            }
                        });
                    },
                    if has_native_share { "分享邀请链接" } else { "复制邀请链接" }
                }
                button {
                    class: "dialog-close",
                    r#type: "button",
                    onclick: move |_| {
                        let _ = close_modal_dialog("share-dialog");
                        share_open.set(false);
                    },
                    "关闭"
                }
        }
    }
}

#[component]
fn AboutDialog(mut model: Signal<AppModel>) -> Element {
    use_effect(|| {
        let _ = show_modal_dialog("about-dialog");
    });
    rsx! {
        dialog {
            id: "about-dialog",
            class: "about-dialog",
            aria_labelledby: "about-title",
            oncancel: move |event| {
                event.prevent_default();
                let _ = close_modal_dialog("about-dialog");
                model.write().about_open = false;
            },
                 h2 { id: "about-title", "关于 P2P Transmission" }
                 p { "当前版本使用 Dioxus Web、Axum 与共享 Rust crates 构建。页面样式和用户功能保持产品体验基线。" }
                dl {
                     div { dt { "当前阶段" } dd { "正式版" } }
                    div { dt { "前端" } dd { "Dioxus / WebAssembly" } }
                    div { dt { "服务端" } dd { "Axum" } }
                    div { dt { "数据通道" } dd { "WebRTC / BLAKE3" } }
                }
                button {
                    class: "close-button",
                    r#type: "button",
                    onclick: move |_| {
                        let _ = close_modal_dialog("about-dialog");
                        model.write().about_open = false;
                    },
                    "关闭"
                }
        }
    }
}

#[component]
fn FooterLinks(mut model: Signal<AppModel>) -> Element {
    rsx! {
        div { class: "footer-links",
            button {
                class: "text-link",
                r#type: "button",
                onclick: move |_| model.write().about_open = true,
                "关于 P2P Transmission"
            }
            a {
                class: "text-link",
                href: "https://github.com/puzzle-fuzzy/p2p-transmission",
                target: "_blank",
                rel: "noreferrer",
                "GitHub"
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

fn restored_room_session() -> Option<StoredRoomSession> {
    let value = load_room_session().ok().flatten()?;
    match serde_json::from_str(&value) {
        Ok(session) => Some(session),
        Err(_) => {
            let _ = clear_room_session();
            None
        }
    }
}

fn persist_room_session(value: &StoredRoomSession) {
    if let Ok(value) = serde_json::to_string(value) {
        let _ = save_room_session(&value);
    }
}

fn friendly_error(error: &BrowserPlatformError) -> String {
    match error {
        BrowserPlatformError::Api { status: 401, .. } => {
            "安全会话已失效，请刷新页面后重试".to_owned()
        }
        BrowserPlatformError::Api { status: 403, .. } => {
            "邀请链接无效、已过期，或当前操作没有权限".to_owned()
        }
        BrowserPlatformError::Api { status: 404, .. } => {
            "没有找到这个房间，请检查房间码".to_owned()
        }
        BrowserPlatformError::Api { status: 409, .. } => "房间状态刚刚发生变化，请重试".to_owned(),
        BrowserPlatformError::Api { status: 429, .. } => "操作过于频繁，请稍后再试".to_owned(),
        BrowserPlatformError::Request(_) => "网络连接失败，请检查网络后重试".to_owned(),
        _ => "暂时无法完成操作，请稍后重试".to_owned(),
    }
}

fn friendly_transfer_error(error: &BrowserPlatformError) -> String {
    match error {
        BrowserPlatformError::Storage {
            kind: BrowserStorageErrorKind::QuotaExceeded,
            ..
        } => "磁盘空间不足，请释放空间后重试".to_owned(),
        BrowserPlatformError::Storage {
            kind: BrowserStorageErrorKind::PermissionDenied,
            ..
        } => "文件访问权限已失效，请重新授权".to_owned(),
        BrowserPlatformError::Storage {
            kind: BrowserStorageErrorKind::NotFound,
            ..
        } => "所选文件或保存位置已不可用，请重新选择".to_owned(),
        BrowserPlatformError::Storage {
            kind: BrowserStorageErrorKind::InvalidState,
            ..
        } => "文件当前无法读写，请关闭占用程序后重试".to_owned(),
        BrowserPlatformError::Storage { .. } => {
            "无法读写所选文件，请检查文件和保存位置后重试".to_owned()
        }
        BrowserPlatformError::Browser(message)
            if message.contains("between 1 and") || message.contains("file list is empty") =>
        {
            "一次最多选择 10 个文件".to_owned()
        }
        BrowserPlatformError::Browser(message) if message.contains("files exceed") => {
            "本次文件总大小不能超过 5 GiB".to_owned()
        }
        BrowserPlatformError::Browser(message)
            if message.contains("transfer limit") || message.contains("exceeds") =>
        {
            "单个文件不能超过 5 GiB".to_owned()
        }
        BrowserPlatformError::Browser(message)
            if message.contains("streaming file saving is unavailable") =>
        {
            "当前浏览器不支持大文件直接保存，请使用桌面版 Chrome 或 Edge".to_owned()
        }
        BrowserPlatformError::Browser(message)
            if message.contains("streaming") || message.contains("storage") =>
        {
            "无法写入所选位置，请检查磁盘空间后重试".to_owned()
        }
        BrowserPlatformError::Browser(message) if message.contains("already active") => {
            "已有文件正在传输，请等待完成后再试".to_owned()
        }
        BrowserPlatformError::Browser(message)
            if message.contains("DataChannel") || message.contains("PeerConnection") =>
        {
            "点对点连接尚未就绪，请稍后再试".to_owned()
        }
        BrowserPlatformError::Browser(message) if message.contains("incoming transfer") => {
            "这次文件接收申请已经失效".to_owned()
        }
        BrowserPlatformError::Browser(_) => "文件传输暂时失败，请重试".to_owned(),
        BrowserPlatformError::UserCancelled => "已取消选择保存位置".to_owned(),
        _ => friendly_error(error),
    }
}

fn hash_seed(value: &str) -> u32 {
    let mut hash = 2_166_136_261_u32;
    for byte in value.bytes() {
        hash ^= u32::from(byte);
        hash = hash.wrapping_mul(16_777_619);
    }
    hash
}

fn avatar_cells(seed: u32) -> [bool; 25] {
    let mut state = seed.max(1);
    let mut cells = [false; 25];
    for row in 0..5 {
        for column in 0..3 {
            state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let active = state & 3 < 2;
            cells[row * 5 + column] = active;
            cells[row * 5 + (4 - column)] = active;
        }
    }
    if !cells.iter().any(|active| *active) {
        cells[12] = true;
    }
    cells
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invite_qr_code_is_deterministic_and_keeps_a_quiet_zone() {
        let url = "https://p2p.yxswy.com/?room=ABC234&invite=test-capability";
        let first = invite_qr_code(url).expect("invite URL should fit in a QR code");
        let second = invite_qr_code(url).expect("same invite URL should remain encodable");

        assert_eq!(first, second);
        assert!(first.view_box.starts_with("0 0 "));
        assert!(first.path.starts_with("M4 4"));
        assert!(!first.path.contains('<'));
    }

    #[test]
    fn stored_room_session_requires_peer_identity() {
        let missing_peer_id = serde_json::from_str::<StoredRoomSession>(
            r#"{"room_code":"ABC234","role":"receiver","join_request_id":"join_1","invite_request_id":null}"#,
        );
        assert!(missing_peer_id.is_err());

        let current = StoredRoomSession {
            room_code: "ABC234".to_owned(),
            role: RoomRole::Receiver,
            join_request_id: Some("join_1".to_owned()),
            invite_request_id: None,
            peer_id: "peer_stable".to_owned(),
        };
        let encoded = serde_json::to_string(&current).expect("room session should serialize");
        let restored = serde_json::from_str::<StoredRoomSession>(&encoded)
            .expect("room session should restore");
        assert_eq!(restored.peer_id, "peer_stable");
    }

    #[test]
    fn storage_failures_keep_specific_recovery_copy() {
        let storage_error = |kind| BrowserPlatformError::Storage {
            operation: p2p_browser_platform::BrowserStorageOperation::WriteDestination,
            kind,
            message: "injected failure".to_owned(),
        };

        assert_eq!(
            friendly_transfer_error(&storage_error(BrowserStorageErrorKind::QuotaExceeded)),
            "磁盘空间不足，请释放空间后重试"
        );
        assert_eq!(
            friendly_transfer_error(&storage_error(BrowserStorageErrorKind::PermissionDenied)),
            "文件访问权限已失效，请重新授权"
        );
        assert_eq!(
            friendly_transfer_error(&storage_error(BrowserStorageErrorKind::NotFound)),
            "所选文件或保存位置已不可用，请重新选择"
        );
        assert_eq!(
            friendly_transfer_error(&storage_error(BrowserStorageErrorKind::InvalidState)),
            "文件当前无法读写，请关闭占用程序后重试"
        );
    }
}
