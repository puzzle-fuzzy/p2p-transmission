use dioxus::prelude::*;
use p2p_browser_platform::{
    RealtimeEvent, bootstrap_room, clear_room_session, join_request_status, sleep_ms,
};
use p2p_protocol::{
    CURRENT_PROTOCOL, JoinRequestStateWire, RoomBootstrapResponse, ServerRealtimeMessage,
};

use crate::app_runtime::dispatch_app_event;
use crate::app_state::{
    AppModel, RealtimePhase, RoomRole, Screen, StoredRoomSession, TextTransferState, TransferState,
};
use crate::app_transition::{AppEvent, reduce_app_event};
use crate::browser_errors::platform_error_event;
use crate::browser_lifecycle::complete_lifecycle_recovery;
use crate::realtime_connection::{
    RealtimeLease, defer_realtime_socket_clear, mark_realtime_connected, realtime_lease_is_current,
    realtime_suppression_is_current, schedule_reconnect, suppress_realtime_lease,
};
use crate::realtime_event_reducer::{
    AttachmentDecision, RealtimeEffect, RevisionStep, RevisionedModelEvent, reduce_attachment,
    reduce_authoritative_snapshot, reduce_revisioned_model_event, reduce_room_expired,
    reduce_server_error, reduce_signal, reduce_socket_closed, reduce_socket_error,
    reduce_socket_opened, revision_step, screen_revision, snapshot_revision_allowed,
    waiting_request_missing,
};
use crate::realtime_runtime::{LifecycleState, RealtimeSessionRuntime, RtcRuntime};
use crate::realtime_target::{RealtimeTarget, RealtimeTargetKind, member_target};
use crate::room_session::persist_room_session;
use crate::rtc_session::{accept_rtc_signal, remove_rtc_peer, reset_all_rtc_peers, sync_rtc_peers};
use crate::rtc_transition::{deactivate_rtc_config, refresh_aggregate_rtc};

const AVATAR_ENTRY_HOLD_MS: u32 = 700;

fn begin_revisioned_event(
    model: &AppModel,
    target: Signal<Option<RealtimeTarget>>,
    revision: u64,
) -> Option<RevisionStep> {
    let current = screen_revision(model)?;
    let step = revision_step(current, revision);
    if let Some(target) = target.peek().as_ref() {
        target.reconcile_applied_revision(current);
        match step {
            RevisionStep::Ignore | RevisionStep::Apply => target.observe_revision(revision),
            RevisionStep::RefreshSnapshot => target.mark_snapshot_pending(revision),
        }
    }
    Some(step)
}

fn mark_target_event_revision_applied(target: Signal<Option<RealtimeTarget>>, revision: u64) {
    if let Some(target) = target.peek().as_ref() {
        target.reconcile_applied_revision(revision);
    }
}

fn mark_target_snapshot_revision_applied(target: Signal<Option<RealtimeTarget>>, revision: u64) {
    if let Some(target) = target.peek().as_ref() {
        target.mark_revision_applied(revision);
    }
}

fn target_snapshot_floor(target: Signal<Option<RealtimeTarget>>) -> Option<u64> {
    target.peek().as_ref().map(RealtimeTarget::last_revision)
}

#[derive(Clone, Copy)]
enum PendingAttachment {
    Member,
    JoinWatch,
}

fn pending_attachment(target: Signal<Option<RealtimeTarget>>) -> Option<PendingAttachment> {
    let target = target.peek();
    let target = target.as_ref()?;
    if !target.awaiting_snapshot() {
        return None;
    }
    match target.kind() {
        RealtimeTargetKind::Member => Some(PendingAttachment::Member),
        RealtimeTargetKind::JoinWatch => Some(PendingAttachment::JoinWatch),
    }
}

