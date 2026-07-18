use p2p_protocol::{
    JoinDecisionWire, JoinRequestSnapshot, ParticipantRoleWire, RoomBootstrapResponse,
    Signal as ProtocolSignal,
};

use crate::app_state::{AppModel, RealtimePhase, RoomRole, Screen};

pub(super) const JOIN_REJECTED_NOTICE: &str = "发送者未允许本次加入申请";
pub(super) const ROOM_EXPIRED_NOTICE: &str = "房间已过期，请创建或加入新的房间";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum RevisionStep {
    Ignore,
    Apply,
    RefreshSnapshot,
}

pub(super) fn revision_step(current: u64, incoming: u64) -> RevisionStep {
    if incoming <= current {
        RevisionStep::Ignore
    } else if current.checked_add(1) == Some(incoming) {
        RevisionStep::Apply
    } else {
        RevisionStep::RefreshSnapshot
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum AttachmentDecision {
    Ignore,
    Ready {
        local_revision: u64,
        incoming_revision: u64,
        member: bool,
    },
    AwaitSnapshot {
        local_revision: u64,
        incoming_revision: u64,
    },
}

pub(super) fn reduce_attachment(
    model: &AppModel,
    incoming_revision: u64,
    member: bool,
) -> AttachmentDecision {
    let Some(local_revision) = screen_revision(model) else {
        return AttachmentDecision::Ignore;
    };
    if local_revision == incoming_revision {
        AttachmentDecision::Ready {
            local_revision,
            incoming_revision,
            member,
        }
    } else {
        AttachmentDecision::AwaitSnapshot {
            local_revision,
            incoming_revision,
        }
    }
}

pub(super) fn snapshot_revision_allowed(
    local_revision: u64,
    observed_revision: u64,
    incoming_revision: u64,
) -> bool {
    incoming_revision >= local_revision && incoming_revision >= observed_revision
}

pub(super) fn screen_revision(model: &AppModel) -> Option<u64> {
    match &model.screen {
        Screen::Waiting { revision, .. } => Some(*revision),
        Screen::Room { snapshot, .. } => Some(snapshot.revision),
        Screen::Booting | Screen::Lobby { .. } => None,
    }
}

#[derive(Clone, Debug)]
pub(super) enum RevisionedModelEvent {
    JoinRequested(JoinRequestSnapshot),
    JoinDecided {
        request_id: String,
        decision: JoinDecisionWire,
    },
    PeerOnline {
        session_id: String,
        peer_id: String,
    },
    PeerOffline {
        session_id: String,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) enum RealtimeEffect {
    SetRealtimePhase(RealtimePhase),
    SetError(String),
    MarkTargetRevisionApplied(u64),
    ResolveWaiting,
    ReturnToLobby(&'static str),
    SyncRtcPeers,
    RefreshRoomSnapshot,
    RemoveRtcPeer(String),
    SuppressRealtimeConnection,
    ReconnectSocket,
    AcceptRtcSignal {
        from_peer_id: String,
        negotiation_id: String,
        signal: ProtocolSignal,
    },
}

/// Apply a revision-gated event to plain application state.
///
/// The caller owns revision and lease validation. The returned effects are
/// interpreted only after the mutable model borrow has ended.
pub(super) fn reduce_revisioned_model_event(
    model: &mut AppModel,
    revision: u64,
    event: RevisionedModelEvent,
) -> Vec<RealtimeEffect> {
    match event {
        RevisionedModelEvent::JoinRequested(request) => {
            let Screen::Room {
                role: RoomRole::Owner,
                snapshot,
                ..
            } = &mut model.screen
            else {
                return Vec::new();
            };
            snapshot.revision = revision;
            if !snapshot
                .pending_join_requests
                .iter()
                .any(|existing| existing.request_id == request.request_id)
            {
                snapshot.pending_join_requests.push(request);
            }
            vec![RealtimeEffect::MarkTargetRevisionApplied(revision)]
        }
        RevisionedModelEvent::JoinDecided {
            request_id,
            decision,
        } => {
            if model.decision_request_id.as_deref() == Some(request_id.as_str()) {
                model.decision_request_id = None;
            }
            match &mut model.screen {
                Screen::Waiting {
                    request_id: current,
                    revision: current_revision,
                    ..
                } if current == &request_id => {
                    *current_revision = revision;
                    let mut effects = vec![RealtimeEffect::MarkTargetRevisionApplied(revision)];
                    effects.push(match decision {
                        JoinDecisionWire::Approved => RealtimeEffect::ResolveWaiting,
                        JoinDecisionWire::Rejected => {
                            RealtimeEffect::ReturnToLobby(JOIN_REJECTED_NOTICE)
                        }
                    });
                    effects
                }
                Screen::Room { snapshot, .. } => {
                    snapshot.revision = revision;
                    snapshot
                        .pending_join_requests
                        .retain(|request| request.request_id != request_id);
                    vec![RealtimeEffect::MarkTargetRevisionApplied(revision)]
                }
                Screen::Booting | Screen::Lobby { .. } | Screen::Waiting { .. } => Vec::new(),
            }
        }
        RevisionedModelEvent::PeerOnline {
            session_id,
            peer_id,
        } => {
            let mut effects = Vec::new();
            if let Screen::Room { snapshot, .. } = &mut model.screen {
                snapshot.revision = revision;
                if let Some(participant) = snapshot
                    .participants
                    .iter_mut()
                    .find(|participant| participant.session_id == session_id)
                {
                    participant.online = true;
                    participant.peer_id = Some(peer_id);
                }
                effects.push(RealtimeEffect::MarkTargetRevisionApplied(revision));
            }
            effects.push(RealtimeEffect::SyncRtcPeers);
            if matches!(&model.screen, Screen::Room { .. }) {
                effects.push(RealtimeEffect::RefreshRoomSnapshot);
            }
            effects
        }
        RevisionedModelEvent::PeerOffline { session_id } => {
            let own_session_id = model
                .session
                .as_ref()
                .map(|session| session.session_id.as_str());
            let Screen::Room { snapshot, .. } = &mut model.screen else {
                return Vec::new();
            };
            let remote_peer_id = if own_session_id != Some(session_id.as_str()) {
                snapshot
                    .participants
                    .iter()
                    .find(|participant| participant.session_id == session_id)
                    .and_then(|participant| participant.peer_id.clone())
            } else {
                None
            };
            snapshot.revision = revision;
            if let Some(participant) = snapshot
                .participants
                .iter_mut()
                .find(|participant| participant.session_id == session_id)
            {
                participant.online = false;
                participant.peer_id = None;
            }
            let mut effects = vec![RealtimeEffect::MarkTargetRevisionApplied(revision)];
            if let Some(peer_id) = remote_peer_id {
                effects.push(RealtimeEffect::RemoveRtcPeer(peer_id));
            }
            effects.push(RealtimeEffect::RefreshRoomSnapshot);
            effects
        }
    }
}

pub(super) fn reduce_room_expired(model: &AppModel, revision: u64) -> Vec<RealtimeEffect> {
    if screen_revision(model).is_some_and(|current| revision >= current) {
        vec![
            RealtimeEffect::MarkTargetRevisionApplied(revision),
            RealtimeEffect::ReturnToLobby(ROOM_EXPIRED_NOTICE),
        ]
    } else {
        Vec::new()
    }
}

pub(super) fn reduce_server_error(code: &str, message: String) -> Vec<RealtimeEffect> {
    match code {
        "join_request_resolved" => vec![RealtimeEffect::ResolveWaiting],
        "connection_replaced" => vec![RealtimeEffect::SuppressRealtimeConnection],
        _ => vec![RealtimeEffect::SetError(message)],
    }
}

pub(super) fn reduce_signal(
    from_peer_id: String,
    negotiation_id: String,
    signal: ProtocolSignal,
) -> Vec<RealtimeEffect> {
    vec![RealtimeEffect::AcceptRtcSignal {
        from_peer_id,
        negotiation_id,
        signal,
    }]
}

pub(super) fn reduce_socket_opened() -> Vec<RealtimeEffect> {
    vec![RealtimeEffect::SetRealtimePhase(RealtimePhase::Connecting)]
}

pub(super) fn reduce_socket_error(error: String) -> Vec<RealtimeEffect> {
    vec![
        RealtimeEffect::SetRealtimePhase(RealtimePhase::Reconnecting),
        RealtimeEffect::SetError(error),
    ]
}

pub(super) fn reduce_socket_closed(code: u16, has_target: bool) -> Vec<RealtimeEffect> {
    if code == 4001 {
        vec![RealtimeEffect::SuppressRealtimeConnection]
    } else if has_target {
        vec![RealtimeEffect::ReconnectSocket]
    } else {
        Vec::new()
    }
}

pub(super) fn waiting_request_missing(model: &AppModel, snapshot: &RoomBootstrapResponse) -> bool {
    match &model.screen {
        Screen::Waiting { request_id, .. } => !snapshot
            .pending_join_requests
            .iter()
            .any(|request| &request.request_id == request_id),
        Screen::Booting | Screen::Lobby { .. } | Screen::Room { .. } => false,
    }
}

pub(super) fn reduce_authoritative_snapshot(
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

#[cfg(test)]
mod tests {
    use p2p_protocol::{CURRENT_PROTOCOL, ParticipantSnapshot, SessionResponse};

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
    fn attachment_decision_preserves_local_revision_context() {
        let model = waiting_model("join-1", 7);
        assert_eq!(
            reduce_attachment(&model, 7, false),
            AttachmentDecision::Ready {
                local_revision: 7,
                incoming_revision: 7,
                member: false,
            }
        );
        assert_eq!(
            reduce_attachment(&model, 8, false),
            AttachmentDecision::AwaitSnapshot {
                local_revision: 7,
                incoming_revision: 8,
            }
        );
        assert_eq!(
            reduce_attachment(&AppModel::default(), 8, true),
            AttachmentDecision::Ignore
        );
    }

    #[test]
    fn snapshot_must_not_trail_local_or_observed_revision() {
        assert!(snapshot_revision_allowed(7, 8, 8));
        assert!(!snapshot_revision_allowed(8, 8, 7));
        assert!(!snapshot_revision_allowed(7, 9, 8));
    }

    #[test]
    fn owner_join_request_reducer_is_idempotent_and_marks_revision() {
        let mut model = room_model(RoomRole::Owner, 7);
        let request = join_request("join-1", "receiver-session");
        let effects = reduce_revisioned_model_event(
            &mut model,
            8,
            RevisionedModelEvent::JoinRequested(request.clone()),
        );
        assert_eq!(effects, vec![RealtimeEffect::MarkTargetRevisionApplied(8)]);
        let duplicate_effects = reduce_revisioned_model_event(
            &mut model,
            8,
            RevisionedModelEvent::JoinRequested(request),
        );
        assert_eq!(duplicate_effects, effects);
        let Screen::Room { snapshot, .. } = model.screen else {
            panic!("owner should remain in the room")
        };
        assert_eq!(snapshot.revision, 8);
        assert_eq!(snapshot.pending_join_requests.len(), 1);
    }

    #[test]
    fn waiting_join_decision_returns_explicit_follow_up_effect() {
        let mut approved = waiting_model("join-1", 7);
        approved.decision_request_id = Some("join-1".to_owned());
        let approved_effects = reduce_revisioned_model_event(
            &mut approved,
            8,
            RevisionedModelEvent::JoinDecided {
                request_id: "join-1".to_owned(),
                decision: JoinDecisionWire::Approved,
            },
        );
        assert_eq!(
            approved_effects,
            vec![
                RealtimeEffect::MarkTargetRevisionApplied(8),
                RealtimeEffect::ResolveWaiting,
            ]
        );
        assert!(approved.decision_request_id.is_none());

        let mut rejected = waiting_model("join-1", 7);
        let rejected_effects = reduce_revisioned_model_event(
            &mut rejected,
            8,
            RevisionedModelEvent::JoinDecided {
                request_id: "join-1".to_owned(),
                decision: JoinDecisionWire::Rejected,
            },
        );
        assert_eq!(
            rejected_effects,
            vec![
                RealtimeEffect::MarkTargetRevisionApplied(8),
                RealtimeEffect::ReturnToLobby(JOIN_REJECTED_NOTICE),
            ]
        );
    }

    #[test]
    fn peer_lifecycle_reducer_keeps_remote_identity_for_cleanup() {
        let mut model = room_model(RoomRole::Owner, 7);
        model.session = Some(session("owner-session"));
        if let Screen::Room { snapshot, .. } = &mut model.screen {
            snapshot.participants.push(participant(
                "receiver-session",
                ParticipantRoleWire::Receiver,
                true,
                Some("peer-receiver"),
            ));
        }
        let effects = reduce_revisioned_model_event(
            &mut model,
            8,
            RevisionedModelEvent::PeerOffline {
                session_id: "receiver-session".to_owned(),
            },
        );
        assert_eq!(
            effects,
            vec![
                RealtimeEffect::MarkTargetRevisionApplied(8),
                RealtimeEffect::RemoveRtcPeer("peer-receiver".to_owned()),
                RealtimeEffect::RefreshRoomSnapshot,
            ]
        );
        let Screen::Room { snapshot, .. } = model.screen else {
            panic!("owner should remain in the room")
        };
        let receiver = snapshot
            .participants
            .iter()
            .find(|participant| participant.session_id == "receiver-session")
            .expect("receiver should remain in the snapshot");
        assert!(!receiver.online);
        assert!(receiver.peer_id.is_none());
    }

    #[test]
    fn peer_online_and_signal_events_describe_rtc_follow_up_work() {
        let mut model = room_model(RoomRole::Owner, 7);
        if let Screen::Room { snapshot, .. } = &mut model.screen {
            snapshot.participants.push(participant(
                "receiver-session",
                ParticipantRoleWire::Receiver,
                false,
                None,
            ));
        }
        let effects = reduce_revisioned_model_event(
            &mut model,
            8,
            RevisionedModelEvent::PeerOnline {
                session_id: "receiver-session".to_owned(),
                peer_id: "peer-receiver".to_owned(),
            },
        );
        assert_eq!(
            effects,
            vec![
                RealtimeEffect::MarkTargetRevisionApplied(8),
                RealtimeEffect::SyncRtcPeers,
                RealtimeEffect::RefreshRoomSnapshot,
            ]
        );

        let signal = ProtocolSignal::Offer {
            sdp: "test-sdp".to_owned(),
        };
        assert_eq!(
            reduce_signal(
                "peer-receiver".to_owned(),
                "negotiation-1".to_owned(),
                signal.clone(),
            ),
            vec![RealtimeEffect::AcceptRtcSignal {
                from_peer_id: "peer-receiver".to_owned(),
                negotiation_id: "negotiation-1".to_owned(),
                signal,
            }]
        );
    }

    #[test]
    fn terminal_and_connection_events_are_described_without_runtime_state() {
        let model = room_model(RoomRole::Owner, 7);
        assert!(reduce_room_expired(&model, 6).is_empty());
        assert_eq!(
            reduce_room_expired(&model, 9),
            vec![
                RealtimeEffect::MarkTargetRevisionApplied(9),
                RealtimeEffect::ReturnToLobby(ROOM_EXPIRED_NOTICE),
            ]
        );
        assert_eq!(
            reduce_server_error("connection_replaced", String::new()),
            vec![RealtimeEffect::SuppressRealtimeConnection]
        );
        assert_eq!(
            reduce_socket_closed(1006, true),
            vec![RealtimeEffect::ReconnectSocket]
        );
        assert!(reduce_socket_closed(1000, false).is_empty());
    }

    #[test]
    fn authoritative_snapshot_tracks_new_online_receivers_for_animation() {
        let mut model = room_model(RoomRole::Owner, 7);
        let mut next = room_snapshot(8);
        next.participants.push(participant(
            "receiver-session",
            ParticipantRoleWire::Receiver,
            true,
            Some("peer-receiver"),
        ));

        let entering =
            reduce_authoritative_snapshot(&mut model, next).expect("newer snapshot should apply");
        assert_eq!(entering, vec!["receiver-session"]);
        assert_eq!(model.entering_receivers, entering);
        assert!(reduce_authoritative_snapshot(&mut model, room_snapshot(6)).is_none());
    }

    fn room_model(role: RoomRole, revision: u64) -> AppModel {
        AppModel {
            screen: Screen::Room {
                role,
                snapshot: room_snapshot(revision),
                invite: None,
                invite_request_id: None,
            },
            ..AppModel::default()
        }
    }

    fn waiting_model(request_id: &str, revision: u64) -> AppModel {
        AppModel {
            screen: Screen::Waiting {
                room_code: "ABC234".to_owned(),
                request_id: request_id.to_owned(),
                peer_id: "peer-receiver".to_owned(),
                revision,
                expires_at_ms: 100,
            },
            ..AppModel::default()
        }
    }

    fn room_snapshot(revision: u64) -> RoomBootstrapResponse {
        RoomBootstrapResponse {
            version: CURRENT_PROTOCOL,
            room_id: "room-1".to_owned(),
            room_code: "ABC234".to_owned(),
            revision,
            expires_at_ms: 100,
            participants: vec![participant(
                "owner-session",
                ParticipantRoleWire::Owner,
                true,
                Some("peer-owner"),
            )],
            pending_join_requests: Vec::new(),
        }
    }

    fn participant(
        session_id: &str,
        role: ParticipantRoleWire,
        online: bool,
        peer_id: Option<&str>,
    ) -> ParticipantSnapshot {
        ParticipantSnapshot {
            session_id: session_id.to_owned(),
            display_name: session_id.to_owned(),
            role,
            online,
            peer_id: peer_id.map(str::to_owned),
        }
    }

    fn join_request(request_id: &str, session_id: &str) -> JoinRequestSnapshot {
        JoinRequestSnapshot {
            request_id: request_id.to_owned(),
            session_id: session_id.to_owned(),
            display_name: session_id.to_owned(),
            expires_at_ms: 100,
        }
    }

    fn session(session_id: &str) -> SessionResponse {
        SessionResponse {
            version: CURRENT_PROTOCOL,
            session_id: session_id.to_owned(),
            display_name: session_id.to_owned(),
            expires_at_ms: 100,
        }
    }
}
