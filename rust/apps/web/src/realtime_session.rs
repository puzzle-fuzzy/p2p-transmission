use std::{cell::Cell, rc::Rc};

use dioxus::prelude::*;
use p2p_browser_platform::{
    RealtimeEvent, bootstrap_room, clear_room_session, join_request_status, sleep_ms,
};
use p2p_protocol::{
    CURRENT_PROTOCOL, ClientRealtimeMessage, JoinDecisionWire, JoinRequestStateWire,
    ParticipantRoleWire, RoomBootstrapResponse, ServerRealtimeMessage,
};

use crate::realtime_connection::{
    RealtimeConnectionRuntime, RealtimeLease, defer_realtime_socket_clear, mark_realtime_connected,
    realtime_lease_is_current, schedule_reconnect, suppress_realtime_connection,
};
use crate::rtc_session::{accept_rtc_signal, remove_rtc_peer, sync_rtc_peers};

use super::{
    AppModel, LifecycleState, RealtimePhase, RoomRole, RtcPhase, RtcRuntime, Screen,
    StoredRoomSession, TransferState, complete_lifecycle_recovery, friendly_error,
    persist_room_session,
};

const AVATAR_ENTRY_HOLD_MS: u32 = 700;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct RevisionCursor {
    last_revision: u64,
    applied_revision: u64,
    awaiting_snapshot: bool,
}

impl RevisionCursor {
    pub(super) fn new(revision: u64) -> Self {
        Self {
            last_revision: revision,
            applied_revision: revision,
            awaiting_snapshot: false,
        }
    }

    fn observe(&mut self, revision: u64) {
        self.last_revision = self.last_revision.max(revision);
    }

    fn mark_applied(&mut self, revision: u64) {
        self.observe(revision);
        self.applied_revision = self.applied_revision.max(revision);
        self.awaiting_snapshot = false;
    }

    fn reconcile_applied(&mut self, revision: u64) {
        self.observe(revision);
        self.applied_revision = self.applied_revision.max(revision);
    }

    fn mark_snapshot_pending(&mut self, revision: u64) {
        self.observe(revision);
        self.awaiting_snapshot = true;
    }
}

#[derive(Clone, Debug)]
pub(super) enum RealtimeTarget {
    Member {
        room_code: String,
        peer_id: String,
        revision: Rc<Cell<RevisionCursor>>,
    },
    JoinWatch {
        room_code: String,
        request_id: String,
        revision: Rc<Cell<RevisionCursor>>,
    },
}

impl RealtimeTarget {
    pub(super) fn initial_message(&self) -> ClientRealtimeMessage {
        match self {
            Self::Member {
                room_code,
                peer_id,
                revision,
            } => ClientRealtimeMessage::AttachRoom {
                version: CURRENT_PROTOCOL,
                room_code: room_code.clone(),
                peer_id: peer_id.clone(),
                last_revision: Some(revision.get().applied_revision),
            },
            Self::JoinWatch {
                room_code,
                request_id,
                revision,
            } => ClientRealtimeMessage::WatchJoinRequest {
                version: CURRENT_PROTOCOL,
                room_code: room_code.clone(),
                request_id: request_id.clone(),
                last_revision: Some(revision.get().applied_revision),
            },
        }
    }

    fn revision(&self) -> RevisionCursor {
        match self {
            Self::Member { revision, .. } | Self::JoinWatch { revision, .. } => revision.get(),
        }
    }

    fn update_revision(&self, update: impl FnOnce(&mut RevisionCursor)) {
        let mut cursor = self.revision();
        update(&mut cursor);
        match self {
            Self::Member { revision, .. } | Self::JoinWatch { revision, .. } => {
                revision.set(cursor)
            }
        }
    }