pub(super) fn return_to_lobby(
    mut model: Signal<AppModel>,
    mut realtime_target: Signal<Option<RealtimeTarget>>,
    notice: Option<String>,
) {
    realtime_target.set(None);
    let _ = clear_room_session();
    let mut state = model.write();
    reduce_app_event(
        &mut state,
        AppEvent::Navigate(Screen::Lobby {
            room_code: String::new(),
            invite_capability: None,
        }),
    );
    reduce_app_event(
        &mut state,
        AppEvent::SetRealtime(RealtimePhase::Disconnected),
    );
    deactivate_rtc_config(&mut state);
    state.transfer = TransferState::Idle;
    state.text_transfer = TextTransferState::Idle;
    state.pending_signals.clear();
    state.rtc_peer_states.clear();
    state.rtc_error = None;
    state.transfers_by_peer.clear();
    state.text_transfers_by_peer.clear();
    reduce_app_event(&mut state, AppEvent::SetDecisionRequest(None));
    reduce_app_event(&mut state, AppEvent::SetBusy(false));
    state.lobby_action_error = None;
    reduce_app_event(&mut state, AppEvent::SetError(None));
    reduce_app_event(&mut state, AppEvent::SetNotice(notice));
    state.entering_receivers.clear();
    refresh_aggregate_rtc(&mut state);
}

fn complete_attachment(
    mut model: Signal<AppModel>,
    rtc: RtcRuntime,
    lifecycle_state: Signal<LifecycleState>,
    lease: &RealtimeLease,
    member: bool,
) {
    let target_scope = lease.target_scope();
    let lifecycle_recovered =
        complete_lifecycle_recovery(model, rtc, lifecycle_state, &target_scope, member);
    let mut state = model.write();
    reduce_app_event(&mut state, AppEvent::SetRealtime(RealtimePhase::Connected));
    if lifecycle_recovered {
        reduce_app_event(
            &mut state,
            AppEvent::SetNotice(Some("连接已恢复".to_owned())),
        );
    }
    drop(state);
    if member {
        sync_rtc_peers(model, rtc.connection, rtc.peers, rtc.config, &target_scope);
    }
}

pub(super) fn apply_authoritative_snapshot(
    runtime: RealtimeSessionRuntime,
    lease: &RealtimeLease,
    snapshot: RoomBootstrapResponse,
) -> Option<Vec<String>> {
    let RealtimeSessionRuntime {
        mut model,
        target: realtime_target,
        connection,
        rtc,
        lifecycle_state,
    } = runtime;
    if !realtime_lease_is_current(lease, connection, realtime_target) {
        return None;
    }
    let revision = snapshot.revision;
    let local_revision = screen_revision(&model.read()).unwrap_or(0);
    let target_floor = target_snapshot_floor(realtime_target).unwrap_or(0);
    if !snapshot_revision_allowed(local_revision, target_floor, revision) {
        return None;
    }
    let attachment_waiting = pending_attachment(realtime_target);
    let entering = apply_snapshot(&mut model.write(), snapshot)?;
    mark_target_snapshot_revision_applied(realtime_target, revision);
    match attachment_waiting {
        Some(PendingAttachment::Member) if mark_realtime_connected(connection, lease) => {
            complete_attachment(model, rtc, lifecycle_state, lease, true);
        }
        Some(PendingAttachment::JoinWatch) if mark_realtime_connected(connection, lease) => {
            complete_attachment(model, rtc, lifecycle_state, lease, false);
        }
        _ => {
            let target_scope = lease.target_scope();
            sync_rtc_peers(model, rtc.connection, rtc.peers, rtc.config, &target_scope);
        }
    }
    Some(entering)
}

fn should_apply_revisioned_event(
    runtime: RealtimeSessionRuntime,
    lease: &RealtimeLease,
    revision: u64,
) -> bool {
    let model = runtime.model;
    let realtime_target = runtime.target;
    match begin_revisioned_event(&model.read(), realtime_target, revision) {
        Some(RevisionStep::Apply) => true,
        Some(RevisionStep::RefreshSnapshot) => {
            refresh_room_snapshot(runtime, lease.clone());
            false
        }
        Some(RevisionStep::Ignore) | None => false,
    }
}

pub(super) fn handle_realtime_event(
    runtime: RealtimeSessionRuntime,
    lease: RealtimeLease,
    event: RealtimeEvent,
) {
    if !realtime_lease_is_current(&lease, runtime.connection, runtime.target) {
        return;
    }

    match event {
        RealtimeEvent::Open => {
            apply_realtime_effects(runtime, &lease, reduce_socket_opened());
        }
        RealtimeEvent::Message(message) => handle_server_message(runtime, &lease, message),
        RealtimeEvent::UpgradeRequired => {
            dispatch_app_event(runtime.model, AppEvent::UpgradeRequired);
        }
        RealtimeEvent::Error(error) => {
            apply_realtime_effects(runtime, &lease, reduce_socket_error(error));
        }
        RealtimeEvent::Closed { code, .. } => {
            let has_target = runtime.target.peek().is_some();
            apply_realtime_effects(runtime, &lease, reduce_socket_closed(code, has_target));
        }
    }
}

