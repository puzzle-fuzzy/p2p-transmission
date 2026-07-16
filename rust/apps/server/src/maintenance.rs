use std::time::Duration;

use p2p_protocol::{CURRENT_PROTOCOL, ServerRealtimeMessage};
use tokio::time::{MissedTickBehavior, interval};
use tracing::warn;

use crate::{
    http_api::AppState,
    realtime::socket::{cleanup_attachments, event_id},
};

const MAINTENANCE_INTERVAL: Duration = Duration::from_secs(30);
const MAINTENANCE_BATCH: u32 = 100;

pub async fn run(state: AppState) {
    let mut timer = interval(MAINTENANCE_INTERVAL);
    timer.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        timer.tick().await;
        if let Err(error) = run_once(&state).await {
            warn!(%error, "maintenance batch failed");
        }
    }
}

pub async fn run_once(state: &AppState) -> Result<(), crate::services::ServiceError> {
    let now = state.services.now()?;
    let expired_rooms = state
        .services
        .storage
        .expire_due_rooms(now, MAINTENANCE_BATCH)
        .await?;
    for mutation in expired_rooms {
        let mut cleanup = state
            .hub
            .broadcast(
                mutation.room.id(),
                ServerRealtimeMessage::RoomExpired {
                    version: CURRENT_PROTOCOL,
                    event_id: event_id(),
                    revision: mutation.room.revision().value(),
                },
            )
            .await;
        cleanup.extend(
            state
                .hub
                .disconnect_room(mutation.room.id(), 4002, "room expired")
                .await,
        );
        cleanup_attachments(state, cleanup).await;
    }

    let expired_requests = state
        .services
        .storage
        .expire_due_join_requests(now, MAINTENANCE_BATCH)
        .await?;
    for mutation in expired_requests {
        let Some(owner) = state
            .services
            .storage
            .find_session(mutation.room.owner())
            .await?
        else {
            continue;
        };
        let Ok(snapshot) = state
            .services
            .bootstrap_room(&owner, mutation.room.code())
            .await
        else {
            continue;
        };
        let evicted = state
            .hub
            .broadcast(
                mutation.room.id(),
                ServerRealtimeMessage::RoomSnapshot {
                    version: CURRENT_PROTOCOL,
                    event_id: event_id(),
                    room_id: snapshot.room_id,
                    room_code: snapshot.room_code,
                    revision: snapshot.revision,
                    expires_at_ms: snapshot.expires_at_ms,
                    participants: snapshot.participants,
                    pending_join_requests: snapshot.pending_join_requests,
                },
            )
            .await;
        cleanup_attachments(state, evicted).await;
    }

    state
        .services
        .storage
        .expire_due_sessions(now, MAINTENANCE_BATCH)
        .await?;
    Ok(())
}
