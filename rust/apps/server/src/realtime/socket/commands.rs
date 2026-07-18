//! Realtime command validation, authorization, and domain mutations.
//!
//! The parent socket module owns the WebSocket lifecycle. This module keeps
//! protocol dispatch independent from frame handling and connection cleanup.

use crate::{
    http_api::AppState,
    realtime::hub::{Attachment, ConnectionId, Outbound},
};
use p2p_domain::{MembershipState, PeerId, RequestId, RoomCode, RoomCommand, RoomId, Session};
use p2p_protocol::{
    CURRENT_PROTOCOL, ClientRealtimeMessage, JoinRequestStateWire, ServerRealtimeMessage, Signal,
};

use super::{cleanup_attachments, event_id};

mod errors;

use errors::{SocketCommandError, map_hub_error, map_storage_error};

pub(super) async fn handle_client_message(
    state: &AppState,
    connection_id: &ConnectionId,
    session: &Session,
    message: ClientRealtimeMessage,
) -> Result<SocketAction, SocketCommandError> {
    match message {
        ClientRealtimeMessage::AttachRoom {
            room_code,
            peer_id,
            last_revision,
            ..
        } => {
            attach_room(
                state,
                connection_id,
                session,
                room_code,
                peer_id,
                last_revision,
            )
            .await
        }
        ClientRealtimeMessage::WatchJoinRequest {
            room_code,
            request_id,
            last_revision,
            ..
        } => {
            watch_join_request(
                state,
                connection_id,
                session,
                room_code,
                request_id,
                last_revision,
            )
            .await
        }
        ClientRealtimeMessage::DetachRoom { room_code, .. } => {
            detach_room(state, connection_id, room_code).await
        }
        ClientRealtimeMessage::Signal {
            room_code,
            to_peer_id,
            negotiation_id,
            signal,
            ..
        } => {
            relay_signal(
                state,
                connection_id,
                session,
                room_code,
                to_peer_id,
                negotiation_id,
                signal,
            )
            .await
        }
        ClientRealtimeMessage::Heartbeat { .. } | ClientRealtimeMessage::AckEvent { .. } => {
            Ok(SocketAction::Continue)
        }
    }
}

async fn attach_room(
    state: &AppState,
    connection_id: &ConnectionId,
    session: &Session,
    room_code: String,
    peer_id: String,
    last_revision: Option<u64>,
) -> Result<SocketAction, SocketCommandError> {
    let room_code = RoomCode::parse(room_code).map_err(|_| SocketCommandError::invalid())?;
    let peer_id = PeerId::parse(peer_id).map_err(|_| SocketCommandError::invalid())?;
    let now = state
        .services
        .now()
        .map_err(|_| SocketCommandError::unavailable())?;
    let mutation = state
        .services
        .storage
        .apply_room_command(
            &room_code,
            None,
            RoomCommand::Attach {
                session_id: session.id().clone(),
                peer_id: peer_id.clone(),
                now,
            },
            now,
        )
        .await
        .map_err(map_storage_error)?;

    let replaced = state
        .hub
        .attach(
            connection_id,
            mutation.room.id().clone(),
            room_code.clone(),
            peer_id.clone(),
        )
        .await
        .map_err(map_hub_error)?;
    if !replaced.is_empty() {
        cleanup_attachments(state, replaced).await;
    }

    state
        .hub
        .send(
            connection_id,
            Outbound::Message(ServerRealtimeMessage::Attached {
                version: CURRENT_PROTOCOL,
                event_id: event_id(),
                room_id: mutation.room.id().to_string(),
                revision: mutation.room.revision().value(),
            }),
        )
        .await
        .map_err(map_hub_error)?;

    if last_revision != Some(mutation.room.revision().value()) {
        let snapshot = state
            .services
            .bootstrap_room(session, &room_code)
            .await
            .map_err(|_| SocketCommandError::unavailable())?;
        state
            .hub
            .send(
                connection_id,
                Outbound::Message(ServerRealtimeMessage::RoomSnapshot {
                    version: CURRENT_PROTOCOL,
                    event_id: event_id(),
                    room_id: snapshot.room_id,
                    room_code: snapshot.room_code,
                    revision: snapshot.revision,
                    expires_at_ms: snapshot.expires_at_ms,
                    participants: snapshot.participants,
                    pending_join_requests: snapshot.pending_join_requests,
                }),
            )
            .await
            .map_err(map_hub_error)?;
    }

    if mutation.outcome.changed() {
        let evicted = state
            .hub
            .broadcast(
                mutation.room.id(),
                ServerRealtimeMessage::PeerOnline {
                    version: CURRENT_PROTOCOL,
                    event_id: event_id(),
                    revision: mutation.room.revision().value(),
                    session_id: session.id().to_string(),
                    peer_id: peer_id.to_string(),
                },
            )
            .await;
        cleanup_attachments(state, evicted).await;
    }
    Ok(SocketAction::Attached)
}