fn handle_server_message(
    runtime: RealtimeSessionRuntime,
    lease: &RealtimeLease,
    message: ServerRealtimeMessage,
) {
    match message {
        ServerRealtimeMessage::Attached { revision, .. } => {
            handle_attachment(runtime, lease, revision, true);
        }
        ServerRealtimeMessage::JoinWatching { revision, .. } => {
            handle_attachment(runtime, lease, revision, false);
        }
        ServerRealtimeMessage::RoomSnapshot {
            room_id,
            room_code,
            revision,
            expires_at_ms,
            participants,
            pending_join_requests,
            ..
        } => handle_room_snapshot(
            runtime,
            lease,
            RoomBootstrapResponse {
                version: CURRENT_PROTOCOL,
                room_id,
                room_code,
                revision,
                expires_at_ms,
                participants,
                pending_join_requests,
            },
        ),
        ServerRealtimeMessage::JoinRequested {
            revision, request, ..
        } => handle_revisioned_model_event(
            runtime,
            lease,
            revision,
            RevisionedModelEvent::JoinRequested(request),
        ),
        ServerRealtimeMessage::JoinDecided {
            revision,
            request_id,
            decision,
            ..
        } => handle_revisioned_model_event(
            runtime,
            lease,
            revision,
            RevisionedModelEvent::JoinDecided {
                request_id,
                decision,
            },
        ),
        ServerRealtimeMessage::PeerOnline {
            revision,
            session_id,
            peer_id,
            ..
        } => handle_revisioned_model_event(
            runtime,
            lease,
            revision,
            RevisionedModelEvent::PeerOnline {
                session_id,
                peer_id,
            },
        ),
        ServerRealtimeMessage::PeerOffline {
            revision,
            session_id,
            ..
        } => handle_revisioned_model_event(
            runtime,
            lease,
            revision,
            RevisionedModelEvent::PeerOffline { session_id },
        ),
        ServerRealtimeMessage::RoomExpired { revision, .. } => {
            let effects = {
                let model = runtime.model.read();
                reduce_room_expired(&model, revision)
            };
            apply_realtime_effects(runtime, lease, effects);
        }
        ServerRealtimeMessage::Error { code, message, .. } => {
            apply_realtime_effects(runtime, lease, reduce_server_error(&code, message));
        }
        ServerRealtimeMessage::Signal {
            from_peer_id,
            negotiation_id,
            signal,
            ..
        } => apply_realtime_effects(
            runtime,
            lease,
            reduce_signal(from_peer_id, negotiation_id, signal),
        ),
    }
}

fn handle_attachment(
    runtime: RealtimeSessionRuntime,
    lease: &RealtimeLease,
    revision: u64,
    member: bool,
) {
    let decision = {
        let model = runtime.model.read();
        reduce_attachment(&model, revision, member)
    };
    match decision {
        AttachmentDecision::Ignore => {}
        AttachmentDecision::Ready {
            local_revision,
            incoming_revision,
            member,
        } => {
            if let Some(target) = runtime.target.peek().as_ref() {
                target.reconcile_applied_revision(local_revision);
                target.mark_revision_applied(incoming_revision);
            }
            if mark_realtime_connected(runtime.connection, lease) {
                complete_attachment(
                    runtime.model,
                    runtime.rtc,
                    runtime.lifecycle_state,
                    lease,
                    member,
                );
            }
        }
        AttachmentDecision::AwaitSnapshot {
            local_revision,
            incoming_revision,
        } => {
            if let Some(target) = runtime.target.peek().as_ref() {
                target.reconcile_applied_revision(local_revision);
                target.mark_snapshot_pending(incoming_revision);
            }
        }
    }
}

