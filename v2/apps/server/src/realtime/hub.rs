use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

use p2p_domain::{PeerId, RoomCode, RoomId, SessionId};
use p2p_protocol::{CURRENT_PROTOCOL, ServerRealtimeMessage};
use thiserror::Error;
use tokio::sync::{Mutex, mpsc};
use uuid::Uuid;

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ConnectionId(String);

impl ConnectionId {
    fn generate() -> Self {
        Self(format!("c_{}", Uuid::new_v4().simple()))
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Attachment {
    pub room_id: RoomId,
    pub room_code: RoomCode,
    pub session_id: SessionId,
    pub peer_id: PeerId,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct JoinWatch {
    room_id: RoomId,
    session_id: SessionId,
}

#[derive(Clone, Debug)]
pub enum Outbound {
    Message(ServerRealtimeMessage),
    Close { code: u16, reason: &'static str },
}

pub struct Registration {
    pub connection_id: ConnectionId,
    pub receiver: mpsc::Receiver<Outbound>,
}

#[derive(Clone, Debug)]
pub struct RealtimeHub {
    inner: Arc<Mutex<HubState>>,
    queue_capacity: usize,
}

#[derive(Debug, Default)]
struct HubState {
    connections: HashMap<ConnectionId, ConnectionEntry>,
    evicted_attachments: HashMap<ConnectionId, Attachment>,
    room_connections: HashMap<RoomId, HashSet<ConnectionId>>,
    session_routes: HashMap<(RoomId, SessionId), ConnectionId>,
    peer_routes: HashMap<(RoomId, PeerId), ConnectionId>,
}

#[derive(Debug)]
struct ConnectionEntry {
    session_id: SessionId,
    sender: mpsc::Sender<Outbound>,
    attachment: Option<Attachment>,
    join_watch: Option<JoinWatch>,
}

impl RealtimeHub {
    pub fn new(queue_capacity: usize) -> Self {
        Self {
            inner: Arc::new(Mutex::new(HubState::default())),
            queue_capacity: queue_capacity.max(1),
        }
    }

    pub async fn register(&self, session_id: SessionId) -> Registration {
        let connection_id = ConnectionId::generate();
        let (sender, receiver) = mpsc::channel(self.queue_capacity);
        self.inner.lock().await.connections.insert(
            connection_id.clone(),
            ConnectionEntry {
                session_id,
                sender,
                attachment: None,
                join_watch: None,
            },
        );
        Registration {
            connection_id,
            receiver,
        }
    }

    pub async fn attach(
        &self,
        connection_id: &ConnectionId,
        room_id: RoomId,
        room_code: RoomCode,
        peer_id: PeerId,
    ) -> Result<Vec<Attachment>, HubError> {
        let mut state = self.inner.lock().await;
        let session_id = state
            .connections
            .get(connection_id)
            .ok_or(HubError::ConnectionNotFound)?
            .session_id
            .clone();
        let attachment = Attachment {
            room_id: room_id.clone(),
            room_code,
            session_id: session_id.clone(),
            peer_id: peer_id.clone(),
        };

        let mut replaced = Vec::new();
        let existing_ids = [
            state
                .session_routes
                .get(&(room_id.clone(), session_id.clone()))
                .cloned(),
            state
                .peer_routes
                .get(&(room_id.clone(), peer_id.clone()))
                .cloned(),
        ];
        let unique_existing = existing_ids
            .into_iter()
            .flatten()
            .filter(|existing| existing != connection_id)
            .collect::<HashSet<_>>();
        for existing in unique_existing {
            if let Some(entry) = state.connections.get(&existing) {
                let _ = entry
                    .sender
                    .try_send(Outbound::Message(ServerRealtimeMessage::Error {
                        version: CURRENT_PROTOCOL,
                        code: "connection_replaced".to_owned(),
                        message: "a newer connection replaced this socket".to_owned(),
                        retryable: true,
                    }));
                let _ = entry.sender.try_send(Outbound::Close {
                    code: 4001,
                    reason: "connection replaced",
                });
            }
            if let Some(old) = evict_connection_locked(&mut state, &existing) {
                replaced.push(old);
            }
        }

        if let Some(previous) = state
            .connections
            .get(connection_id)
            .and_then(|entry| entry.attachment.clone())
        {
            detach_mappings(&mut state, connection_id, &previous);
        }
        if let Some(previous) = state
            .connections
            .get(connection_id)
            .and_then(|entry| entry.join_watch.clone())
        {
            detach_watch_mappings(&mut state, connection_id, &previous);
        }

        let entry = state
            .connections
            .get_mut(connection_id)
            .ok_or(HubError::ConnectionNotFound)?;
        entry.attachment = Some(attachment.clone());
        entry.join_watch = None;
        state
            .room_connections
            .entry(room_id.clone())
            .or_default()
            .insert(connection_id.clone());
        state
            .session_routes
            .insert((room_id.clone(), session_id), connection_id.clone());
        state
            .peer_routes
            .insert((room_id, peer_id), connection_id.clone());
        Ok(replaced)
    }

    pub async fn watch_join(
        &self,
        connection_id: &ConnectionId,
        room_id: RoomId,
    ) -> Result<Vec<Attachment>, HubError> {
        let mut state = self.inner.lock().await;
        let session_id = state
            .connections
            .get(connection_id)
            .ok_or(HubError::ConnectionNotFound)?
            .session_id
            .clone();
        let watch = JoinWatch {
            room_id: room_id.clone(),
            session_id: session_id.clone(),
        };

        let existing = state
            .session_routes
            .get(&(room_id.clone(), session_id.clone()))
            .filter(|existing| *existing != connection_id)
            .cloned();
        let mut replaced = Vec::new();
        if let Some(existing) = existing
            && let Some(attachment) = evict_connection_locked(&mut state, &existing)
        {
            replaced.push(attachment);
        }

        if let Some(previous) = state
            .connections
            .get(connection_id)
            .and_then(|entry| entry.attachment.clone())
        {
            detach_mappings(&mut state, connection_id, &previous);
        }
        if let Some(previous) = state
            .connections
            .get(connection_id)
            .and_then(|entry| entry.join_watch.clone())
        {
            detach_watch_mappings(&mut state, connection_id, &previous);
        }

        let entry = state
            .connections
            .get_mut(connection_id)
            .ok_or(HubError::ConnectionNotFound)?;
        entry.attachment = None;
        entry.join_watch = Some(watch);
        state
            .room_connections
            .entry(room_id.clone())
            .or_default()
            .insert(connection_id.clone());
        state
            .session_routes
            .insert((room_id, session_id), connection_id.clone());
        Ok(replaced)
    }

    pub async fn detach(
        &self,
        connection_id: &ConnectionId,
    ) -> Result<Option<Attachment>, HubError> {
        let mut state = self.inner.lock().await;
        let attachment = state
            .connections
            .get_mut(connection_id)
            .ok_or(HubError::ConnectionNotFound)?
            .attachment
            .take();
        if let Some(attachment) = &attachment {
            detach_mappings(&mut state, connection_id, attachment);
        }
        let watch = state
            .connections
            .get_mut(connection_id)
            .and_then(|entry| entry.join_watch.take());
        if let Some(watch) = &watch {
            detach_watch_mappings(&mut state, connection_id, watch);
        }
        Ok(attachment)
    }

    pub async fn unregister(&self, connection_id: &ConnectionId) -> Option<Attachment> {
        let mut state = self.inner.lock().await;
        remove_connection_locked(&mut state, connection_id)
            .or_else(|| state.evicted_attachments.remove(connection_id))
    }

    pub async fn attachment(&self, connection_id: &ConnectionId) -> Result<Attachment, HubError> {
        self.inner
            .lock()
            .await
            .connections
            .get(connection_id)
            .and_then(|entry| entry.attachment.clone())
            .ok_or(HubError::NotAttached)
    }

    pub async fn send(
        &self,
        connection_id: &ConnectionId,
        outbound: Outbound,
    ) -> Result<(), HubError> {
        let mut state = self.inner.lock().await;
        let result = state
            .connections
            .get(connection_id)
            .ok_or(HubError::ConnectionNotFound)?
            .sender
            .try_send(outbound);
        match result {
            Ok(()) => Ok(()),
            Err(mpsc::error::TrySendError::Full(_)) => {
                evict_connection_locked(&mut state, connection_id);
                Err(HubError::SlowConsumer)
            }
            Err(mpsc::error::TrySendError::Closed(_)) => {
                evict_connection_locked(&mut state, connection_id);
                Err(HubError::ConnectionNotFound)
            }
        }
    }

    pub async fn send_to_peer(
        &self,
        sender_connection: &ConnectionId,
        to_peer_id: &PeerId,
        message: ServerRealtimeMessage,
    ) -> Result<(), HubError> {
        let mut state = self.inner.lock().await;
        let sender_attachment = state
            .connections
            .get(sender_connection)
            .and_then(|entry| entry.attachment.clone())
            .ok_or(HubError::NotAttached)?;
        if &sender_attachment.peer_id == to_peer_id {
            return Err(HubError::CannotSignalSelf);
        }
        let target = state
            .peer_routes
            .get(&(sender_attachment.room_id, to_peer_id.clone()))
            .cloned()
            .ok_or(HubError::TargetNotFound)?;
        let result = state
            .connections
            .get(&target)
            .ok_or(HubError::TargetNotFound)?
            .sender
            .try_send(Outbound::Message(message));
        match result {
            Ok(()) => Ok(()),
            Err(mpsc::error::TrySendError::Full(_)) => {
                evict_connection_locked(&mut state, &target);
                Err(HubError::SlowConsumer)
            }
            Err(mpsc::error::TrySendError::Closed(_)) => {
                evict_connection_locked(&mut state, &target);
                Err(HubError::TargetNotFound)
            }
        }
    }

    pub async fn broadcast(
        &self,
        room_id: &RoomId,
        message: ServerRealtimeMessage,
    ) -> Vec<Attachment> {
        let mut state = self.inner.lock().await;
        let connection_ids = state
            .room_connections
            .get(room_id)
            .cloned()
            .unwrap_or_default();
        let mut evicted = Vec::new();
        for connection_id in connection_ids {
            let should_evict = state.connections.get(&connection_id).is_some_and(|entry| {
                entry
                    .sender
                    .try_send(Outbound::Message(message.clone()))
                    .is_err()
            });
            if should_evict
                && let Some(attachment) = evict_connection_locked(&mut state, &connection_id)
            {
                evicted.push(attachment);
            }
        }
        evicted
    }

    pub async fn disconnect_session(
        &self,
        room_id: &RoomId,
        session_id: &SessionId,
        code: u16,
        reason: &'static str,
    ) -> Vec<Attachment> {
        let mut state = self.inner.lock().await;
        let connection_id = state
            .session_routes
            .get(&(room_id.clone(), session_id.clone()))
            .cloned();
        let Some(connection_id) = connection_id else {
            return Vec::new();
        };
        if let Some(entry) = state.connections.get(&connection_id) {
            let _ = entry.sender.try_send(Outbound::Close { code, reason });
        }
        evict_connection_locked(&mut state, &connection_id)
            .into_iter()
            .collect()
    }

    pub async fn disconnect_room(
        &self,
        room_id: &RoomId,
        code: u16,
        reason: &'static str,
    ) -> Vec<Attachment> {
        let mut state = self.inner.lock().await;
        let connection_ids = state
            .room_connections
            .get(room_id)
            .cloned()
            .unwrap_or_default();
        let mut disconnected = Vec::new();
        for connection_id in connection_ids {
            if let Some(entry) = state.connections.get(&connection_id) {
                let _ = entry.sender.try_send(Outbound::Close { code, reason });
            }
            if let Some(attachment) = evict_connection_locked(&mut state, &connection_id) {
                disconnected.push(attachment);
            }
        }
        disconnected
    }

    pub async fn connection_count(&self) -> usize {
        self.inner.lock().await.connections.len()
    }
}

fn remove_connection_locked(
    state: &mut HubState,
    connection_id: &ConnectionId,
) -> Option<Attachment> {
    let entry = state.connections.remove(connection_id)?;
    if let Some(attachment) = &entry.attachment {
        detach_mappings(state, connection_id, attachment);
    }
    if let Some(watch) = &entry.join_watch {
        detach_watch_mappings(state, connection_id, watch);
    }
    entry.attachment
}

fn evict_connection_locked(
    state: &mut HubState,
    connection_id: &ConnectionId,
) -> Option<Attachment> {
    let attachment = remove_connection_locked(state, connection_id);
    if let Some(attachment) = &attachment {
        state
            .evicted_attachments
            .insert(connection_id.clone(), attachment.clone());
    }
    attachment
}

fn detach_mappings(state: &mut HubState, connection_id: &ConnectionId, attachment: &Attachment) {
    if state
        .session_routes
        .get(&(attachment.room_id.clone(), attachment.session_id.clone()))
        == Some(connection_id)
    {
        state
            .session_routes
            .remove(&(attachment.room_id.clone(), attachment.session_id.clone()));
    }
    if state
        .peer_routes
        .get(&(attachment.room_id.clone(), attachment.peer_id.clone()))
        == Some(connection_id)
    {
        state
            .peer_routes
            .remove(&(attachment.room_id.clone(), attachment.peer_id.clone()));
    }
    if let Some(connections) = state.room_connections.get_mut(&attachment.room_id) {
        connections.remove(connection_id);
        if connections.is_empty() {
            state.room_connections.remove(&attachment.room_id);
        }
    }
}

fn detach_watch_mappings(state: &mut HubState, connection_id: &ConnectionId, watch: &JoinWatch) {
    if state
        .session_routes
        .get(&(watch.room_id.clone(), watch.session_id.clone()))
        == Some(connection_id)
    {
        state
            .session_routes
            .remove(&(watch.room_id.clone(), watch.session_id.clone()));
    }
    if let Some(connections) = state.room_connections.get_mut(&watch.room_id) {
        connections.remove(connection_id);
        if connections.is_empty() {
            state.room_connections.remove(&watch.room_id);
        }
    }
}

#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
pub enum HubError {
    #[error("realtime connection does not exist")]
    ConnectionNotFound,
    #[error("realtime connection has not attached a room")]
    NotAttached,
    #[error("target peer is not online in the attached room")]
    TargetNotFound,
    #[error("a peer cannot signal itself")]
    CannotSignalSelf,
    #[error("realtime consumer exceeded its bounded queue")]
    SlowConsumer,
}

#[cfg(test)]
mod tests {
    use p2p_protocol::CURRENT_PROTOCOL;

    use super::*;

    fn id<T>(value: &str) -> T
    where
        T: std::str::FromStr,
        T::Err: std::fmt::Debug,
    {
        value.parse().expect("valid id")
    }

    fn heartbeat_error() -> Outbound {
        Outbound::Message(ServerRealtimeMessage::Error {
            version: CURRENT_PROTOCOL,
            code: "test".to_owned(),
            message: "test message".to_owned(),
            retryable: false,
        })
    }

    #[tokio::test]
    async fn replacing_a_session_route_keeps_the_new_generation() {
        let hub = RealtimeHub::new(4);
        let first = hub.register(id("session_1")).await;
        hub.attach(
            &first.connection_id,
            id("room_1"),
            id("ABC123"),
            id("peer_old"),
        )
        .await
        .expect("attach first");
        let second = hub.register(id("session_1")).await;
        let replaced = hub
            .attach(
                &second.connection_id,
                id("room_1"),
                id("ABC123"),
                id("peer_new"),
            )
            .await
            .expect("attach second");
        assert_eq!(replaced.len(), 1);

        assert_eq!(
            hub.unregister(&first.connection_id)
                .await
                .expect("old attachment remains available for stale cleanup")
                .peer_id,
            id("peer_old")
        );
        assert_eq!(
            hub.attachment(&second.connection_id)
                .await
                .expect("new attachment")
                .peer_id,
            id("peer_new")
        );
        assert_eq!(hub.connection_count().await, 1);
    }

    #[tokio::test]
    async fn a_full_outbound_queue_evicts_only_the_slow_connection() {
        let hub = RealtimeHub::new(1);
        let registration = hub.register(id("session_1")).await;
        hub.send(&registration.connection_id, heartbeat_error())
            .await
            .expect("first message fills queue");
        assert_eq!(
            hub.send(&registration.connection_id, heartbeat_error())
                .await,
            Err(HubError::SlowConsumer)
        );
        assert_eq!(hub.connection_count().await, 0);
    }
}