async fn watch_join_request(
    state: &AppState,
    connection_id: &ConnectionId,
    session: &Session,
    room_code: String,
    request_id: String,
    last_revision: Option<u64>,
) -> Result<SocketAction, SocketCommandError> {
    let room_code = RoomCode::parse(room_code).map_err(|_| SocketCommandError::invalid())?;
    let request_id = RequestId::parse(request_id).map_err(|_| SocketCommandError::invalid())?;
    let status = state
        .services
        .join_request_status(session, &room_code, &request_id)
        .await
        .map_err(|_| SocketCommandError::forbidden())?;
    if status.state != JoinRequestStateWire::Pending {
        return Err(SocketCommandError::join_resolved());
    }
    let room_id = RoomId::parse(&status.room_id).map_err(|_| SocketCommandError::unavailable())?;
    let snapshot = state
        .services
        .bootstrap_room(session, &room_code)
        .await
        .map_err(|_| SocketCommandError::unavailable())?;
    let replaced = state
        .hub
        .watch_join(connection_id, room_id.clone())
        .await
        .map_err(map_hub_error)?;
    if !replaced.is_empty() {
        cleanup_attachments(state, replaced).await;
    }
    state
        .hub
        .send(
            connection_id,
            Outbound::Message(ServerRealtimeMessage::JoinWatching {
                version: CURRENT_PROTOCOL,
                event_id: event_id(),
                room_id: room_id.to_string(),
                request_id: request_id.to_string(),
                revision: status.revision,
            }),
        )
        .await
        .map_err(map_hub_error)?;
    if last_revision != Some(snapshot.revision) {
        state
            .hub
            .send(
                connection_id,
                Outbound::Message(ServerRealtimeMessage::RoomSnapshot {
                    version: CURRENT_PROTOCOL,
                    event_id: event_id(),
                    room_id: snapshot.room_id,
                    room_code: snapshot.room_code,
                    revision: snapshot.revision,
                    expires_at_ms: snapshot.expires_at_ms,
                    participants: snapshot.participants,
                    pending_join_requests: snapshot.pending_join_requests,
                }),
            )
            .await
            .map_err(map_hub_error)?;
    }
    Ok(SocketAction::Attached)
}

async fn detach_room(
    state: &AppState,
    connection_id: &ConnectionId,
    room_code: String,
) -> Result<SocketAction, SocketCommandError> {
    let room_code = RoomCode::parse(room_code).map_err(|_| SocketCommandError::invalid())?;
    let current = state
        .hub
        .attachment(connection_id)
        .await
        .map_err(map_hub_error)?;
    if current.room_code != room_code {
        return Err(SocketCommandError::forbidden());
    }
    let attachment = state
        .hub
        .detach(connection_id)
        .await
        .map_err(map_hub_error)?;
    if let Some(attachment) = attachment {
        cleanup_attachments(state, vec![attachment]).await;
    }
    Ok(SocketAction::Detached)
}

async fn relay_signal(
    state: &AppState,
    connection_id: &ConnectionId,
    session: &Session,
    room_code: String,
    to_peer_id: String,
    negotiation_id: String,
    signal: Signal,
) -> Result<SocketAction, SocketCommandError> {
    let room_code = RoomCode::parse(room_code).map_err(|_| SocketCommandError::invalid())?;
    let to_peer_id = PeerId::parse(to_peer_id).map_err(|_| SocketCommandError::invalid())?;
    let attachment = authorize_signal(state, connection_id, &room_code, &to_peer_id).await?;
    let now = state
        .services
        .now()
        .map_err(|_| SocketCommandError::unavailable())?;
    if !state
        .services
        .limiter
        .check(
            "signal",
            session.id().as_str(),
            state.services.config.signal_rate,
            now.value(),
        )
        .await
    {
        state.observability.record_realtime_signal_rate_limited();
        return Err(SocketCommandError::rate_limited());
    }
    state
        .hub
        .send_to_peer(
            connection_id,
            &to_peer_id,
            ServerRealtimeMessage::Signal {
                version: CURRENT_PROTOCOL,
                event_id: event_id(),
                from_peer_id: attachment.peer_id.to_string(),
                negotiation_id,
                signal,
            },
        )
        .await
        .map_err(map_hub_error)?;
    Ok(SocketAction::Continue)
}

async fn authorize_signal(
    state: &AppState,
    connection_id: &ConnectionId,
    room_code: &RoomCode,
    to_peer_id: &PeerId,
) -> Result<Attachment, SocketCommandError> {
    let attachment = state
        .hub
        .attachment(connection_id)
        .await
        .map_err(map_hub_error)?;
    if &attachment.room_code != room_code || &attachment.peer_id == to_peer_id {
        return Err(SocketCommandError::forbidden());
    }
    let room = state
        .services
        .storage
        .find_room_by_code(room_code)
        .await
        .map_err(|_| SocketCommandError::unavailable())?
        .ok_or_else(SocketCommandError::forbidden)?;
    let sender_is_current = matches!(
        room.membership_state(&attachment.session_id),
        Some(MembershipState::Online { peer_id }) if peer_id == &attachment.peer_id
    );
    let target_is_current = room.membership_snapshots().into_iter().any(|membership| {
        matches!(
            membership.state,
            MembershipState::Online { peer_id } if peer_id == *to_peer_id
        )
    });
    if !sender_is_current || !target_is_current {
        return Err(SocketCommandError::forbidden());
    }
    Ok(attachment)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum SocketAction {
    Attached,
    Detached,
    Continue,
}