fn handle_room_snapshot(
    runtime: RealtimeSessionRuntime,
    lease: &RealtimeLease,
    snapshot: RoomBootstrapResponse,
) {
    let waiting_missing = {
        let model = runtime.model.read();
        waiting_request_missing(&model, &snapshot)
    };
    let Some(entering) = apply_authoritative_snapshot(runtime, lease, snapshot) else {
        return;
    };
    schedule_avatar_cleanup(runtime.model, entering);
    if waiting_missing {
        resolve_waiting(runtime, lease.clone());
    }
}

fn handle_revisioned_model_event(
    mut runtime: RealtimeSessionRuntime,
    lease: &RealtimeLease,
    revision: u64,
    event: RevisionedModelEvent,
) {
    if !should_apply_revisioned_event(runtime, lease, revision) {
        return;
    }
    let effects = {
        let mut model = runtime.model.write();
        reduce_revisioned_model_event(&mut model, revision, event)
    };
    apply_realtime_effects(runtime, lease, effects);
}

fn apply_realtime_effects(
    runtime: RealtimeSessionRuntime,
    lease: &RealtimeLease,
    effects: Vec<RealtimeEffect>,
) {
    for effect in effects {
        match effect {
            RealtimeEffect::SetRealtimePhase(phase) => {
                dispatch_app_event(runtime.model, AppEvent::SetRealtime(phase));
            }
            RealtimeEffect::SetError(error) => {
                dispatch_app_event(runtime.model, AppEvent::SetError(Some(error)));
            }
            RealtimeEffect::MarkTargetRevisionApplied(revision) => {
                mark_target_event_revision_applied(runtime.target, revision);
            }
            RealtimeEffect::ResolveWaiting => resolve_waiting(runtime, lease.clone()),
            RealtimeEffect::ReturnToLobby(notice) => {
                return_to_lobby(runtime.model, runtime.target, Some(notice.to_owned()));
                return;
            }
            RealtimeEffect::SyncRtcPeers => {
                let target_scope = lease.target_scope();
                sync_rtc_peers(
                    runtime.model,
                    runtime.rtc.connection,
                    runtime.rtc.peers,
                    runtime.rtc.config,
                    &target_scope,
                );
            }
            RealtimeEffect::RefreshRoomSnapshot => {
                refresh_room_snapshot(runtime, lease.clone());
            }
            RealtimeEffect::RemoveRtcPeer(peer_id) => {
                let preserve_peer = runtime.rtc.peers.read().get(&peer_id).is_some_and(|peer| {
                    peer.data_channel_ready() || peer.resumable_transfer_active()
                });
                if !preserve_peer {
                    remove_rtc_peer(runtime.model, runtime.rtc.peers, &peer_id);
                }
            }
            RealtimeEffect::SuppressRealtimeConnection => {
                suppress_realtime_connection(runtime, lease.clone());
                return;
            }
            RealtimeEffect::ReconnectSocket => {
                dispatch_app_event(
                    runtime.model,
                    AppEvent::SetRealtime(RealtimePhase::Reconnecting),
                );
                defer_realtime_socket_clear(
                    runtime.connection,
                    runtime.target,
                    runtime.rtc.connection,
                    lease.clone(),
                );
                schedule_reconnect(
                    runtime.connection,
                    runtime.target,
                    runtime.model,
                    lease.clone(),
                );
            }
            RealtimeEffect::AcceptRtcSignal {
                from_peer_id,
                negotiation_id,
                signal,
            } => {
                let target_scope = lease.target_scope();
                accept_rtc_signal(runtime, &target_scope, from_peer_id, negotiation_id, signal);
            }
        }
    }
}

fn suppress_realtime_connection(mut runtime: RealtimeSessionRuntime, lease: RealtimeLease) {
    if !suppress_realtime_lease(runtime.connection, &lease) {
        return;
    }
    reset_all_rtc_peers(runtime.model, runtime.rtc.peers);
    runtime.rtc.config.set(None);
    {
        let mut model = runtime.model.write();
        reduce_app_event(&mut model, AppEvent::SetRealtime(RealtimePhase::Superseded));
        deactivate_rtc_config(&mut model);
        model.pending_signals.clear();
        reduce_app_event(
            &mut model,
            AppEvent::SetNotice(Some(
                "此房间已在另一个标签页中打开，本页面已停止重连".to_owned(),
            )),
        );
        reduce_app_event(&mut model, AppEvent::SetError(None));
    }

    // Dropping the connection synchronously from its own callback would also drop
    // the Closure currently executing. Defer disposal until the callback unwinds.
    spawn(async move {
        sleep_ms(0).await;
        if realtime_suppression_is_current(runtime.connection, &lease) {
            runtime.rtc.connection.set(None);
        }
    });
}

