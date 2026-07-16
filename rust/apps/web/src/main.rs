use std::{
    collections::{BTreeMap, BTreeSet},
    fmt::Write as _,
};

use dioxus::prelude::*;
use p2p_browser_platform::{
    BrowserLifecycleEvent, BrowserPlatformError, BrowserStorageErrorKind, LaunchIntent,
    NativeShareOutcome, RealtimeConnection, RealtimeEvent, RtcConnectionPhase, RtcEvent, RtcPeer,
    SLEEP_RESUME_GAP_MS, StreamingStorageSupport, TransferDirection, TransferFile, bootstrap_room,
    browser_files_from_input, build_invite_url, choose_persistent_source_files,
    choose_stream_files, clear_room_session, close_modal_dialog, connect_browser_lifecycle,
    connect_realtime, copy_text, create_invite, create_room, create_session, decide_join,
    fetch_rtc_config, join_request_status, leave_room, load_room_session, native_share_supported,
    new_client_id, persistent_source_file_support, prime_notification_permission,
    remove_boot_fallback, request_join, save_room_session, send_notification, share_url,
    show_modal_dialog, sleep_ms, streaming_batch_storage_supported, streaming_storage_support,
    take_launch_intent,
};
use p2p_protocol::{
    CURRENT_PROTOCOL, CancelReason, ClientRealtimeMessage, CreateInviteResponse,
    JoinDecisionRequest, JoinDecisionWire, JoinRequestSnapshot, JoinRequestStateWire,
    ParticipantRoleWire, ParticipantSnapshot, RoomBootstrapResponse, RtcConfigResponse,
    ServerRealtimeMessage, SessionResponse, Signal as ProtocolSignal, StreamPauseReason,
    TransferMode,
};
use serde::{Deserialize, Serialize};