    pub(super) fn is_same_instance(&self, other: &Self) -> bool {
        match (self, other) {
            (
                Self::Member { revision, .. },
                Self::Member {
                    revision: other, ..
                },
            )
            | (
                Self::JoinWatch { revision, .. },
                Self::JoinWatch {
                    revision: other, ..
                },
            ) => Rc::ptr_eq(revision, other),
            _ => false,
        }
    }
}

#[derive(Clone, Copy)]
pub(super) struct RealtimeSessionRuntime {
    pub(super) model: Signal<AppModel>,
    pub(super) target: Signal<Option<RealtimeTarget>>,
    pub(super) connection: RealtimeConnectionRuntime,
    pub(super) rtc: RtcRuntime,
    pub(super) lifecycle_state: Signal<LifecycleState>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RevisionStep {
    Ignore,
    Apply,
    RefreshSnapshot,
}

fn revision_step(current: u64, incoming: u64) -> RevisionStep {
    if incoming <= current {
        RevisionStep::Ignore
    } else if current.checked_add(1) == Some(incoming) {
        RevisionStep::Apply
    } else {
        RevisionStep::RefreshSnapshot
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AttachedStep {
    Ready,
    AwaitSnapshot,
}

fn attached_step(local_revision: u64, attached_revision: u64) -> AttachedStep {
    if local_revision == attached_revision {
        AttachedStep::Ready
    } else {
        AttachedStep::AwaitSnapshot
    }
}

fn snapshot_revision_allowed(
    local_revision: u64,
    observed_revision: u64,
    incoming_revision: u64,
) -> bool {
    incoming_revision >= local_revision && incoming_revision >= observed_revision
}

fn room_expired_should_apply(current_revision: u64, incoming_revision: u64) -> bool {
    // Expiration is authoritative and terminal, so a revision gap must not keep a dead room open.
    incoming_revision >= current_revision
}

fn screen_revision(model: &AppModel) -> Option<u64> {
    match &model.screen {
        Screen::Waiting { revision, .. } => Some(*revision),
        Screen::Room { snapshot, .. } => Some(snapshot.revision),
        Screen::Booting | Screen::Lobby { .. } => None,
    }
}

fn update_target_revision(
    target: Signal<Option<RealtimeTarget>>,
    update: impl FnOnce(&mut RevisionCursor),
) {
    if let Some(target) = target.peek().as_ref() {
        target.update_revision(update);
    }
}

fn observe_attachment(
    model: &AppModel,
    target: Signal<Option<RealtimeTarget>>,
    revision: u64,
) -> Option<AttachedStep> {
    let local_revision = screen_revision(model)?;
    let step = attached_step(local_revision, revision);
    update_target_revision(target, |cursor| {
        cursor.reconcile_applied(local_revision);
        match step {
            AttachedStep::Ready => cursor.mark_applied(revision),
            AttachedStep::AwaitSnapshot => cursor.mark_snapshot_pending(revision),
        }
    });
    Some(step)
}

fn begin_revisioned_event(
    model: &AppModel,
    target: Signal<Option<RealtimeTarget>>,
    revision: u64,
) -> Option<RevisionStep> {
    let current = screen_revision(model)?;
    let step = revision_step(current, revision);
    update_target_revision(target, |cursor| {
        cursor.reconcile_applied(current);
        match step {
            RevisionStep::Ignore => cursor.observe(revision),
            RevisionStep::Apply => cursor.observe(revision),
            RevisionStep::RefreshSnapshot => cursor.mark_snapshot_pending(revision),
        }
    });
    Some(step)
}

fn mark_target_event_revision_applied(target: Signal<Option<RealtimeTarget>>, revision: u64) {
    update_target_revision(target, |cursor| cursor.reconcile_applied(revision));
}

fn mark_target_snapshot_revision_applied(target: Signal<Option<RealtimeTarget>>, revision: u64) {
    update_target_revision(target, |cursor| cursor.mark_applied(revision));
}

fn target_snapshot_floor(target: Signal<Option<RealtimeTarget>>) -> Option<u64> {
    target
        .peek()
        .as_ref()
        .map(|target| target.revision().last_revision)
}

#[derive(Clone, Copy)]
enum PendingAttachment {
    Member,
    JoinWatch,
}

fn pending_attachment(target: Signal<Option<RealtimeTarget>>) -> Option<PendingAttachment> {
    match target.peek().as_ref() {
        Some(RealtimeTarget::Member { revision, .. }) if revision.get().awaiting_snapshot => {
            Some(PendingAttachment::Member)
        }
        Some(RealtimeTarget::JoinWatch { revision, .. }) if revision.get().awaiting_snapshot => {
            Some(PendingAttachment::JoinWatch)
        }
        _ => None,
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
    state.decision_request_id = None;
    state.busy = false;
    state.error = None;
    state.notice = notice;
    state.entering_receivers.clear();
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
    state.realtime = RealtimePhase::Connected;
    if lifecycle_recovered {
        state.notice = Some("连接已恢复".to_owned());
    }
    drop(state);
    if member {
        sync_rtc_peers(model, rtc.connection, rtc.peers, rtc.config);
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
        _ => sync_rtc_peers(model, rtc.connection, rtc.peers, rtc.config),
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
    let RealtimeSessionRuntime {
        mut model,
        target: realtime_target,
        connection,
        rtc,
        lifecycle_state,
    } = runtime;
    if !realtime_lease_is_current(&lease, connection, realtime_target) {
        return;
    }

    match event {
        RealtimeEvent::Open => model.write().realtime = RealtimePhase::Connecting,
        RealtimeEvent::Message(message) => match message {
            ServerRealtimeMessage::Attached { revision, .. } => {
                if observe_attachment(&model.read(), realtime_target, revision)
                    == Some(AttachedStep::Ready)
                    && mark_realtime_connected(connection, &lease)
                {
                    complete_attachment(model, rtc, lifecycle_state, &lease, true);
                }
            }
            ServerRealtimeMessage::JoinWatching { revision, .. } => {
                if observe_attachment(&model.read(), realtime_target, revision)
                    == Some(AttachedStep::Ready)
                    && mark_realtime_connected(connection, &lease)
                {
                    complete_attachment(model, rtc, lifecycle_state, &lease, false);
                }
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
                let Some(entering) = apply_authoritative_snapshot(runtime, &lease, snapshot) else {
                    return;
                };
                schedule_avatar_cleanup(model, entering);
                if waiting_missing {
                    resolve_waiting(runtime, lease.clone());
                }
            }
            ServerRealtimeMessage::JoinRequested {
                revision, request, ..
            } => {
                if should_apply_revisioned_event(runtime, &lease, revision) {
                    let applied = if let Screen::Room {
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
                        true
                    } else {
                        false
                    };
                    if applied {
                        mark_target_event_revision_applied(realtime_target, revision);
                    }
                }
            }
            ServerRealtimeMessage::JoinDecided {
                revision,
                request_id,
                decision,
                ..
            } => {
                if should_apply_revisioned_event(runtime, &lease, revision) {
                    if model.read().decision_request_id.as_deref() == Some(&request_id) {
                        model.write().decision_request_id = None;
                    }
                    let waiting = matches!(
                        &model.read().screen,
                        Screen::Waiting { request_id: current, .. } if current == &request_id
                    );
                    if waiting {
                        if let Screen::Waiting {
                            revision: current, ..
                        } = &mut model.write().screen
                        {
                            *current = revision;
                        }
                        mark_target_event_revision_applied(realtime_target, revision);
                        match decision {
                            JoinDecisionWire::Approved => resolve_waiting(runtime, lease.clone()),
                            JoinDecisionWire::Rejected => return_to_lobby(
                                model,
                                realtime_target,
                                Some("发送者未允许本次加入申请".to_owned()),
                            ),
                        }
                    } else {
                        let applied =
                            if let Screen::Room { snapshot, .. } = &mut model.write().screen {
                                snapshot.revision = revision;
                                snapshot
                                    .pending_join_requests
                                    .retain(|request| request.request_id != request_id);
                                true
                            } else {
                                false
                            };
                        if applied {
                            mark_target_event_revision_applied(realtime_target, revision);
                        }
                    }
                }
            }
            ServerRealtimeMessage::PeerOnline {
                revision,
                session_id,
                peer_id,
                ..
            } => {
                if should_apply_revisioned_event(runtime, &lease, revision) {
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
                    if should_refresh {
                        mark_target_event_revision_applied(realtime_target, revision);
                    }
                    sync_rtc_peers(model, rtc.connection, rtc.peers, rtc.config);
                    if should_refresh {
                        refresh_room_snapshot(runtime, lease.clone());
                    }
                }
            }
            ServerRealtimeMessage::PeerOffline {
                revision,
                session_id,
                ..
            } => {
                if should_apply_revisioned_event(runtime, &lease, revision) {
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
                    if should_refresh {
                        mark_target_event_revision_applied(realtime_target, revision);
                    }
                    if let Some(peer_id) = remote_peer_id {
                        let preserve_peer = rtc.peers.read().get(&peer_id).is_some_and(|peer| {
                            peer.data_channel_ready() || peer.resumable_transfer_active()
                        });
                        if !preserve_peer {
                            remove_rtc_peer(model, rtc.peers, &peer_id);
                        }
                    }
                    if should_refresh {
                        refresh_room_snapshot(runtime, lease.clone());
                    }
                }
            }
            ServerRealtimeMessage::RoomExpired { revision, .. } => {
                let current_revision = screen_revision(&model.read());
                if current_revision
                    .is_some_and(|current| room_expired_should_apply(current, revision))
                {
                    mark_target_event_revision_applied(realtime_target, revision);
                    return_to_lobby(
                        model,
                        realtime_target,
                        Some("房间已过期，请创建或加入新的房间".to_owned()),
                    );
                }
            }
            ServerRealtimeMessage::Error { code, message, .. } => {
                if code == "join_request_resolved" {
                    resolve_waiting(runtime, lease.clone());
                } else if code == "connection_replaced" {
                    suppress_realtime_connection(runtime, lease);
                } else {
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
            if code == 4001 {
                suppress_realtime_connection(runtime, lease);
            } else if realtime_target.peek().is_some() {
                model.write().realtime = RealtimePhase::Reconnecting;
                defer_realtime_socket_clear(runtime, lease.clone());
                schedule_reconnect(runtime, lease);
            }
        }
    }
}

fn resolve_waiting(runtime: RealtimeSessionRuntime, lease: RealtimeLease) {
    let mut model = runtime.model;
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
        let Ok(status) = status else {
            model.write().error = Some("暂时无法确认申请状态，正在等待重连".to_owned());
            return;
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
                    Err(error) => model.write().error = Some(friendly_error(&error)),
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
    model.write().screen = Screen::Room {
        role: RoomRole::Receiver,
        snapshot,
        invite: None,
        invite_request_id: None,
    };
    model.write().error = None;
    realtime_target.set(Some(member_target(room_code, revision, peer_id)));
}

fn refresh_room_snapshot(runtime: RealtimeSessionRuntime, lease: RealtimeLease) {
    let mut model = runtime.model;
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
                let waiting_missing = match &model.read().screen {
                    Screen::Waiting { request_id, .. } => !snapshot
                        .pending_join_requests
                        .iter()
                        .any(|request| &request.request_id == request_id),
                    _ => false,
                };
                let Some(entering) = apply_authoritative_snapshot(runtime, &lease, snapshot) else {
                    return;
                };
                schedule_avatar_cleanup(model, entering);
                if waiting_missing {
                    resolve_waiting(runtime, lease.clone());
                }
            }
            Err(error) => model.write().error = Some(friendly_error(&error)),
        }
    });
}

pub(super) fn apply_snapshot(
    model: &mut AppModel,
    next: RoomBootstrapResponse,
) -> Option<Vec<String>> {
    let Screen::Room { role, snapshot, .. } = &mut model.screen else {
        if let Screen::Waiting { revision, .. } = &mut model.screen {
            if next.revision < *revision {
                return None;
            }
            *revision = next.revision;
        }
        return Some(Vec::new());
    };
    if next.revision < snapshot.revision {
        return None;
    }
    let previous_online = snapshot
        .participants
        .iter()
        .filter(|participant| {
            participant.role == ParticipantRoleWire::Receiver && participant.online
        })
        .map(|participant| participant.session_id.clone())
        .collect::<Vec<_>>();
    if *snapshot == next {
        return Some(Vec::new());
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
    Some(entering)
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

pub(super) fn member_target(
    room_code: String,
    last_revision: u64,
    peer_id: String,
) -> RealtimeTarget {
    RealtimeTarget::Member {
        room_code,
        peer_id,
        revision: Rc::new(Cell::new(RevisionCursor::new(last_revision))),
    }
}

pub(super) fn join_watch_target(
    room_code: String,
    request_id: String,
    last_revision: u64,
) -> RealtimeTarget {
    RealtimeTarget::JoinWatch {
        room_code,
        request_id,
        revision: Rc::new(Cell::new(RevisionCursor::new(last_revision))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn revision_steps_are_monotonic_and_detect_gaps() {
        assert_eq!(revision_step(7, 6), RevisionStep::Ignore);
        assert_eq!(revision_step(7, 7), RevisionStep::Ignore);
        assert_eq!(revision_step(7, 8), RevisionStep::Apply);
        assert_eq!(revision_step(7, 9), RevisionStep::RefreshSnapshot);
        assert_eq!(revision_step(u64::MAX, u64::MAX), RevisionStep::Ignore);
    }

    #[test]
    fn revision_cursor_never_moves_backwards_and_reconnects_from_applied_state() {
        let target = member_target("ABC234".to_owned(), 5, "peer_owner".to_owned());
        target.update_revision(|cursor| cursor.mark_snapshot_pending(8));
        target.update_revision(|cursor| cursor.reconcile_applied(6));
        assert_eq!(target.revision().last_revision, 8);
        assert_eq!(target.revision().applied_revision, 6);
        assert!(target.revision().awaiting_snapshot);
        assert!(matches!(
            target.initial_message(),
            ClientRealtimeMessage::AttachRoom {
                last_revision: Some(6),
                ..
            }
        ));

        target.update_revision(|cursor| cursor.mark_applied(8));
        target.update_revision(|cursor| cursor.observe(6));
        assert_eq!(target.revision().last_revision, 8);
        assert_eq!(target.revision().applied_revision, 8);
        assert!(!target.revision().awaiting_snapshot);
    }

    #[test]
    fn attached_gate_waits_only_when_local_revision_differs() {
        assert_eq!(attached_step(7, 7), AttachedStep::Ready);
        assert_eq!(attached_step(7, 8), AttachedStep::AwaitSnapshot);
        assert_eq!(attached_step(8, 7), AttachedStep::AwaitSnapshot);
    }

    #[test]
    fn snapshot_must_not_trail_local_or_observed_revision() {
        assert!(snapshot_revision_allowed(7, 8, 8));
        assert!(!snapshot_revision_allowed(8, 8, 7));
        assert!(!snapshot_revision_allowed(7, 9, 8));
    }

    #[test]
    fn room_expiration_accepts_equal_or_newer_terminal_revision() {
        assert!(!room_expired_should_apply(7, 6));
        assert!(room_expired_should_apply(7, 7));
        assert!(room_expired_should_apply(7, 9));
    }
}