fn resolve_waiting(runtime: RealtimeSessionRuntime, lease: RealtimeLease) {
    let model = runtime.model;
    let realtime_target = runtime.target;
    let Screen::Waiting {
        room_code,
        request_id,
        peer_id,
        ..
    } = &model.read().screen
    else {
        return;
    };
    let room_code = room_code.clone();
    let request_id = request_id.clone();
    let peer_id = peer_id.clone();
    spawn(async move {
        let status = join_request_status(&room_code, &request_id).await;
        if !realtime_lease_is_current(&lease, runtime.connection, realtime_target) {
            return;
        }
        let status = match status {
            Ok(status) => status,
            Err(error) => {
                if error.requires_upgrade() {
                    dispatch_app_event(model, platform_error_event(&error));
                } else {
                    dispatch_app_event(
                        model,
                        AppEvent::SetError(Some("暂时无法确认申请状态，正在等待重连".to_owned())),
                    );
                }
                return;
            }
        };
        match status.state {
            JoinRequestStateWire::Pending => {}
            JoinRequestStateWire::Approved => {
                let snapshot = bootstrap_room(&room_code).await;
                if !realtime_lease_is_current(&lease, runtime.connection, realtime_target) {
                    return;
                }
                match snapshot {
                    Ok(snapshot) => {
                        enter_receiver_room(model, realtime_target, snapshot, request_id, peer_id)
                    }
                    Err(error) => {
                        dispatch_app_event(model, platform_error_event(&error));
                    }
                }
            }
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

pub(super) fn enter_receiver_room(
    mut model: Signal<AppModel>,
    mut realtime_target: Signal<Option<RealtimeTarget>>,
    snapshot: RoomBootstrapResponse,
    request_id: String,
    peer_id: String,
) {
    persist_room_session(&StoredRoomSession {
        room_code: snapshot.room_code.clone(),
        role: RoomRole::Receiver,
        join_request_id: Some(request_id),
        invite_request_id: None,
        peer_id: peer_id.clone(),
    });
    let revision = snapshot.revision;
    let room_code = snapshot.room_code.clone();
    reduce_app_event(
        &mut model.write(),
        AppEvent::Navigate(Screen::Room {
            role: RoomRole::Receiver,
            snapshot,
            invite: None,
            invite_request_id: None,
        }),
    );
    dispatch_app_event(model, AppEvent::SetError(None));
    realtime_target.set(Some(member_target(room_code, revision, peer_id)));
}

fn refresh_room_snapshot(runtime: RealtimeSessionRuntime, lease: RealtimeLease) {
    let model = runtime.model;
    let realtime_target = runtime.target;
    let room_code = match &model.read().screen {
        Screen::Waiting { room_code, .. } => room_code.clone(),
        Screen::Room { snapshot, .. } => snapshot.room_code.clone(),
        Screen::Booting | Screen::Lobby { .. } => return,
    };
    spawn(async move {
        let result = bootstrap_room(&room_code).await;
        if !realtime_lease_is_current(&lease, runtime.connection, realtime_target) {
            return;
        }
        match result {
            Ok(snapshot) => {
                let waiting_missing = {
                    let state = model.read();
                    waiting_request_missing(&state, &snapshot)
                };
                let Some(entering) = apply_authoritative_snapshot(runtime, &lease, snapshot) else {
                    return;
                };
                schedule_avatar_cleanup(model, entering);
                if waiting_missing {
                    resolve_waiting(runtime, lease.clone());
                }
            }
            Err(error) => {
                dispatch_app_event(model, platform_error_event(&error));
            }
        }
    });
}

pub(super) fn apply_snapshot(
    model: &mut AppModel,
    next: RoomBootstrapResponse,
) -> Option<Vec<String>> {
    reduce_authoritative_snapshot(model, next)
}

pub(super) fn schedule_avatar_cleanup(mut model: Signal<AppModel>, session_ids: Vec<String>) {
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