const STYLE: &str = include_str!("../assets/main.css");
const AVATAR_ENTRY_HOLD_MS: u32 = 700;
const RTC_NEGOTIATION_TIMEOUT_MS: u32 = 3_000;
const RTC_PASSIVE_RECOVERY_TIMEOUT_MS: u32 = 30_000;
const RTC_RETRY_DELAYS_MS: [u32; 4] = [500, 1_000, 2_000, 4_000];
const BACKGROUND_CONTROL_RECOVERY_MS: u64 = 15_000;
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
    remove_boot_fallback();
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
    #[serde(default)]
    peer_id: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RealtimePhase {
    Disconnected,
    Connecting,
    Connected,
    Reconnecting,
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

#[derive(Clone, Debug, Eq, PartialEq)]
enum RealtimeTarget {
    Member {
        room_code: String,
        peer_id: String,
        last_revision: u64,
    },
    JoinWatch {
        room_code: String,
        request_id: String,
        last_revision: u64,
    },
}

impl RealtimeTarget {
    fn initial_message(&self) -> ClientRealtimeMessage {
        match self {
            Self::Member {
                room_code,
                peer_id,
                last_revision,
            } => ClientRealtimeMessage::AttachRoom {
                version: CURRENT_PROTOCOL,
                room_code: room_code.clone(),
                peer_id: peer_id.clone(),
                last_revision: Some(*last_revision),
            },
            Self::JoinWatch {
                room_code,
                request_id,
                last_revision,
            } => ClientRealtimeMessage::WatchJoinRequest {
                version: CURRENT_PROTOCOL,
                room_code: room_code.clone(),
                request_id: request_id.clone(),
                last_revision: Some(*last_revision),
            },
        }
    }
}

#[derive(Clone, Copy)]
struct RtcRuntime {
    connection: Signal<Option<RealtimeConnection>>,
    peers: Signal<BTreeMap<String, RtcPeer>>,
    config: Signal<Option<RtcConfigResponse>>,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct LifecycleState {
    hidden: bool,
    network_recovery_pending: bool,
    recovery_in_progress: bool,
    rebuild_resumable_peers_after_attach: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum LifecycleRecoveryAction {
    None,
    ControlPlane,
    RebuildResumablePeers,
}

#[allow(non_snake_case)]
fn App() -> Element {
    let mut model = use_signal(AppModel::default);
    let realtime_target = use_signal(|| None::<RealtimeTarget>);
    let reconnect_attempt = use_signal(|| 0_u32);
    let mut connection = use_signal(|| None::<RealtimeConnection>);
    let rtc_peers = use_signal(BTreeMap::<String, RtcPeer>::new);
    let mut rtc_config = use_signal(|| None::<RtcConfigResponse>);
    let lifecycle_state = use_signal(LifecycleState::default);

    let _browser_lifecycle = use_hook(move || {
        let rtc_runtime = RtcRuntime {
            connection,
            peers: rtc_peers,
            config: rtc_config,
        };
        let on_event = Callback::new(move |event| {
            handle_browser_lifecycle_event(
                model,
                realtime_target,
                reconnect_attempt,
                rtc_runtime,
                lifecycle_state,
                event,
            );
        });
        match connect_browser_lifecycle(on_event.into_closure()) {
            Ok(active) => Some(active),
            Err(error) => {
                model.write().error = Some(friendly_error(&error));
                None
            }
        }
    });

    use_effect(move || initialize(model, realtime_target));

    use_effect(move || {
        let target = realtime_target.read().clone();
        let attempt = *reconnect_attempt.read();
        connection.set(None);
        let Some(target) = target else {
            model.write().realtime = RealtimePhase::Disconnected;
            return;
        };

        model.write().realtime = if attempt == 0 {
            RealtimePhase::Connecting
        } else {
            RealtimePhase::Reconnecting
        };
        let initial = target.initial_message();
        let rtc_runtime = RtcRuntime {
            connection,
            peers: rtc_peers,
            config: rtc_config,
        };
        let on_event = Callback::new(move |event| {
            handle_realtime_event(
                model,
                realtime_target,
                reconnect_attempt,
                rtc_runtime,
                lifecycle_state,
                attempt,
                event,
            );
        });
        match connect_realtime(initial, on_event.into_closure()) {
            Ok(active) => connection.set(Some(active)),
            Err(error) => {
                model.write().error = Some(friendly_error(&error));
                schedule_reconnect(realtime_target, reconnect_attempt, attempt);
            }
        }
    });

    use_effect(move || {
        let target = realtime_target.read().clone();
        reset_all_rtc_peers(rtc_peers);
        rtc_config.set(None);
        let Some(RealtimeTarget::Member { peer_id, .. }) = target else {
            let mut state = model.write();
            state.rtc = RtcPhase::Inactive;
            state.transfer = TransferState::Idle;
            state.pending_signals.clear();
            state.rtc_by_peer.clear();
            state.transfers_by_peer.clear();
            return;
        };
        model.write().rtc = RtcPhase::WaitingPeer;
        spawn(async move {
            let config = match fetch_rtc_config().await {
                Ok(config) => config,
                Err(error) => {
                    let mut state = model.write();
                    state.rtc = RtcPhase::Failed;
                    state.error = Some(friendly_error(&error));
                    return;
                }
            };
            let still_current = matches!(
                &*realtime_target.peek(),
                Some(RealtimeTarget::Member { peer_id: current, .. }) if current == &peer_id
            );
            if !still_current {
                return;
            }
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
        style { {STYLE} }
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

fn lifecycle_recovery_action(
    event: BrowserLifecycleEvent,
    state: LifecycleState,
) -> LifecycleRecoveryAction {
    match event {
        BrowserLifecycleEvent::Hidden | BrowserLifecycleEvent::Offline => {
            LifecycleRecoveryAction::None
        }
        BrowserLifecycleEvent::Online => LifecycleRecoveryAction::RebuildResumablePeers,
        BrowserLifecycleEvent::Visible { .. } if state.network_recovery_pending => {
            LifecycleRecoveryAction::RebuildResumablePeers
        }
        BrowserLifecycleEvent::Visible { hidden_ms }
            if hidden_ms >= BACKGROUND_CONTROL_RECOVERY_MS =>
        {
            LifecycleRecoveryAction::ControlPlane
        }
        BrowserLifecycleEvent::Visible { .. } => LifecycleRecoveryAction::None,
        BrowserLifecycleEvent::Resumed { gap_ms }
            if !state.hidden && gap_ms >= SLEEP_RESUME_GAP_MS =>
        {
            LifecycleRecoveryAction::RebuildResumablePeers
        }
        BrowserLifecycleEvent::Resumed { .. } => LifecycleRecoveryAction::None,
    }
}

fn handle_browser_lifecycle_event(
    mut model: Signal<AppModel>,
    realtime_target: Signal<Option<RealtimeTarget>>,
    reconnect_attempt: Signal<u32>,
    mut rtc: RtcRuntime,
    mut lifecycle_state: Signal<LifecycleState>,
    event: BrowserLifecycleEvent,
) {
    let action = {
        let current = *lifecycle_state.read();
        let action = lifecycle_recovery_action(event, current);
        let mut state = lifecycle_state.write();
        match event {
            BrowserLifecycleEvent::Hidden => state.hidden = true,
            BrowserLifecycleEvent::Visible { .. } => {
                state.hidden = false;
                if action != LifecycleRecoveryAction::None {
                    state.network_recovery_pending = false;
                }
            }
            BrowserLifecycleEvent::Offline => state.network_recovery_pending = true,
            BrowserLifecycleEvent::Online => {
                if action != LifecycleRecoveryAction::None {
                    state.network_recovery_pending = false;
                }
            }
            BrowserLifecycleEvent::Resumed { .. } => {}
        }
        action
    };

    if event == BrowserLifecycleEvent::Offline && realtime_target.read().is_some() {
        lifecycle_state.write().recovery_in_progress = true;
        rtc.connection.set(None);
        let attempt = *reconnect_attempt.peek();
        schedule_reconnect(realtime_target, reconnect_attempt, attempt);
        let mut state = model.write();
        state.realtime = RealtimePhase::Reconnecting;
        let has_stream = mark_streamed_transfers_waiting(&mut state);
        state.notice = Some(if has_stream {
            "网络已断开，恢复后将从最后检查点继续传输".to_owned()
        } else {
            "网络已断开，恢复后会自动重新连接".to_owned()
        });
        return;
    }

    if action == LifecycleRecoveryAction::None || realtime_target.read().is_none() {
        return;
    }

    {
        let mut state = lifecycle_state.write();
        state.recovery_in_progress = true;
        if action == LifecycleRecoveryAction::RebuildResumablePeers {
            state.rebuild_resumable_peers_after_attach = true;
        }
    }

    {
        let mut state = model.write();
        state.realtime = RealtimePhase::Reconnecting;
        state.error = None;
        let has_stream = mark_streamed_transfers_waiting(&mut state);
        if has_stream {
            state.notice = Some("正在恢复连接，将从最后检查点继续传输".to_owned());
        } else {
            state.notice = Some("正在恢复连接".to_owned());
        }
    }

    rtc.connection.set(None);
    let attempt = *reconnect_attempt.peek();
    schedule_reconnect(realtime_target, reconnect_attempt, attempt);

    let room_code = match &model.read().screen {
        Screen::Room { snapshot, .. } => Some(snapshot.room_code.clone()),
        _ => None,
    };
    if let Some(room_code) = room_code {
        spawn(async move {
            match bootstrap_room(&room_code).await {
                Ok(snapshot) => {
                    let entering = apply_snapshot(&mut model.write(), snapshot);
                    schedule_avatar_cleanup(model, entering);
                }
                Err(error) => model.write().error = Some(friendly_error(&error)),
            }
        });
    }
}

fn complete_lifecycle_peer_rebuild(
    mut model: Signal<AppModel>,
    rtc: RtcRuntime,
    mut lifecycle_state: Signal<LifecycleState>,
) {
    let should_rebuild = {
        let mut state = lifecycle_state.write();
        let pending = state.rebuild_resumable_peers_after_attach;
        state.rebuild_resumable_peers_after_attach = false;
        pending
    };
    if !should_rebuild {
        return;
    }

    let peers = rtc
        .peers
        .read()
        .iter()
        .filter(|(_, peer)| peer.resumable_transfer_active() || !peer.data_channel_ready())
        .map(|(peer_id, peer)| (peer_id.clone(), peer.clone()))
        .collect::<Vec<_>>();
    for (_, peer) in &peers {
        peer.prepare_reconnect();
    }
    let mut state = model.write();
    for (peer_id, _) in peers {
        state.rtc_by_peer.insert(peer_id, RtcPhase::WaitingPeer);
    }
    refresh_aggregate_rtc(&mut state);
}

fn mark_streamed_transfers_waiting(model: &mut AppModel) -> bool {
    let peer_ids = model.transfers_by_peer.keys().cloned().collect::<Vec<_>>();
    let mut updated = false;
    for peer_id in peer_ids {
        updated |= set_peer_transfer_link_state(model, &peer_id, TransferLinkState::Waiting);
    }
    updated
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

        if let Some(stored) = restored_room_session()
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
        let peer_id = stored.peer_id.unwrap_or_else(|| new_client_id("peer"));
        persist_room_session(&StoredRoomSession {
            room_code: room_code.clone(),
            role,
            join_request_id: stored.join_request_id,
            invite_request_id: stored.invite_request_id.clone(),
            peer_id: Some(peer_id.clone()),
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
                    revision: status.revision,
                    expires_at_ms: status.expires_at_ms,
                };
                target.set(Some(RealtimeTarget::JoinWatch {
                    room_code: stored.room_code.clone(),
                    request_id: request_id.clone(),
                    last_revision: status.revision,
                }));
                return true;
            }
            JoinRequestStateWire::Approved => {
                enter_receiver_room(model, target, snapshot, request_id);
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
    let code_characters = room_code.chars().collect::<Vec<_>>();

    rsx! {
        section { class: "lobby-panel", aria_labelledby: "join-title",
            h1 { id: "join-title", "加入房间" }
            p { class: "join-copy", "输入发送者提供的 6 位房间码，或直接打开邀请链接" }
            if invite_capability.is_some() {
                div { class: "invite-notice", role: "status",
                    span { class: "invite-mark", aria_hidden: "true", "✓" }
                    span { "已读取邀请链接，确认后加入房间" }
                }
            }
            div { class: "room-code-control",
                input {
                    class: "room-code-native",
                    value: "{room_code}",
                    maxlength: 6,
                    autocomplete: "one-time-code",
                    spellcheck: "false",
                    aria_label: "输入 6 位房间码",
                    disabled: snapshot.busy,
                    oninput: move |event| {
                        let value = event.value()
                            .chars()
                            .filter(|character| character.is_ascii_alphanumeric())
                            .take(6)
                            .collect::<String>()
                            .to_ascii_uppercase();
                        let mut state = model.write();
                        if let Screen::Lobby { room_code, invite_capability } = &mut state.screen {
                            *room_code = value;
                            *invite_capability = None;
                        }
                        state.error = None;
                    }
                }
                div { class: "room-code", aria_hidden: "true",
                    for index in 0..6 {
                        span { class: if code_characters.get(index).is_some() { "filled" } else { "" },
                            {code_characters.get(index).map(char::to_string).unwrap_or_default()}
                        }
                    }
                }
            }
            div { class: "form-message",
                if let Some(error) = snapshot.error {
                    p { role: "alert", "{error}" }
                }
            }
            button {
                class: "primary-button",
                r#type: "button",
                disabled: !can_join,
                onclick: move |_| {
                    let _ = prime_notification_permission();
                    submit_join(model, realtime_target);
                },
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
                    peer_id: Some(peer_id.clone()),
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
                persist_room_session(&StoredRoomSession {
                    room_code: room_code.clone(),
                    role: RoomRole::Receiver,
                    join_request_id: Some(request_id.clone()),
                    invite_request_id: None,
                    peer_id: None,
                });
                {
                    let mut state = model.write();
                    state.busy = false;
                    state.screen = Screen::Waiting {
                        room_code: room_code.clone(),
                        request_id: request_id.clone(),
                        revision: response.revision,
                        expires_at_ms: response.expires_at_ms,
                    };
                }
                realtime_target.set(Some(RealtimeTarget::JoinWatch {
                    room_code: room_code.clone(),
                    request_id: request_id.clone(),
                    last_revision: response.revision,
                }));
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
    let connected = state.realtime == RealtimePhase::Connected;
    let room_code_for_copy = snapshot.room_code.clone();
    let role_copy = if role == RoomRole::Owner {
        "发送者"
    } else {
        "接收者"
    };
    let status_copy = if connected {
        "房间连接已建立"
    } else {
        "正在重新连接房间"
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
                JoinRequestDialog { model, request: request.clone() }
            }
        }
    }
}

#[component]
fn TransferPanel(
    mut model: Signal<AppModel>,
    rtc_peers: Signal<BTreeMap<String, RtcPeer>>,
    role: RoomRole,
    receivers: Vec<ParticipantSnapshot>,
    rtc: RtcPhase,
    transfer: TransferState,
    rtc_by_peer: BTreeMap<String, RtcPhase>,
    transfers_by_peer: BTreeMap<String, TransferState>,
) -> Element {
    let mut picker_open = use_signal(|| false);
    let selected_receiver_ids = use_signal(|| None::<Vec<String>>);
    let mut batch_peer_ids = use_signal(Vec::<String>::new);
    let online_receiver_ids = receivers
        .iter()
        .map(|receiver| receiver.session_id.clone())
        .collect::<BTreeSet<_>>();
    let selected_ids = selected_receiver_ids
        .read()
        .clone()
        .unwrap_or_else(|| online_receiver_ids.iter().cloned().collect())
        .into_iter()
        .filter(|session_id| online_receiver_ids.contains(session_id))
        .collect::<Vec<_>>();
    let selected_peer_ids = receivers
        .iter()
        .filter(|receiver| selected_ids.contains(&receiver.session_id))
        .filter_map(|receiver| receiver.peer_id.clone())
        .collect::<Vec<_>>();
    let ready_count = selected_peer_ids
        .iter()
        .filter(|peer_id| rtc_by_peer.get(*peer_id) == Some(&RtcPhase::Ready))
        .count();
    let mut current_batch_peer_ids = batch_peer_ids.read().clone();
    if current_batch_peer_ids.is_empty() {
        current_batch_peer_ids.extend(
            transfers_by_peer
                .iter()
                .filter(|(_, transfer)| !matches!(transfer, TransferState::Idle))
                .map(|(peer_id, _)| peer_id.clone()),
        );
    }
    let owner_states = current_batch_peer_ids
        .iter()
        .filter_map(|peer_id| transfers_by_peer.get(peer_id).cloned())
        .collect::<Vec<_>>();
    let paused_peer_ids = current_batch_peer_ids
        .iter()
        .filter(|peer_id| {
            matches!(
                transfers_by_peer.get(*peer_id),
                Some(TransferState::Active {
                    link_state: TransferLinkState::Paused,
                    ..
                })
            )
        })
        .cloned()
        .collect::<Vec<_>>();
    let owner_active = owner_states.iter().any(transfer_is_active);
    let receiver_active = transfer_is_active(&transfer);
    let active = if role == RoomRole::Owner {
        owner_active
    } else {
        receiver_active
    };
    let can_offer = role == RoomRole::Owner
        && !selected_peer_ids.is_empty()
        && ready_count == selected_peer_ids.len()
        && !owner_active;
    let receiver_count = receivers.len();
    let (title, description) = if role == RoomRole::Owner {
        owner_transfer_panel_copy(
            receiver_count,
            selected_ids.len(),
            ready_count,
            &owner_states,
        )
    } else {
        transfer_panel_copy(role, receiver_count, rtc, &transfer)
    };
    let file = if role == RoomRole::Owner {
        owner_states.iter().find_map(transfer_file).cloned()
    } else {
        transfer_file(&transfer).cloned()
    };
    let files = if role == RoomRole::Owner {
        owner_states
            .iter()
            .find_map(transfer_files)
            .map(<[TransferFile]>::to_vec)
            .unwrap_or_default()
    } else {
        transfer_files(&transfer)
            .map(<[TransferFile]>::to_vec)
            .unwrap_or_default()
    };
    let (completed_bytes, total_bytes, progress) = if role == RoomRole::Owner {
        owner_transfer_progress(&owner_states)
    } else {
        transfer_progress(&transfer)
    };
    let progress_style = format!("--progress-scale:{:.4}", progress.clamp(0.0, 100.0) / 100.0);
    let incoming_request = transfers_by_peer.iter().find_map(|(peer_id, state)| {
        if let TransferState::Incoming {
            transfer_id,
            mode,
            files,
            recovery_available,
            ..
        } = state
        {
            Some((
                peer_id.clone(),
                transfer_id.clone(),
                *mode,
                files.clone(),
                *recovery_available,
            ))
        } else {
            None
        }
    });
    let storage_pause_request = transfers_by_peer.iter().find_map(|(peer_id, state)| {
        if let TransferState::Active {
            transfer_id,
            direction: TransferDirection::Receive,
            storage_pause: Some(reason),
            ..
        } = state
        {
            Some((peer_id.clone(), transfer_id.clone(), *reason))
        } else {
            None
        }
    });
    let selected_summary = if selected_ids.len() == receiver_count {
        format!("全部 {} 位", selected_ids.len())
    } else {
        format!("{} 位", selected_ids.len())
    };

    rsx! {
        section { class: "transfer-panel", aria_label: "文件传输",
            div { class: "transfer-panel-copy",
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
            if !files.is_empty() {
                div { class: "transfer-file-list", aria_label: "传输文件列表",
                    for (index, item) in files.iter().enumerate() {
                        div { class: "transfer-file-row",
                            div { class: "transfer-file-meta",
                                strong { title: "{item.name}", "{item.name}" }
                                span { "{format_bytes(item.size_bytes)}" }
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
            } else if let Some(file) = file.clone() {
                div { class: "transfer-file-row",
                    div { class: "transfer-file-meta",
                        strong { title: "{file.name}", "{file.name}" }
                        span { "{format_bytes(file.size_bytes)}" }
                    }
                }
            }
            if role == RoomRole::Owner && !current_batch_peer_ids.is_empty() {
                div { class: "receiver-transfer-list", aria_label: "接收者传输结果",
                    for peer_id in current_batch_peer_ids.iter() {
                        if let Some(receiver) = receivers.iter().find(|receiver| {
                            receiver.peer_id.as_deref() == Some(peer_id.as_str())
                        }) {
                            div { class: "receiver-transfer-row",
                                span { title: "{receiver.display_name}", "{receiver.display_name}" }
                                strong { "{receiver_transfer_status(transfers_by_peer.get(peer_id))}" }
                            }
                        }
                    }
                }
            }
            if active {
                div {
                    class: "transfer-progress",
                    role: "progressbar",
                    aria_label: "文件传输进度",
                    aria_valuemin: "0",
                    aria_valuemax: "100",
                    aria_valuenow: "{progress:.0}",
                    span { style: "{progress_style}" }
                }
                p { class: "transfer-progress-copy",
                    "{format_bytes(completed_bytes)} / {format_bytes(total_bytes)}"
                }
            }
            div { class: "transfer-actions",
                if can_offer && !active {
                    input {
                        id: "transfer-file-input",
                        class: "sr-only",
                        r#type: "file",
                        multiple: true,
                        aria_label: "选择要发送的文件",
                        onchange: {
                            let selected_peer_ids = selected_peer_ids.clone();
                            move |_| {
                                let offered = submit_selected_files(
                                    model,
                                    rtc_peers,
                                    selected_peer_ids.clone(),
                                );
                                if !offered.is_empty() {
                                    batch_peer_ids.set(offered);
                                }
                            }
                        },
                    }
                    if persistent_source_file_support() {
                        button {
                            class: "primary-button file-picker-button",
                            r#type: "button",
                            onclick: {
                                let selected_peer_ids = selected_peer_ids.clone();
                                move |_| {
                                    let selected_peer_ids = selected_peer_ids.clone();
                                    spawn(async move {
                                        let offered = submit_persistent_source_files(
                                            model,
                                            rtc_peers,
                                            selected_peer_ids,
                                        ).await;
                                        if !offered.is_empty() {
                                            batch_peer_ids.set(offered);
                                        }
                                    });
                                }
                            },
                            "选择文件"
                        }
                    } else {
                        label { class: "primary-button file-picker-button", r#for: "transfer-file-input",
                            "选择文件"
                        }
                    }
                }
                if let Some((peer_id, transfer_id, reason)) = storage_pause_request.clone() {
                    button {
                        class: "primary-button",
                        r#type: "button",
                        onclick: move |_| {
                            let peer_id = peer_id.clone();
                            let transfer_id = transfer_id.clone();
                            spawn(async move {
                                resume_streaming_transfer(
                                    model,
                                    rtc_peers,
                                    peer_id,
                                    transfer_id,
                                ).await;
                            });
                        },
                        if reason == StreamPauseReason::DestinationQuotaExceeded {
                            "释放空间后继续接收"
                        } else {
                            "重新授权"
                        }
                    }
                } else if role == RoomRole::Owner
                    && owner_states
                        .iter()
                        .any(|state| matches!(state, TransferState::OutgoingRecovery { .. }))
                {
                    button {
                        class: "primary-button",
                        r#type: "button",
                        onclick: {
                            let current_batch_peer_ids = current_batch_peer_ids.clone();
                            move |_| {
                                resume_outgoing_transfers(
                                    model,
                                    rtc_peers,
                                    current_batch_peer_ids.clone(),
                                )
                            }
                        },
                        "继续发送"
                    }
                } else if role == RoomRole::Owner && !paused_peer_ids.is_empty() {
                    button {
                        class: "primary-button",
                        r#type: "button",
                        onclick: {
                            let paused_peer_ids = paused_peer_ids.clone();
                            move |_| retry_paused_transfers(
                                model,
                                rtc_peers,
                                paused_peer_ids.clone(),
                            )
                        },
                        "重新连接"
                    }
                }
                if active {
                    button {
                        class: "secondary-button transfer-cancel-button",
                        r#type: "button",
                        onclick: {
                            let current_batch_peer_ids = current_batch_peer_ids.clone();
                            move |_| cancel_current_transfers(
                                model,
                                rtc_peers,
                                role,
                                current_batch_peer_ids.clone(),
                            )
                        },
                        "取消传输"
                    }
                }
                if let TransferState::Completed {
                    direction: TransferDirection::Receive,
                    download_url: Some(download_url),
                    file,
                    ..
                } = &transfer
                {
                    a {
                        class: "primary-button transfer-download",
                        href: "{download_url}",
                        download: "{file.name}",
                        "保存文件"
                    }
                }
            }
            if let Some((peer_id, transfer_id, mode, files, recovery_available)) = incoming_request {
                TransferRequestDialog {
                    model,
                    rtc_peers,
                    peer_id,
                    transfer_id,
                    mode,
                    files,
                    recovery_available,
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

#[component]
fn TransferRequestDialog(
    mut model: Signal<AppModel>,
    rtc_peers: Signal<BTreeMap<String, RtcPeer>>,
    peer_id: String,
    transfer_id: String,
    mode: TransferMode,
    files: Vec<TransferFile>,
    recovery_available: bool,
) -> Element {
    use_effect(|| {
        let _ = show_modal_dialog("transfer-request-dialog");
    });
    let streamed = matches!(mode, TransferMode::Streamed { .. });
    let batch = files.len() > 1;
    let stream_supported = if batch {
        streaming_batch_storage_supported()
    } else {
        streaming_storage_support() == StreamingStorageSupport::DirectFile
    };
    let accept_transfer_id = transfer_id.clone();
    let reselect_transfer_id = transfer_id.clone();
    let reject_transfer_id = transfer_id.clone();
    let accept_peer_id = peer_id.clone();
    let recovery_peer_id = peer_id.clone();
    let reject_peer_id = peer_id.clone();
    let accept_file_names = files
        .iter()
        .map(|file| file.name.clone())
        .collect::<Vec<_>>();
    rsx! {
        dialog {
                id: "transfer-request-dialog",
                class: "transfer-request-dialog",
                aria_labelledby: "transfer-request-title",
                oncancel: move |event| event.prevent_default(),
                h2 { id: "transfer-request-title",
                    if batch { "接收 {files.len()} 个文件" } else { "接收文件" }
                }
                if recovery_available {
                    p { "已找到未完成的接收记录。继续后会校验原文件，并从最后确认的位置恢复。" }
                } else if streamed && batch {
                    p { "选择目标文件夹后，文件会按列表顺序直接写入磁盘。" }
                } else if streamed {
                    p { "此文件较大，接收前请选择保存位置。数据会直接写入磁盘。" }
                } else {
                    p { "发送者希望向你发送这个文件。" }
                }
                div { class: "request-file-list",
                    for item in files.iter() {
                        div { class: "request-file-summary",
                            strong { title: "{item.name}", "{item.name}" }
                            span { "{format_bytes(item.size_bytes)}" }
                        }
                    }
                }
                if streamed && !stream_supported {
                    p { class: "stream-storage-error", role: "alert",
                        if batch {
                            "当前浏览器不支持批量文件夹保存，请使用桌面版 Chrome 或 Edge。"
                        } else {
                            "当前浏览器不支持大文件直接保存，请使用桌面版 Chrome 或 Edge。"
                        }
                    }
                }
                div { class: "dialog-actions",
                    if streamed {
                        if recovery_available {
                            button {
                                class: "primary-button",
                                r#type: "button",
                                onclick: move |_| {
                                    let peer_id = recovery_peer_id.clone();
                                    let transfer_id = accept_transfer_id.clone();
                                    async move {
                                        resume_streaming_transfer(
                                            model,
                                            rtc_peers,
                                            peer_id,
                                            transfer_id,
                                        )
                                        .await;
                                    }
                                },
                                "继续接收"
                            }
                            button {
                                class: "secondary-button",
                                r#type: "button",
                                disabled: !stream_supported,
                                onclick: move |_| {
                                    let peer_id = accept_peer_id.clone();
                                    let transfer_id = reselect_transfer_id.clone();
                                    let file_names = accept_file_names.clone();
                                    async move {
                                        accept_streaming_transfer(
                                            model,
                                            rtc_peers,
                                            peer_id,
                                            transfer_id,
                                            file_names,
                                        )
                                        .await;
                                    }
                                },
                                "重新选择位置"
                            }
                        } else {
                            button {
                                class: "primary-button",
                                r#type: "button",
                                disabled: !stream_supported,
                                onclick: move |_| {
                                    let peer_id = accept_peer_id.clone();
                                    let transfer_id = accept_transfer_id.clone();
                                    let file_names = accept_file_names.clone();
                                    async move {
                                        accept_streaming_transfer(
                                            model,
                                            rtc_peers,
                                            peer_id,
                                            transfer_id,
                                            file_names,
                                        )
                                        .await;
                                    }
                                },
                                if batch { "选择文件夹并接收" } else { "选择位置并接收" }
                            }
                        }
                    } else {
                        button {
                            class: "primary-button",
                            r#type: "button",
                            onclick: move |_| decide_incoming_transfer(
                                model,
                                rtc_peers,
                                &accept_peer_id,
                                &accept_transfer_id,
                                true,
                            ),
                            "接收文件"
                        }
                    }
                    button {
                        class: "secondary-button",
                        r#type: "button",
                        onclick: move |_| decide_incoming_transfer(
                            model,
                            rtc_peers,
                            &reject_peer_id,
                            &reject_transfer_id,
                            false,
                        ),
                        "拒绝接收"
                    }
                }
        }
    }
}

#[component]
fn RecipientPickerDialog(
    receivers: Vec<ParticipantSnapshot>,
    selected_ids: Vec<String>,
    mut picker_open: Signal<bool>,
    mut selected_receiver_ids: Signal<Option<Vec<String>>>,
) -> Element {
    use_effect(|| {
        let _ = show_modal_dialog("recipient-picker-dialog");
    });
    let mut draft_ids = use_signal(|| selected_ids);
    let mut error = use_signal(String::new);
    let selected_count = draft_ids.read().len();
    rsx! {
        dialog {
                id: "recipient-picker-dialog",
                class: "recipient-picker-dialog",
                aria_labelledby: "recipient-picker-title",
                oncancel: move |event| {
                    event.prevent_default();
                    let _ = close_modal_dialog("recipient-picker-dialog");
                    picker_open.set(false);
                },
                div { class: "recipient-picker-heading",
                    div {
                        h2 { id: "recipient-picker-title", "选择接收者" }
                        p { "选择本次文件要发送给谁。" }
                    }
                    span { "已选 {selected_count} 人" }
                }
                div { class: "recipient-picker-tools",
                    button {
                        r#type: "button",
                        onclick: {
                            let receivers = receivers.clone();
                            move |_| {
                                error.set(String::new());
                                draft_ids.set(receivers.iter().map(|item| item.session_id.clone()).collect());
                            }
                        },
                        "全选"
                    }
                    button {
                        r#type: "button",
                        onclick: move |_| {
                            error.set(String::new());
                            draft_ids.set(Vec::new());
                        },
                        "清空选择"
                    }
                }
                div { class: "recipient-picker-list", role: "group", aria_label: "可选接收者",
                    for receiver in receivers.iter() {
                        {
                            let receiver_id = receiver.session_id.clone();
                            let checked = draft_ids.read().contains(&receiver_id);
                            rsx! {
                                label { class: if checked { "recipient-option selected" } else { "recipient-option" },
                                    input {
                                        r#type: "checkbox",
                                        checked,
                                        aria_label: "{receiver.display_name}",
                                        onchange: move |_| {
                                            error.set(String::new());
                                            let mut next = draft_ids.read().clone();
                                            if let Some(index) = next.iter().position(|id| id == &receiver_id) {
                                                next.remove(index);
                                            } else {
                                                next.push(receiver_id.clone());
                                            }
                                            draft_ids.set(next);
                                        },
                                    }
                                    Avatar {
                                        seed: receiver.session_id.clone(),
                                        label: receiver.display_name.clone(),
                                        entering: false,
                                        highlighted: false,
                                    }
                                    span { title: "{receiver.display_name}", "{receiver.display_name}" }
                                }
                            }
                        }
                    }
                }
                if !error.read().is_empty() {
                    p { class: "recipient-picker-error", role: "alert", "{error}" }
                }
                div { class: "dialog-actions",
                    button {
                        class: "secondary-button",
                        r#type: "button",
                        onclick: move |_| {
                            let _ = close_modal_dialog("recipient-picker-dialog");
                            picker_open.set(false);
                        },
                        "取消"
                    }
                    button {
                        class: "primary-button",
                        r#type: "button",
                        onclick: move |_| {
                            let selected = draft_ids.read().clone();
                            if selected.is_empty() {
                                error.set("至少选择一位接收者".to_owned());
                                return;
                            }
                            selected_receiver_ids.set(Some(selected));
                            let _ = close_modal_dialog("recipient-picker-dialog");
                            picker_open.set(false);
                        },
                        "确定"
                    }
                }
        }
    }
}

fn submit_selected_files(
    mut model: Signal<AppModel>,
    rtc_peers: Signal<BTreeMap<String, RtcPeer>>,
    peer_ids: Vec<String>,
) -> Vec<String> {
    let files = match browser_files_from_input("transfer-file-input") {
        Ok(files) if !files.is_empty() => files,
        Ok(_) => return Vec::new(),
        Err(error) => {
            model.write().error = Some(friendly_transfer_error(&error));
            return Vec::new();
        }
    };
    let peers = rtc_peers.read();
    let mut offered = Vec::new();
    let mut last_error = None;
    for peer_id in peer_ids {
        let Some(peer) = peers.get(&peer_id) else {
            last_error = Some("有接收者的点对点连接已经断开".to_owned());
            continue;
        };
        match peer.offer_files(files.clone()) {
            Ok(_) => offered.push(peer_id),
            Err(error) => last_error = Some(friendly_transfer_error(&error)),
        }
    }
    drop(peers);
    model.write().error = last_error;
    offered
}

async fn submit_persistent_source_files(
    mut model: Signal<AppModel>,
    rtc_peers: Signal<BTreeMap<String, RtcPeer>>,
    peer_ids: Vec<String>,
) -> Vec<String> {
    let files = match choose_persistent_source_files().await {
        Ok(files) if !files.is_empty() => files,
        Ok(_) | Err(BrowserPlatformError::UserCancelled) => return Vec::new(),
        Err(error) => {
            model.write().error = Some(friendly_transfer_error(&error));
            return Vec::new();
        }
    };
    let peers = {
        let peers = rtc_peers.read();
        peer_ids
            .into_iter()
            .map(|peer_id| (peer_id.clone(), peers.get(&peer_id).cloned()))
            .collect::<Vec<_>>()
    };
    let mut offered = Vec::new();
    let mut last_error = None;
    for (peer_id, peer) in peers {
        let Some(peer) = peer else {
            last_error = Some("有接收者的点对点连接已经断开".to_owned());
            continue;
        };
        match peer.offer_persistent_files(files.clone()).await {
            Ok(_) => offered.push(peer_id),
            Err(error) => last_error = Some(friendly_transfer_error(&error)),
        }
    }
    model.write().error = last_error;
    offered
}

fn resume_outgoing_transfers(
    mut model: Signal<AppModel>,
    rtc_peers: Signal<BTreeMap<String, RtcPeer>>,
    peer_ids: Vec<String>,
) {
    let peers = {
        let peers = rtc_peers.read();
        peer_ids
            .into_iter()
            .filter_map(|peer_id| peers.get(&peer_id).cloned())
            .collect::<Vec<_>>()
    };
    spawn(async move {
        let mut last_error = None;
        for peer in peers {
            if let Err(error) = peer.resume_outgoing_transfer().await {
                last_error = Some(friendly_transfer_error(&error));
            }
        }
        model.write().error = last_error;
    });
}

fn decide_incoming_transfer(
    mut model: Signal<AppModel>,
    rtc_peers: Signal<BTreeMap<String, RtcPeer>>,
    peer_id: &str,
    transfer_id: &str,
    accepted: bool,
) {
    let Some(peer) = rtc_peers.read().get(peer_id).cloned() else {
        model.write().error = Some("点对点连接已经断开".to_owned());
        return;
    };
    if let Err(error) = peer.decide_transfer(transfer_id, accepted) {
        model.write().error = Some(friendly_transfer_error(&error));
    } else {
        model.write().error = None;
    }
}

async fn accept_streaming_transfer(
    mut model: Signal<AppModel>,
    rtc_peers: Signal<BTreeMap<String, RtcPeer>>,
    peer_id: String,
    transfer_id: String,
    file_names: Vec<String>,
) {
    let Some(peer) = rtc_peers.read().get(&peer_id).cloned() else {
        model.write().error = Some("点对点连接已经断开".to_owned());
        return;
    };
    let writers = match choose_stream_files(&file_names).await {
        Ok(writers) => writers,
        Err(BrowserPlatformError::UserCancelled) => return,
        Err(error) => {
            model.write().error = Some(friendly_transfer_error(&error));
            return;
        }
    };
    if let Err(error) = peer.accept_stream_transfer(&transfer_id, writers).await {
        model.write().error = Some(friendly_transfer_error(&error));
    } else {
        let mut state = model.write();
        state.error = None;
        state.notice = Some(if file_names.len() > 1 {
            "已选择保存文件夹，开始按顺序接收".to_owned()
        } else {
            "已选择保存位置，开始接收文件".to_owned()
        });
    }
}

async fn resume_streaming_transfer(
    mut model: Signal<AppModel>,
    rtc_peers: Signal<BTreeMap<String, RtcPeer>>,
    peer_id: String,
    transfer_id: String,
) {
    let Some(peer) = rtc_peers.read().get(&peer_id).cloned() else {
        model.write().error = Some("点对点连接已经断开".to_owned());
        return;
    };
    if let Err(error) = peer.resume_stream_transfer(&transfer_id).await {
        model.write().error = Some(friendly_transfer_error(&error));
    } else {
        let mut state = model.write();
        state.error = None;
        state.notice = Some("已校验原保存位置，继续接收".to_owned());
    }
}

fn cancel_current_transfers(
    mut model: Signal<AppModel>,
    rtc_peers: Signal<BTreeMap<String, RtcPeer>>,
    role: RoomRole,
    batch_peer_ids: Vec<String>,
) {
    let reason = if role == RoomRole::Owner {
        CancelReason::SenderCancelled
    } else {
        CancelReason::ReceiverCancelled
    };
    let peer_ids = if role == RoomRole::Owner {
        batch_peer_ids
    } else {
        model
            .read()
            .transfers_by_peer
            .iter()
            .filter(|(_, transfer)| transfer_is_active(transfer))
            .map(|(peer_id, _)| peer_id.clone())
            .collect()
    };
    let peers = {
        let peers = rtc_peers.read();
        peer_ids
            .into_iter()
            .filter_map(|peer_id| peers.get(&peer_id).cloned())
            .collect::<Vec<_>>()
    };
    spawn(async move {
        let mut last_error = None;
        for peer in peers {
            if let Err(error) = peer.cancel_transfer(reason).await {
                last_error = Some(friendly_transfer_error(&error));
            }
        }
        model.write().error = last_error;
    });
}

fn retry_paused_transfers(
    mut model: Signal<AppModel>,
    rtc_peers: Signal<BTreeMap<String, RtcPeer>>,
    peer_ids: Vec<String>,
) {
    let peers = {
        let peers = rtc_peers.read();
        peer_ids
            .into_iter()
            .filter_map(|peer_id| peers.get(&peer_id).cloned().map(|peer| (peer_id, peer)))
            .collect::<Vec<_>>()
    };
    for (peer_id, peer) in peers {
        let paused = matches!(
            model.read().transfers_by_peer.get(&peer_id),
            Some(TransferState::Active {
                link_state: TransferLinkState::Paused,
                ..
            })
        );
        if !paused {
            continue;
        }
        peer.prepare_reconnect();
        {
            let mut state = model.write();
            set_peer_transfer_link_state(&mut state, &peer_id, TransferLinkState::Waiting);
            state.error = None;
        }
        start_rtc_offer(model, rtc_peers, peer, peer_id, 0);
    }
}

fn set_peer_transfer_link_state(
    model: &mut AppModel,
    peer_id: &str,
    link_state: TransferLinkState,
) -> bool {
    let updated = model
        .transfers_by_peer
        .get_mut(peer_id)
        .and_then(|transfer| {
            if let TransferState::Active {
                streamed: true,
                link_state: current,
                ..
            } = transfer
            {
                *current = link_state;
                Some(transfer.clone())
            } else {
                None
            }
        });
    if let Some(transfer) = updated {
        if matches!(
            model.screen,
            Screen::Room {
                role: RoomRole::Receiver,
                ..
            }
        ) {
            model.transfer = transfer;
        }
        true
    } else {
        false
    }
}

fn rtc_retry_delay_ms(attempt: u8) -> Option<u32> {
    RTC_RETRY_DELAYS_MS.get(usize::from(attempt)).copied()
}

fn transfer_is_active(transfer: &TransferState) -> bool {
    matches!(
        transfer,
        TransferState::Offering { .. }
            | TransferState::OutgoingRecovery { .. }
            | TransferState::Active { .. }
    )
}

fn transfer_progress(transfer: &TransferState) -> (u64, u64, f64) {
    let Some(file) = transfer_file(transfer) else {
        return (0, 0, 0.0);
    };
    let completed = match transfer {
        TransferState::Active {
            completed_bytes, ..
        } => *completed_bytes,
        TransferState::Completed { .. } => file.size_bytes,
        _ => 0,
    };
    let progress = if file.size_bytes == 0 && transfer_is_active(transfer) {
        100.0
    } else if file.size_bytes == 0 {
        0.0
    } else {
        (completed as f64 / file.size_bytes as f64 * 100.0).clamp(0.0, 100.0)
    };
    (completed, file.size_bytes, progress)
}

fn owner_transfer_progress(transfers: &[TransferState]) -> (u64, u64, f64) {
    let (completed, total) = transfers.iter().fold((0_u64, 0_u64), |result, transfer| {
        let (completed, total, _) = transfer_progress(transfer);
        (
            result.0.saturating_add(completed),
            result.1.saturating_add(total),
        )
    });
    let progress = if total == 0 && !transfers.is_empty() {
        100.0
    } else if total == 0 {
        0.0
    } else {
        (completed as f64 / total as f64 * 100.0).clamp(0.0, 100.0)
    };
    (completed, total, progress)
}

fn completed_transfer_hash(transfers: &[TransferState]) -> Option<String> {
    if transfers.is_empty()
        || transfers
            .iter()
            .any(|transfer| !matches!(transfer, TransferState::Completed { .. }))
    {
        return None;
    }
    transfers.iter().find_map(|transfer| {
        if let TransferState::Completed { blake3, .. } = transfer {
            Some(blake3.clone())
        } else {
            None
        }
    })
}

fn receiver_transfer_status(transfer: Option<&TransferState>) -> String {
    match transfer {
        Some(TransferState::Offering { .. }) => "等待确认".to_owned(),
        Some(TransferState::OutgoingRecovery { .. }) => "等待继续".to_owned(),
        Some(TransferState::Active {
            awaiting_verification: true,
            ..
        }) => "校验中".to_owned(),
        Some(TransferState::Active {
            storage_pause: Some(_),
            ..
        }) => "接收方暂停".to_owned(),
        Some(TransferState::Active {
            link_state: TransferLinkState::Paused,
            ..
        }) => "等待重连".to_owned(),
        Some(TransferState::Active {
            link_state: TransferLinkState::Waiting,
            ..
        }) => "重连中".to_owned(),
        Some(active @ TransferState::Active { .. }) => {
            let (_, _, progress) = transfer_progress(active);
            format!("{progress:.0}%")
        }
        Some(TransferState::Rejected { .. }) => "已拒绝".to_owned(),
        Some(TransferState::Completed { .. }) => "已完成".to_owned(),
        Some(TransferState::Cancelled { .. }) => "已取消".to_owned(),
        Some(TransferState::Failed { .. }) => "失败".to_owned(),
        Some(TransferState::Incoming { .. }) => "等待处理".to_owned(),
        Some(TransferState::Idle) | None => "正在准备".to_owned(),
    }
}

fn owner_transfer_panel_copy(
    receiver_count: usize,
    selected_count: usize,
    ready_count: usize,
    transfers: &[TransferState],
) -> (String, String) {
    if transfers.len() == 1 {
        return transfer_panel_copy(
            RoomRole::Owner,
            receiver_count,
            RtcPhase::Ready,
            &transfers[0],
        );
    }
    if transfers
        .iter()
        .any(|transfer| matches!(transfer, TransferState::OutgoingRecovery { .. }))
    {
        return (
            "继续发送文件".to_owned(),
            "请重新允许读取原文件，传输会从已校验的位置继续。".to_owned(),
        );
    }
    if transfers.iter().any(|transfer| {
        matches!(
            transfer,
            TransferState::Active {
                storage_pause: Some(_),
                ..
            }
        )
    }) {
        return (
            "接收方已暂停".to_owned(),
            "部分接收方需要处理保存位置，其他接收方不受影响。".to_owned(),
        );
    }
    if transfers.iter().any(|transfer| {
        matches!(
            transfer,
            TransferState::Active {
                link_state: TransferLinkState::Paused,
                ..
            }
        )
    }) {
        return (
            "自动重连已暂停".to_owned(),
            "暂时无法恢复部分连接，可以重新连接或取消传输。".to_owned(),
        );
    }
    if transfers.iter().any(|transfer| {
        matches!(
            transfer,
            TransferState::Active {
                link_state: TransferLinkState::Waiting,
                ..
            }
        )
    }) {
        return (
            "等待接收者恢复连接".to_owned(),
            "连接暂时中断，正在从已校验的位置重试。".to_owned(),
        );
    }
    if transfers
        .iter()
        .any(|transfer| matches!(transfer, TransferState::Active { .. }))
    {
        return (
            "正在发送文件".to_owned(),
            format!("各接收者会独立确认和校验，当前共 {} 位。", transfers.len()),
        );
    }
    if transfers
        .iter()
        .any(|transfer| matches!(transfer, TransferState::Offering { .. }))
    {
        return (
            "等待接收者确认".to_owned(),
            format!("已向 {} 位接收者发送请求，结果彼此独立。", transfers.len()),
        );
    }
    if !transfers.is_empty() {
        let completed = transfers
            .iter()
            .filter(|transfer| matches!(transfer, TransferState::Completed { .. }))
            .count();
        let rejected = transfers
            .iter()
            .filter(|transfer| matches!(transfer, TransferState::Rejected { .. }))
            .count();
        let cancelled = transfers
            .iter()
            .filter(|transfer| matches!(transfer, TransferState::Cancelled { .. }))
            .count();
        let failed = transfers
            .iter()
            .filter(|transfer| matches!(transfer, TransferState::Failed { .. }))
            .count();
        return (
            "本次发送已结束".to_owned(),
            format!("完成 {completed} · 拒绝 {rejected} · 取消 {cancelled} · 失败 {failed}"),
        );
    }
    if receiver_count == 0 {
        return (
            "等待接收者加入".to_owned(),
            "分享房间邀请，接收者加入后会显示在上方。".to_owned(),
        );
    }
    if selected_count == 0 {
        return (
            "选择接收者".to_owned(),
            "至少选择一位接收者后才能发送文件。".to_owned(),
        );
    }
    if ready_count < selected_count {
        return (
            "正在建立点对点连接".to_owned(),
            format!("已连接 {ready_count} / {selected_count} 位接收者。"),
        );
    }
    (
        "选择要发送的文件".to_owned(),
        format!("最多选择 10 个文件，将直接发送给已选择的 {selected_count} 位接收者。"),
    )
}

fn transfer_file(transfer: &TransferState) -> Option<&TransferFile> {
    match transfer {
        TransferState::Offering { file, .. }
        | TransferState::OutgoingRecovery { file, .. }
        | TransferState::Incoming { file, .. }
        | TransferState::Active { file, .. }
        | TransferState::Rejected { file, .. }
        | TransferState::Completed { file, .. } => Some(file),
        TransferState::Cancelled { file, .. } | TransferState::Failed { file, .. } => file.as_ref(),
        TransferState::Idle => None,
    }
}

fn transfer_files(transfer: &TransferState) -> Option<&[TransferFile]> {
    match transfer {
        TransferState::Offering { files, .. }
        | TransferState::OutgoingRecovery { files, .. }
        | TransferState::Incoming { files, .. }
        | TransferState::Active { files, .. }
        | TransferState::Rejected { files, .. }
        | TransferState::Completed { files, .. } => Some(files),
        TransferState::Cancelled { .. } | TransferState::Failed { .. } | TransferState::Idle => {
            None
        }
    }
}

fn transfer_is_streamed(transfer: &TransferState) -> bool {
    match transfer {
        TransferState::OutgoingRecovery { .. } => true,
        TransferState::Incoming { mode, .. } => matches!(mode, TransferMode::Streamed { .. }),
        TransferState::Active { streamed, .. } => *streamed,
        TransferState::Completed {
            direction: TransferDirection::Receive,
            download_url,
            ..
        } => download_url.is_none(),
        _ => false,
    }
}

fn transfer_panel_copy(
    role: RoomRole,
    receiver_count: usize,
    rtc: RtcPhase,
    transfer: &TransferState,
) -> (String, String) {
    match transfer {
        TransferState::Offering { .. } => (
            "等待接收者确认".to_owned(),
            "接收者确认后才会开始传输文件。".to_owned(),
        ),
        TransferState::OutgoingRecovery { .. } => (
            "继续发送文件".to_owned(),
            "请重新允许读取原文件，传输会从已校验的位置继续。".to_owned(),
        ),
        TransferState::Incoming { .. } => (
            "收到文件请求".to_owned(),
            "确认文件信息后选择是否接收。".to_owned(),
        ),
        TransferState::Active {
            direction,
            awaiting_verification,
            link_state,
            storage_pause,
            ..
        } => {
            if let Some(reason) = storage_pause {
                match (role, reason) {
                    (RoomRole::Receiver, StreamPauseReason::DestinationQuotaExceeded) => (
                        "存储空间不足".to_owned(),
                        "已保留最后一个校验检查点，释放空间后可以继续接收。".to_owned(),
                    ),
                    (RoomRole::Receiver, StreamPauseReason::DestinationPermissionDenied) => (
                        "保存权限已失效".to_owned(),
                        "已保留最后一个校验检查点，重新授权后可以继续接收。".to_owned(),
                    ),
                    (RoomRole::Owner, StreamPauseReason::DestinationQuotaExceeded) => (
                        "接收方存储空间不足".to_owned(),
                        "已暂停发送并保留进度，接收方处理后会从检查点继续。".to_owned(),
                    ),
                    (RoomRole::Owner, StreamPauseReason::DestinationPermissionDenied) => (
                        "接收方保存权限已失效".to_owned(),
                        "已暂停发送并保留进度，接收方重新授权后会从检查点继续。".to_owned(),
                    ),
                }
            } else if *link_state == TransferLinkState::Paused {
                let description = if role == RoomRole::Owner {
                    "暂时无法恢复连接，可以重新连接或取消传输。"
                } else {
                    "请等待发送者重新连接，或取消本次传输。"
                };
                ("自动重连已暂停".to_owned(), description.to_owned())
            } else if *link_state == TransferLinkState::Waiting {
                (
                    "等待对端恢复".to_owned(),
                    "连接暂时中断，正在从已校验的位置重试。".to_owned(),
                )
            } else if *awaiting_verification {
                (
                    "等待完整性校验".to_owned(),
                    "文件已经发送，正在等待接收端确认 BLAKE3 校验结果。".to_owned(),
                )
            } else if *direction == TransferDirection::Send {
                (
                    "正在发送文件".to_owned(),
                    "请保持当前页面打开，传输数据不会经过应用服务器。".to_owned(),
                )
            } else {
                let description = if transfer_is_streamed(transfer) {
                    "文件正在直接写入所选位置，请保持页面打开。"
                } else {
                    "接收完成并通过校验后才会提供保存按钮。"
                };
                ("正在接收文件".to_owned(), description.to_owned())
            }
        }
        TransferState::Rejected { direction, .. } => {
            let title = if *direction == TransferDirection::Send {
                "接收者已拒绝"
            } else {
                "已拒绝接收"
            };
            (
                title.to_owned(),
                "可以继续留在房间中等待下一次传输。".to_owned(),
            )
        }
        TransferState::Completed {
            direction,
            download_url,
            ..
        } => {
            let title = if *direction == TransferDirection::Send {
                "文件发送完成"
            } else {
                "文件接收完成"
            };
            let description = if *direction == TransferDirection::Receive && download_url.is_none()
            {
                "文件已保存到所选位置，字节数和 BLAKE3 校验均已通过。"
            } else {
                "文件字节数和 BLAKE3 完整性校验均已通过。"
            };
            (title.to_owned(), description.to_owned())
        }
        TransferState::Cancelled { reason, .. } => (
            "传输已取消".to_owned(),
            format!("{}，可以继续使用当前房间。", cancel_reason_copy(*reason)),
        ),
        TransferState::Failed { message, .. } => ("传输失败".to_owned(), message.clone()),
        TransferState::Idle => {
            if role == RoomRole::Owner && receiver_count == 0 {
                return (
                    "等待接收者加入".to_owned(),
                    "分享房间邀请，接收者加入后会显示在上方。".to_owned(),
                );
            }
            if receiver_count > 1 && role == RoomRole::Owner {
                return (
                    "当前支持单接收者".to_owned(),
                    "一个房间一次只向一位在线接收者发送文件。".to_owned(),
                );
            }
            match rtc {
                RtcPhase::Ready if role == RoomRole::Owner => (
                    "选择要发送的文件".to_owned(),
                    "文件通过加密的 WebRTC DataChannel 直接发送。".to_owned(),
                ),
                RtcPhase::Ready => (
                    "等待对方发送".to_owned(),
                    "收到文件请求后，你可以确认或拒绝。".to_owned(),
                ),
                RtcPhase::Failed => (
                    "点对点连接失败".to_owned(),
                    "请保持页面打开，或退出房间后重新连接。".to_owned(),
                ),
                RtcPhase::Disconnected => (
                    "点对点连接已断开".to_owned(),
                    "正在等待房间连接恢复。".to_owned(),
                ),
                RtcPhase::Inactive | RtcPhase::WaitingPeer | RtcPhase::Connecting => (
                    "正在建立点对点连接".to_owned(),
                    "连接就绪后即可开始传输文件。".to_owned(),
                ),
            }
        }
    }
}

fn cancel_reason_copy(reason: CancelReason) -> &'static str {
    match reason {
        CancelReason::SenderCancelled => "发送者取消了本次传输",
        CancelReason::ReceiverCancelled => "接收者取消了本次传输",
        CancelReason::Timeout => "本次传输已经超时",
        CancelReason::PeerClosed => "对方的点对点连接已经关闭",
    }
}

fn format_bytes(bytes: u64) -> String {
    const KIB: f64 = 1024.0;
    const MIB: f64 = KIB * 1024.0;
    const GIB: f64 = MIB * 1024.0;
    let value = bytes as f64;
    if value >= GIB {
        format!("{:.2} GiB", value / GIB)
    } else if value >= MIB {
        format!("{:.2} MiB", value / MIB)
    } else if value >= KIB {
        format!("{:.1} KiB", value / KIB)
    } else {
        format!("{bytes} B")
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
fn JoinRequestDialog(mut model: Signal<AppModel>, request: JoinRequestSnapshot) -> Element {
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
                            move |_| submit_decision(model, request_id.clone(), JoinDecisionRequest::Reject)
                        },
                        if pending { "处理中…" } else { "拒绝" }
                    }
                    button {
                        class: "primary-button",
                        r#type: "button",
                        disabled: pending,
                        onclick: {
                            let request_id = request.request_id.clone();
                            move |_| submit_decision(model, request_id.clone(), JoinDecisionRequest::Approve)
                        },
                        if pending { "处理中…" } else { "允许加入" }
                    }
                }
        }
    }
}

fn submit_decision(mut model: Signal<AppModel>, request_id: String, decision: JoinDecisionRequest) {
    if model.read().decision_request_id.is_some() {
        return;
    }
    let (room_code, revision) = {
        let state = model.read();
        let Screen::Room { snapshot, .. } = &state.screen else {
            return;
        };
        (snapshot.room_code.clone(), snapshot.revision)
    };
    model.write().decision_request_id = Some(request_id.clone());
    spawn(async move {
        let result = async {
            decide_join(&room_code, &request_id, decision, Some(revision)).await?;
            bootstrap_room(&room_code).await
        }
        .await;
        match result {
            Ok(snapshot) => {
                let entering = apply_snapshot(&mut model.write(), snapshot);
                schedule_avatar_cleanup(model, entering);
            }
            Err(error) => model.write().error = Some(friendly_error(&error)),
        }
        model.write().decision_request_id = None;
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

fn return_to_lobby(
    mut model: Signal<AppModel>,
    mut realtime_target: Signal<Option<RealtimeTarget>>,
    notice: Option<String>,
) {
    realtime_target.set(None);
    let _ = clear_room_session();
    let mut state = model.write();
    state.screen = Screen::Lobby {
        room_code: String::new(),
        invite_capability: None,
    };
    state.realtime = RealtimePhase::Disconnected;
    state.rtc = RtcPhase::Inactive;
    state.transfer = TransferState::Idle;
    state.pending_signals.clear();
    state.rtc_by_peer.clear();
    state.transfers_by_peer.clear();
    state.busy = false;
    state.error = None;
    state.notice = notice;
    state.entering_receivers.clear();
}

fn handle_realtime_event(
    mut model: Signal<AppModel>,
    realtime_target: Signal<Option<RealtimeTarget>>,
    reconnect_attempt: Signal<u32>,
    rtc: RtcRuntime,
    mut lifecycle_state: Signal<LifecycleState>,
    attempt: u32,
    event: RealtimeEvent,
) {
    match event {
        RealtimeEvent::Open => model.write().realtime = RealtimePhase::Connecting,
        RealtimeEvent::Message(message) => match message {
            ServerRealtimeMessage::Attached { .. } => {
                let lifecycle_recovered = {
                    let mut lifecycle = lifecycle_state.write();
                    let recovered = lifecycle.recovery_in_progress;
                    lifecycle.recovery_in_progress = false;
                    recovered
                };
                let mut state = model.write();
                state.realtime = RealtimePhase::Connected;
                if lifecycle_recovered {
                    state.notice = Some("连接已恢复".to_owned());
                }
                drop(state);
                complete_lifecycle_peer_rebuild(model, rtc, lifecycle_state);
                sync_rtc_peers(model, rtc.connection, rtc.peers, rtc.config);
            }
            ServerRealtimeMessage::JoinWatching { .. } => {
                model.write().realtime = RealtimePhase::Connected;
            }
            ServerRealtimeMessage::RoomSnapshot {
                room_id,
                room_code,
                revision,
                expires_at_ms,
                participants,
                pending_join_requests,
                ..
            } => {
                let snapshot = RoomBootstrapResponse {
                    version: CURRENT_PROTOCOL,
                    room_id,
                    room_code,
                    revision,
                    expires_at_ms,
                    participants,
                    pending_join_requests,
                };
                let waiting_missing = match &model.read().screen {
                    Screen::Waiting { request_id, .. } => !snapshot
                        .pending_join_requests
                        .iter()
                        .any(|request| &request.request_id == request_id),
                    _ => false,
                };
                let entering = apply_snapshot(&mut model.write(), snapshot);
                schedule_avatar_cleanup(model, entering);
                sync_rtc_peers(model, rtc.connection, rtc.peers, rtc.config);
                if waiting_missing {
                    resolve_waiting(model, realtime_target);
                }
            }
            ServerRealtimeMessage::JoinRequested {
                revision, request, ..
            } => {
                if let Screen::Room {
                    role: RoomRole::Owner,
                    snapshot,
                    ..
                } = &mut model.write().screen
                {
                    snapshot.revision = revision;
                    if !snapshot
                        .pending_join_requests
                        .iter()
                        .any(|existing| existing.request_id == request.request_id)
                    {
                        snapshot.pending_join_requests.push(request);
                    }
                }
            }
            ServerRealtimeMessage::JoinDecided {
                revision,
                request_id,
                decision,
                ..
            } => {
                if model.read().decision_request_id.as_deref() == Some(&request_id) {
                    model.write().decision_request_id = None;
                }
                let waiting = matches!(
                    &model.read().screen,
                    Screen::Waiting { request_id: current, .. } if current == &request_id
                );
                if waiting {
                    match decision {
                        JoinDecisionWire::Approved => resolve_waiting(model, realtime_target),
                        JoinDecisionWire::Rejected => return_to_lobby(
                            model,
                            realtime_target,
                            Some("发送者未允许本次加入申请".to_owned()),
                        ),
                    }
                } else if let Screen::Room { snapshot, .. } = &mut model.write().screen {
                    snapshot.revision = revision;
                    snapshot
                        .pending_join_requests
                        .retain(|request| request.request_id != request_id);
                }
            }
            ServerRealtimeMessage::PeerOnline {
                revision,
                session_id,
                peer_id,
                ..
            } => {
                let should_refresh =
                    if let Screen::Room { snapshot, .. } = &mut model.write().screen {
                        snapshot.revision = revision;
                        if let Some(participant) = snapshot
                            .participants
                            .iter_mut()
                            .find(|participant| participant.session_id == session_id)
                        {
                            participant.online = true;
                            participant.peer_id = Some(peer_id.clone());
                        }
                        true
                    } else {
                        false
                    };
                sync_rtc_peers(model, rtc.connection, rtc.peers, rtc.config);
                if should_refresh {
                    refresh_room_snapshot(model, rtc);
                }
            }
            ServerRealtimeMessage::PeerOffline {
                revision,
                session_id,
                ..
            } => {
                let own_session = model
                    .read()
                    .session
                    .as_ref()
                    .map(|session| session.session_id.clone());
                let remote_peer_id = if own_session.as_deref() != Some(session_id.as_str()) {
                    match &model.read().screen {
                        Screen::Room { snapshot, .. } => snapshot
                            .participants
                            .iter()
                            .find(|participant| participant.session_id == session_id)
                            .and_then(|participant| participant.peer_id.clone()),
                        _ => None,
                    }
                } else {
                    None
                };
                let should_refresh =
                    if let Screen::Room { snapshot, .. } = &mut model.write().screen {
                        snapshot.revision = revision;
                        if let Some(participant) = snapshot
                            .participants
                            .iter_mut()
                            .find(|participant| participant.session_id == session_id)
                        {
                            participant.online = false;
                            participant.peer_id = None;
                        }
                        true
                    } else {
                        false
                    };
                if let Some(peer_id) = remote_peer_id {
                    let preserve_peer = rtc.peers.read().get(&peer_id).is_some_and(|peer| {
                        peer.data_channel_ready() || peer.resumable_transfer_active()
                    });
                    if !preserve_peer {
                        remove_rtc_peer(model, rtc.peers, &peer_id);
                    }
                }
                if should_refresh {
                    refresh_room_snapshot(model, rtc);
                }
            }
            ServerRealtimeMessage::RoomExpired { .. } => return_to_lobby(
                model,
                realtime_target,
                Some("房间已过期，请创建或加入新的房间".to_owned()),
            ),
            ServerRealtimeMessage::Error { code, message, .. } => {
                if code == "join_request_resolved" {
                    resolve_waiting(model, realtime_target);
                } else if code != "connection_replaced" {
                    model.write().error = Some(message);
                }
            }
            ServerRealtimeMessage::Signal {
                from_peer_id,
                signal,
                ..
            } => {
                accept_rtc_signal(
                    model,
                    rtc.connection,
                    rtc.peers,
                    rtc.config,
                    from_peer_id,
                    signal,
                );
            }
        },
        RealtimeEvent::Error(error) => {
            model.write().realtime = RealtimePhase::Reconnecting;
            model.write().error = Some(error);
        }
        RealtimeEvent::Closed { code, .. } => {
            if code != 4001 && realtime_target.read().is_some() {
                model.write().realtime = RealtimePhase::Reconnecting;
                schedule_reconnect(realtime_target, reconnect_attempt, attempt);
            }
        }
    }
}

fn reset_all_rtc_peers(mut rtc_peers: Signal<BTreeMap<String, RtcPeer>>) {
    let peers = std::mem::take(&mut *rtc_peers.write());
    for peer in peers.into_values() {
        peer.reset();
    }
}

fn remote_peer_ids(model: &AppModel) -> Option<(RoomRole, Vec<String>)> {
    let Screen::Room { role, snapshot, .. } = &model.screen else {
        return None;
    };
    let remote_role = if *role == RoomRole::Owner {
        ParticipantRoleWire::Receiver
    } else {
        ParticipantRoleWire::Owner
    };
    let peer_ids = snapshot
        .participants
        .iter()
        .filter(|participant| participant.role == remote_role && participant.online)
        .filter_map(|participant| participant.peer_id.clone())
        .collect();
    Some((*role, peer_ids))
}

fn sync_rtc_peers(
    mut model: Signal<AppModel>,
    connection: Signal<Option<RealtimeConnection>>,
    rtc_peers: Signal<BTreeMap<String, RtcPeer>>,
    rtc_config: Signal<Option<RtcConfigResponse>>,
) {
    let Some(config) = rtc_config.read().clone() else {
        return;
    };
    let Some((role, desired_peer_ids)) = remote_peer_ids(&model.read()) else {
        return;
    };
    let desired = desired_peer_ids.iter().cloned().collect::<BTreeSet<_>>();
    let stale = rtc_peers
        .read()
        .keys()
        .filter(|peer_id| !desired.contains(*peer_id))
        .cloned()
        .collect::<Vec<_>>();
    for peer_id in stale {
        if rtc_peers
            .read()
            .get(&peer_id)
            .is_some_and(|peer| peer.data_channel_ready() || peer.resumable_transfer_active())
        {
            continue;
        }
        remove_rtc_peer(model, rtc_peers, &peer_id);
    }
    for peer_id in desired_peer_ids {
        let Some(peer) = ensure_rtc_peer(model, connection, rtc_peers, &config, peer_id.clone())
        else {
            continue;
        };
        if role == RoomRole::Owner {
            let phase = model.read().rtc_by_peer.get(&peer_id).copied();
            if phase == Some(RtcPhase::WaitingPeer) {
                {
                    let mut state = model.write();
                    state
                        .rtc_by_peer
                        .insert(peer_id.clone(), RtcPhase::Connecting);
                    refresh_aggregate_rtc(&mut state);
                }
                spawn(async move {
                    if let Err(error) = peer.restore_outgoing_transfer(&peer_id).await {
                        model.write().error = Some(friendly_transfer_error(&error));
                    }
                    let still_current = rtc_peers
                        .peek()
                        .get(&peer_id)
                        .is_some_and(|current| current.ptr_eq(&peer));
                    if still_current {
                        start_rtc_offer(model, rtc_peers, peer, peer_id, 0);
                    }
                });
            } else if phase != Some(RtcPhase::Ready)
                && !matches!(
                    model.read().transfers_by_peer.get(&peer_id),
                    Some(TransferState::Active {
                        link_state: TransferLinkState::Paused,
                        ..
                    })
                )
            {
                start_rtc_offer(model, rtc_peers, peer, peer_id, 0);
            }
        }
    }
    refresh_aggregate_rtc(&mut model.write());
}

fn ensure_rtc_peer(
    mut model: Signal<AppModel>,
    connection: Signal<Option<RealtimeConnection>>,
    mut rtc_peers: Signal<BTreeMap<String, RtcPeer>>,
    config: &RtcConfigResponse,
    peer_id: String,
) -> Option<RtcPeer> {
    if let Some(peer) = rtc_peers.read().get(&peer_id).cloned() {
        return Some(peer);
    }
    let callback_peer_id = peer_id.clone();
    let on_rtc_event = Callback::new(move |event| {
        handle_rtc_event(
            model,
            connection,
            rtc_peers,
            callback_peer_id.clone(),
            event,
        );
    });
    match RtcPeer::new(config.clone(), on_rtc_event.into_closure()) {
        Ok(peer) => {
            rtc_peers.write().insert(peer_id.clone(), peer.clone());
            let mut state = model.write();
            state
                .rtc_by_peer
                .entry(peer_id)
                .or_insert(RtcPhase::WaitingPeer);
            refresh_aggregate_rtc(&mut state);
            Some(peer)
        }
        Err(error) => {
            let mut state = model.write();
            state.error = Some(friendly_error(&error));
            state.rtc = RtcPhase::Failed;
            None
        }
    }
}

fn remove_rtc_peer(
    mut model: Signal<AppModel>,
    mut rtc_peers: Signal<BTreeMap<String, RtcPeer>>,
    peer_id: &str,
) {
    if let Some(peer) = rtc_peers.write().remove(peer_id) {
        peer.reset();
    }
    let mut state = model.write();
    state.rtc_by_peer.remove(peer_id);
    state.transfers_by_peer.remove(peer_id);
    if matches!(
        state.screen,
        Screen::Room {
            role: RoomRole::Receiver,
            ..
        }
    ) {
        state.transfer = TransferState::Idle;
    }
    refresh_aggregate_rtc(&mut state);
}

fn accept_rtc_signal(
    mut model: Signal<AppModel>,
    connection: Signal<Option<RealtimeConnection>>,
    rtc_peers: Signal<BTreeMap<String, RtcPeer>>,
    rtc_config: Signal<Option<RtcConfigResponse>>,
    from_peer_id: String,
    signal: ProtocolSignal,
) {
    let Some(config) = rtc_config.read().clone() else {
        let mut state = model.write();
        if state.pending_signals.len() < 64 {
            state.pending_signals.push((from_peer_id, signal));
        } else {
            state.error = Some("点对点协商消息过多，请重新进入房间".to_owned());
        }
        return;
    };
    let allowed = remote_peer_ids(&model.read())
        .is_some_and(|(_, peer_ids)| peer_ids.contains(&from_peer_id));
    if !allowed {
        return;
    }
    if let Some(peer) = ensure_rtc_peer(model, connection, rtc_peers, &config, from_peer_id.clone())
    {
        peer.accept_signal(from_peer_id, signal);
    }
}

fn start_rtc_offer(
    mut model: Signal<AppModel>,
    rtc_peers: Signal<BTreeMap<String, RtcPeer>>,
    peer: RtcPeer,
    target_peer: String,
    attempt: u8,
) {
    if !peer.start_offer(target_peer.clone()) {
        return;
    }
    {
        let mut state = model.write();
        state
            .rtc_by_peer
            .insert(target_peer.clone(), RtcPhase::Connecting);
        set_peer_transfer_link_state(&mut state, &target_peer, TransferLinkState::Waiting);
        refresh_aggregate_rtc(&mut state);
    }
    spawn(async move {
        sleep_ms(RTC_NEGOTIATION_TIMEOUT_MS).await;
        let still_current = rtc_peers
            .peek()
            .get(&target_peer)
            .is_some_and(|current| current.ptr_eq(&peer));
        if !still_current || model.peek().rtc_by_peer.get(&target_peer) == Some(&RtcPhase::Ready) {
            return;
        }
        if peer.data_channel_ready() {
            let mut state = model.write();
            state
                .rtc_by_peer
                .insert(target_peer.clone(), RtcPhase::Ready);
            refresh_aggregate_rtc(&mut state);
            return;
        }
        let Some(delay_ms) = rtc_retry_delay_ms(attempt) else {
            let mut state = model.write();
            state
                .rtc_by_peer
                .insert(target_peer.clone(), RtcPhase::Failed);
            let transfer_paused =
                set_peer_transfer_link_state(&mut state, &target_peer, TransferLinkState::Paused);
            refresh_aggregate_rtc(&mut state);
            if !transfer_paused {
                state.error = Some("有接收者的点对点连接失败，可以等待其重新连接".to_owned());
            }
            return;
        };
        peer.prepare_reconnect();
        sleep_ms(delay_ms).await;
        let still_current = rtc_peers
            .peek()
            .get(&target_peer)
            .is_some_and(|current| current.ptr_eq(&peer));
        if !still_current
            || model.peek().rtc_by_peer.get(&target_peer) == Some(&RtcPhase::Ready)
            || peer.data_channel_ready()
        {
            return;
        }
        start_rtc_offer(model, rtc_peers, peer, target_peer, attempt + 1);
    });
}

fn schedule_passive_recovery_timeout(
    mut model: Signal<AppModel>,
    rtc_peers: Signal<BTreeMap<String, RtcPeer>>,
    peer: RtcPeer,
    peer_id: String,
) {
    spawn(async move {
        sleep_ms(RTC_PASSIVE_RECOVERY_TIMEOUT_MS).await;
        let still_current = rtc_peers
            .peek()
            .get(&peer_id)
            .is_some_and(|current| current.ptr_eq(&peer));
        if !still_current
            || peer.data_channel_ready()
            || model.peek().rtc_by_peer.get(&peer_id) == Some(&RtcPhase::Ready)
        {
            return;
        }
        let mut state = model.write();
        if set_peer_transfer_link_state(&mut state, &peer_id, TransferLinkState::Paused) {
            state.rtc_by_peer.insert(peer_id, RtcPhase::Failed);
            refresh_aggregate_rtc(&mut state);
        }
    });
}

fn refresh_aggregate_rtc(model: &mut AppModel) {
    model.rtc = if model.rtc_by_peer.is_empty() {
        if matches!(model.screen, Screen::Room { .. }) {
            RtcPhase::WaitingPeer
        } else {
            RtcPhase::Inactive
        }
    } else if model
        .rtc_by_peer
        .values()
        .any(|phase| *phase == RtcPhase::Ready)
    {
        RtcPhase::Ready
    } else if model
        .rtc_by_peer
        .values()
        .any(|phase| *phase == RtcPhase::Connecting)
    {
        RtcPhase::Connecting
    } else if model
        .rtc_by_peer
        .values()
        .any(|phase| *phase == RtcPhase::Disconnected)
    {
        RtcPhase::Disconnected
    } else if model
        .rtc_by_peer
        .values()
        .any(|phase| *phase == RtcPhase::Failed)
    {
        RtcPhase::Failed
    } else {
        RtcPhase::WaitingPeer
    };
}

fn set_peer_transfer(model: &mut AppModel, peer_id: String, transfer: TransferState) {
    model.transfers_by_peer.insert(peer_id, transfer.clone());
    if matches!(
        model.screen,
        Screen::Room {
            role: RoomRole::Receiver,
            ..
        }
    ) {
        model.transfer = transfer;
    }
}

fn handle_rtc_event(
    mut model: Signal<AppModel>,
    connection: Signal<Option<RealtimeConnection>>,
    rtc_peers: Signal<BTreeMap<String, RtcPeer>>,
    peer_id: String,
    event: RtcEvent,
) {
    match event {
        RtcEvent::OutboundSignal { to_peer_id, signal } => {
            let room_code = match &model.read().screen {
                Screen::Room { snapshot, .. } => snapshot.room_code.clone(),
                _ => return,
            };
            let result = connection.read().as_ref().map_or_else(
                || {
                    Err(BrowserPlatformError::Browser(
                        "realtime connection is unavailable".to_owned(),
                    ))
                },
                |active| {
                    active.send(&ClientRealtimeMessage::Signal {
                        version: CURRENT_PROTOCOL,
                        room_code,
                        to_peer_id,
                        signal,
                    })
                },
            );
            if let Err(error) = result {
                model.write().error = Some(friendly_transfer_error(&error));
            }
        }
        RtcEvent::ConnectionState(phase) => {
            let should_reconnect = matches!(
                phase,
                RtcConnectionPhase::Failed | RtcConnectionPhase::Closed
            );
            let phase = match phase {
                RtcConnectionPhase::New | RtcConnectionPhase::Connecting => RtcPhase::Connecting,
                RtcConnectionPhase::Connected => RtcPhase::Connecting,
                RtcConnectionPhase::Disconnected | RtcConnectionPhase::Closed => {
                    RtcPhase::Disconnected
                }
                RtcConnectionPhase::Failed => RtcPhase::Failed,
            };
            let owner = matches!(
                model.read().screen,
                Screen::Room {
                    role: RoomRole::Owner,
                    ..
                }
            );
            {
                let mut state = model.write();
                state.rtc_by_peer.insert(peer_id.clone(), phase);
                if should_reconnect {
                    set_peer_transfer_link_state(&mut state, &peer_id, TransferLinkState::Waiting);
                }
                refresh_aggregate_rtc(&mut state);
            }
            if should_reconnect {
                let peer = rtc_peers.read().get(&peer_id).cloned();
                if let Some(peer) = peer {
                    spawn(async move {
                        sleep_ms(0).await;
                        let still_current = rtc_peers
                            .peek()
                            .get(&peer_id)
                            .is_some_and(|current| current.ptr_eq(&peer));
                        if !still_current
                            || owner
                                && model.peek().rtc_by_peer.get(&peer_id)
                                    == Some(&RtcPhase::Connecting)
                        {
                            return;
                        }
                        peer.prepare_reconnect();
                        if owner {
                            start_rtc_offer(model, rtc_peers, peer, peer_id, 0);
                        } else {
                            schedule_passive_recovery_timeout(model, rtc_peers, peer, peer_id);
                        }
                    });
                }
            }
        }
        RtcEvent::DataChannelReady => {
            let mut state = model.write();
            let recovered_stream = matches!(
                state.transfers_by_peer.get(&peer_id),
                Some(TransferState::Active {
                    streamed: true,
                    link_state: TransferLinkState::Waiting | TransferLinkState::Paused,
                    storage_pause: None,
                    ..
                })
            );
            state.rtc_by_peer.insert(peer_id, RtcPhase::Ready);
            refresh_aggregate_rtc(&mut state);
            state.error = None;
            if recovered_stream {
                state.notice = Some("连接已恢复，传输将从最后检查点继续".to_owned());
            }
        }
        RtcEvent::OutgoingOffered {
            transfer_id,
            file,
            files,
        } => {
            set_peer_transfer(
                &mut model.write(),
                peer_id,
                TransferState::Offering {
                    transfer_id,
                    file,
                    files,
                },
            );
        }
        RtcEvent::OutgoingRecoveryOffered {
            transfer_id,
            file,
            files,
        } => {
            set_peer_transfer(
                &mut model.write(),
                peer_id,
                TransferState::OutgoingRecovery {
                    transfer_id,
                    file,
                    files,
                },
            );
        }
        RtcEvent::IncomingOffered {
            transfer_id,
            mode,
            file,
            files,
            recovery_available,
        } => {
            let file_count = files.len().max(1);
            let body = if file_count == 1 {
                format!("收到文件：{}", file.name)
            } else {
                format!("收到 {} 等 {file_count} 个文件", file.name)
            };
            let _ = send_notification("收到文件请求", &body, &format!("file-{transfer_id}"));
            set_peer_transfer(
                &mut model.write(),
                peer_id,
                TransferState::Incoming {
                    transfer_id,
                    mode,
                    file,
                    files,
                    recovery_available,
                },
            );
        }
        RtcEvent::TransferStarted {
            transfer_id,
            direction,
            mode,
            file,
            files,
        } => {
            let completed_bytes = model
                .read()
                .transfers_by_peer
                .get(&peer_id)
                .and_then(|transfer| match transfer {
                    TransferState::Active {
                        transfer_id: current_id,
                        completed_bytes,
                        ..
                    } if current_id == &transfer_id => Some(*completed_bytes),
                    _ => None,
                })
                .unwrap_or(0);
            set_peer_transfer(
                &mut model.write(),
                peer_id,
                TransferState::Active {
                    transfer_id,
                    direction,
                    streamed: matches!(mode, TransferMode::Streamed { .. }),
                    completed_bytes,
                    file,
                    files,
                    awaiting_verification: false,
                    link_state: TransferLinkState::Ready,
                    storage_pause: None,
                },
            );
        }
        RtcEvent::TransferProgress {
            transfer_id,
            direction,
            completed_bytes,
            ..
        } => {
            let current = {
                let state = model.read();
                state.transfers_by_peer.get(&peer_id).and_then(|transfer| {
                    transfer_file(transfer).cloned().map(|file| {
                        (
                            file,
                            transfer_files(transfer).unwrap_or_default().to_vec(),
                            transfer_is_streamed(transfer),
                        )
                    })
                })
            };
            if let Some((file, files, streamed)) = current {
                set_peer_transfer(
                    &mut model.write(),
                    peer_id,
                    TransferState::Active {
                        transfer_id,
                        direction,
                        streamed,
                        file,
                        files,
                        completed_bytes,
                        awaiting_verification: false,
                        link_state: TransferLinkState::Ready,
                        storage_pause: None,
                    },
                );
            }
        }
        RtcEvent::TransferPaused {
            transfer_id,
            direction,
            reason,
            completed_bytes,
            ..
        } => {
            let paused = {
                let state = model.read();
                state
                    .transfers_by_peer
                    .get(&peer_id)
                    .cloned()
                    .and_then(|mut transfer| {
                        if let TransferState::Active {
                            transfer_id: current_id,
                            direction: current_direction,
                            completed_bytes: current_bytes,
                            awaiting_verification,
                            link_state,
                            storage_pause,
                            ..
                        } = &mut transfer
                            && current_id == &transfer_id
                        {
                            *current_direction = direction;
                            *current_bytes = completed_bytes;
                            *awaiting_verification = false;
                            *link_state = TransferLinkState::Ready;
                            *storage_pause = Some(reason);
                            Some(transfer)
                        } else {
                            None
                        }
                    })
            };
            if let Some(paused) = paused {
                let mut state = model.write();
                state.error = None;
                state.notice = Some(if direction == TransferDirection::Receive {
                    "传输已暂停，最后一个校验检查点已保留".to_owned()
                } else {
                    "接收方已暂停传输，当前进度已保留".to_owned()
                });
                set_peer_transfer(&mut state, peer_id, paused);
            }
        }
        RtcEvent::AwaitingVerification {
            transfer_id,
            file,
            files,
        } => {
            let streamed = model
                .read()
                .transfers_by_peer
                .get(&peer_id)
                .is_some_and(transfer_is_streamed);
            set_peer_transfer(
                &mut model.write(),
                peer_id,
                TransferState::Active {
                    transfer_id,
                    direction: TransferDirection::Send,
                    streamed,
                    completed_bytes: file.size_bytes,
                    file,
                    files,
                    awaiting_verification: true,
                    link_state: TransferLinkState::Ready,
                    storage_pause: None,
                },
            );
        }
        RtcEvent::TransferRejected {
            direction,
            file,
            files,
            ..
        } => {
            set_peer_transfer(
                &mut model.write(),
                peer_id,
                TransferState::Rejected {
                    direction,
                    file,
                    files,
                },
            );
        }
        RtcEvent::TransferCompleted {
            direction,
            file,
            files,
            blake3,
            download_url,
            ..
        } => {
            if direction == TransferDirection::Receive {
                let file_count = files.len().max(1);
                let body = if file_count == 1 {
                    format!("{} 已通过完整性校验", file.name)
                } else {
                    format!("{file_count} 个文件已通过完整性校验")
                };
                let _ =
                    send_notification("文件接收完成", &body, &format!("file-received-{peer_id}"));
            }
            let mut state = model.write();
            state.notice = Some(if direction == TransferDirection::Send {
                "文件已发送并通过接收端校验".to_owned()
            } else if download_url.is_none() {
                "文件已保存并通过完整性校验".to_owned()
            } else {
                "文件已接收并通过完整性校验".to_owned()
            });
            set_peer_transfer(
                &mut state,
                peer_id,
                TransferState::Completed {
                    direction,
                    file,
                    files,
                    blake3,
                    download_url,
                },
            );
        }
        RtcEvent::TransferCancelled { reason, .. } => {
            let file = {
                let state = model.read();
                state
                    .transfers_by_peer
                    .get(&peer_id)
                    .and_then(transfer_file)
                    .cloned()
            };
            set_peer_transfer(
                &mut model.write(),
                peer_id,
                TransferState::Cancelled { file, reason },
            );
        }
        RtcEvent::TransferFailed { message, .. } => {
            let file = {
                let state = model.read();
                state
                    .transfers_by_peer
                    .get(&peer_id)
                    .and_then(transfer_file)
                    .cloned()
            };
            set_peer_transfer(
                &mut model.write(),
                peer_id,
                TransferState::Failed { file, message },
            );
        }
    }
}

fn schedule_reconnect(
    target: Signal<Option<RealtimeTarget>>,
    mut reconnect_attempt: Signal<u32>,
    attempt: u32,
) {
    spawn(async move {
        let delay = 500_u32.saturating_mul(1_u32 << attempt.min(4));
        sleep_ms(delay).await;
        if target.read().is_some() {
            reconnect_attempt.set(attempt.saturating_add(1));
        }
    });
}

fn resolve_waiting(mut model: Signal<AppModel>, realtime_target: Signal<Option<RealtimeTarget>>) {
    let Screen::Waiting {
        room_code,
        request_id,
        ..
    } = &model.read().screen
    else {
        return;
    };
    let room_code = room_code.clone();
    let request_id = request_id.clone();
    spawn(async move {
        let Ok(status) = join_request_status(&room_code, &request_id).await else {
            model.write().error = Some("暂时无法确认申请状态，正在等待重连".to_owned());
            return;
        };
        match status.state {
            JoinRequestStateWire::Pending => {}
            JoinRequestStateWire::Approved => match bootstrap_room(&room_code).await {
                Ok(snapshot) => enter_receiver_room(model, realtime_target, snapshot, request_id),
                Err(error) => model.write().error = Some(friendly_error(&error)),
            },
            JoinRequestStateWire::Rejected => return_to_lobby(
                model,
                realtime_target,
                Some("发送者未允许本次加入申请".to_owned()),
            ),
            JoinRequestStateWire::Cancelled | JoinRequestStateWire::Expired => return_to_lobby(
                model,
                realtime_target,
                Some("加入申请已失效，请重新申请".to_owned()),
            ),
        }
    });
}

fn enter_receiver_room(
    mut model: Signal<AppModel>,
    mut realtime_target: Signal<Option<RealtimeTarget>>,
    snapshot: RoomBootstrapResponse,
    request_id: String,
) {
    let peer_id = new_client_id("peer");
    persist_room_session(&StoredRoomSession {
        room_code: snapshot.room_code.clone(),
        role: RoomRole::Receiver,
        join_request_id: Some(request_id),
        invite_request_id: None,
        peer_id: Some(peer_id.clone()),
    });
    let revision = snapshot.revision;
    let room_code = snapshot.room_code.clone();
    model.write().screen = Screen::Room {
        role: RoomRole::Receiver,
        snapshot,
        invite: None,
        invite_request_id: None,
    };
    model.write().error = None;
    realtime_target.set(Some(member_target(room_code, revision, peer_id)));
}

fn refresh_room_snapshot(mut model: Signal<AppModel>, rtc: RtcRuntime) {
    let Screen::Room { snapshot, .. } = &model.read().screen else {
        return;
    };
    let room_code = snapshot.room_code.clone();
    spawn(async move {
        match bootstrap_room(&room_code).await {
            Ok(snapshot) => {
                let entering = apply_snapshot(&mut model.write(), snapshot);
                schedule_avatar_cleanup(model, entering);
                sync_rtc_peers(model, rtc.connection, rtc.peers, rtc.config);
            }
            Err(error) => model.write().error = Some(friendly_error(&error)),
        }
    });
}

fn apply_snapshot(model: &mut AppModel, next: RoomBootstrapResponse) -> Vec<String> {
    let Screen::Room { role, snapshot, .. } = &mut model.screen else {
        if let Screen::Waiting { revision, .. } = &mut model.screen {
            *revision = next.revision;
        }
        return Vec::new();
    };
    let previous_online = snapshot
        .participants
        .iter()
        .filter(|participant| {
            participant.role == ParticipantRoleWire::Receiver && participant.online
        })
        .map(|participant| participant.session_id.clone())
        .collect::<Vec<_>>();
    if *snapshot == next {
        return Vec::new();
    }
    let entering = if *role == RoomRole::Owner {
        next.participants
            .iter()
            .filter(|participant| {
                participant.role == ParticipantRoleWire::Receiver
                    && participant.online
                    && !previous_online.contains(&participant.session_id)
            })
            .map(|participant| participant.session_id.clone())
            .collect()
    } else {
        Vec::new()
    };
    *snapshot = next;
    for session_id in &entering {
        if !model.entering_receivers.contains(session_id) {
            model.entering_receivers.push(session_id.clone());
        }
    }
    entering
}

fn schedule_avatar_cleanup(mut model: Signal<AppModel>, session_ids: Vec<String>) {
    for session_id in session_ids {
        spawn(async move {
            sleep_ms(AVATAR_ENTRY_HOLD_MS).await;
            model
                .write()
                .entering_receivers
                .retain(|current| current != &session_id);
        });
    }
}

fn member_target(room_code: String, last_revision: u64, peer_id: String) -> RealtimeTarget {
    RealtimeTarget::Member {
        room_code,
        peer_id,
        last_revision,
    }
}

fn restored_room_session() -> Option<StoredRoomSession> {
    load_room_session()
        .ok()
        .flatten()
        .and_then(|value| serde_json::from_str(&value).ok())
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

    fn file() -> TransferFile {
        TransferFile {
            name: "example.bin".to_owned(),
            mime: Some("application/octet-stream".to_owned()),
            size_bytes: 100,
        }
    }

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
    fn multi_receiver_summary_keeps_terminal_outcomes_independent() {
        let transfers = vec![
            TransferState::Completed {
                direction: TransferDirection::Send,
                file: file(),
                files: vec![file()],
                blake3: "a".repeat(64),
                download_url: None,
            },
            TransferState::Rejected {
                direction: TransferDirection::Send,
                file: file(),
                files: vec![file()],
            },
        ];

        assert_eq!(
            owner_transfer_panel_copy(2, 2, 2, &transfers),
            (
                "本次发送已结束".to_owned(),
                "完成 1 · 拒绝 1 · 取消 0 · 失败 0".to_owned(),
            )
        );
        assert_eq!(receiver_transfer_status(transfers.first()), "已完成");
        assert_eq!(receiver_transfer_status(transfers.get(1)), "已拒绝");
    }

    #[test]
    fn aggregate_progress_counts_each_receiver_without_overstating_completion() {
        let transfers = vec![
            TransferState::Completed {
                direction: TransferDirection::Send,
                file: file(),
                files: vec![file()],
                blake3: "b".repeat(64),
                download_url: None,
            },
            TransferState::Active {
                transfer_id: "transfer_2".to_owned(),
                direction: TransferDirection::Send,
                streamed: false,
                file: file(),
                files: vec![file()],
                completed_bytes: 50,
                awaiting_verification: false,
                link_state: TransferLinkState::Ready,
                storage_pause: None,
            },
        ];

        assert_eq!(owner_transfer_progress(&transfers), (150, 200, 75.0));
        assert!(completed_transfer_hash(&transfers).is_none());
    }

    #[test]
    fn rtc_aggregate_stays_ready_when_one_of_multiple_peers_is_ready() {
        let mut model = AppModel::default();
        model
            .rtc_by_peer
            .insert("peer_ready".to_owned(), RtcPhase::Ready);
        model
            .rtc_by_peer
            .insert("peer_connecting".to_owned(), RtcPhase::Connecting);

        refresh_aggregate_rtc(&mut model);

        assert_eq!(model.rtc, RtcPhase::Ready);
    }

    #[test]
    fn rtc_retry_backoff_is_bounded_and_increases() {
        assert_eq!(rtc_retry_delay_ms(0), Some(500));
        assert_eq!(rtc_retry_delay_ms(1), Some(1_000));
        assert_eq!(rtc_retry_delay_ms(2), Some(2_000));
        assert_eq!(rtc_retry_delay_ms(3), Some(4_000));
        assert_eq!(rtc_retry_delay_ms(4), None);
    }

    #[test]
    fn paused_stream_keeps_progress_and_exposes_recovery_copy() {
        let transfer = TransferState::Active {
            transfer_id: "transfer_paused".to_owned(),
            direction: TransferDirection::Send,
            streamed: true,
            file: file(),
            files: vec![file()],
            completed_bytes: 50,
            awaiting_verification: false,
            link_state: TransferLinkState::Paused,
            storage_pause: None,
        };

        assert_eq!(transfer_progress(&transfer), (50, 100, 50.0));
        assert_eq!(receiver_transfer_status(Some(&transfer)), "等待重连");
        assert_eq!(
            transfer_panel_copy(RoomRole::Owner, 1, RtcPhase::Failed, &transfer),
            (
                "自动重连已暂停".to_owned(),
                "暂时无法恢复连接，可以重新连接或取消传输。".to_owned(),
            )
        );
    }

    #[test]
    fn storage_pause_keeps_checkpoint_and_specific_recovery_copy() {
        let transfer = TransferState::Active {
            transfer_id: "transfer_storage_paused".to_owned(),
            direction: TransferDirection::Receive,
            streamed: true,
            file: file(),
            files: vec![file()],
            completed_bytes: 50,
            awaiting_verification: false,
            link_state: TransferLinkState::Ready,
            storage_pause: Some(StreamPauseReason::DestinationQuotaExceeded),
        };

        assert_eq!(transfer_progress(&transfer), (50, 100, 50.0));
        assert_eq!(receiver_transfer_status(Some(&transfer)), "接收方暂停");
        assert_eq!(
            transfer_panel_copy(RoomRole::Receiver, 1, RtcPhase::Ready, &transfer),
            (
                "存储空间不足".to_owned(),
                "已保留最后一个校验检查点，释放空间后可以继续接收。".to_owned(),
            )
        );
    }

    #[test]
    fn one_storage_paused_receiver_does_not_hide_other_terminal_results() {
        let paused = TransferState::Active {
            transfer_id: "transfer_paused".to_owned(),
            direction: TransferDirection::Send,
            streamed: true,
            file: file(),
            files: vec![file()],
            completed_bytes: 40,
            awaiting_verification: false,
            link_state: TransferLinkState::Ready,
            storage_pause: Some(StreamPauseReason::DestinationPermissionDenied),
        };
        let completed = TransferState::Completed {
            direction: TransferDirection::Send,
            file: file(),
            files: vec![file()],
            blake3: "c".repeat(64),
            download_url: None,
        };

        assert_eq!(
            owner_transfer_panel_copy(2, 2, 2, &[paused, completed]),
            (
                "接收方已暂停".to_owned(),
                "部分接收方需要处理保存位置，其他接收方不受影响。".to_owned(),
            )
        );
    }

    #[test]
    fn stored_room_session_keeps_peer_identity_and_accepts_pre_recovery_records() {
        let legacy = serde_json::from_str::<StoredRoomSession>(
            r#"{"room_code":"ABC234","role":"receiver","join_request_id":"join_1","invite_request_id":null}"#,
        )
        .expect("legacy room session should remain readable");
        assert_eq!(legacy.peer_id, None);

        let current = StoredRoomSession {
            room_code: "ABC234".to_owned(),
            role: RoomRole::Receiver,
            join_request_id: Some("join_1".to_owned()),
            invite_request_id: None,
            peer_id: Some("peer_stable".to_owned()),
        };
        let encoded = serde_json::to_string(&current).expect("room session should serialize");
        let restored = serde_json::from_str::<StoredRoomSession>(&encoded)
            .expect("room session should restore");
        assert_eq!(restored.peer_id.as_deref(), Some("peer_stable"));
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

    #[test]
    fn browser_lifecycle_recovery_distinguishes_short_hides_network_changes_and_sleep() {
        assert_eq!(
            lifecycle_recovery_action(
                BrowserLifecycleEvent::Visible { hidden_ms: 2_000 },
                LifecycleState {
                    hidden: true,
                    network_recovery_pending: false,
                    ..LifecycleState::default()
                },
            ),
            LifecycleRecoveryAction::None
        );
        assert_eq!(
            lifecycle_recovery_action(
                BrowserLifecycleEvent::Visible {
                    hidden_ms: BACKGROUND_CONTROL_RECOVERY_MS,
                },
                LifecycleState {
                    hidden: true,
                    network_recovery_pending: false,
                    ..LifecycleState::default()
                },
            ),
            LifecycleRecoveryAction::ControlPlane
        );
        assert_eq!(
            lifecycle_recovery_action(
                BrowserLifecycleEvent::Visible { hidden_ms: 1_000 },
                LifecycleState {
                    hidden: true,
                    network_recovery_pending: true,
                    ..LifecycleState::default()
                },
            ),
            LifecycleRecoveryAction::RebuildResumablePeers
        );
        assert_eq!(
            lifecycle_recovery_action(
                BrowserLifecycleEvent::Online,
                LifecycleState {
                    hidden: true,
                    network_recovery_pending: true,
                    ..LifecycleState::default()
                },
            ),
            LifecycleRecoveryAction::RebuildResumablePeers
        );
        assert_eq!(
            lifecycle_recovery_action(
                BrowserLifecycleEvent::Online,
                LifecycleState {
                    hidden: false,
                    network_recovery_pending: true,
                    ..LifecycleState::default()
                },
            ),
            LifecycleRecoveryAction::RebuildResumablePeers
        );
        assert_eq!(
            lifecycle_recovery_action(
                BrowserLifecycleEvent::Resumed {
                    gap_ms: SLEEP_RESUME_GAP_MS,
                },
                LifecycleState::default(),
            ),
            LifecycleRecoveryAction::RebuildResumablePeers
        );
    }
}
