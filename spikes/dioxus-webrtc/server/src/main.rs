use std::{collections::HashMap, sync::Arc};

use anyhow::Context;
use axum::{
    Router,
    extract::{
        Path, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::StatusCode,
    response::Response,
    routing::get,
};
use futures_util::{SinkExt, StreamExt};
use p2p_spike_protocol::{ClientMessage, ServerMessage};
use tokio::sync::{RwLock, mpsc};
use tower_http::{cors::CorsLayer, trace::TraceLayer};
use tracing::{info, warn};

type PeerSender = mpsc::UnboundedSender<ServerMessage>;
type Rooms = HashMap<String, HashMap<String, PeerSender>>;

#[derive(Clone, Default)]
struct AppState {
    rooms: Arc<RwLock<Rooms>>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "p2p_spike_server=debug,tower_http=info".into()),
        )
        .compact()
        .init();

    let app = Router::new()
        .route("/health", get(health))
        .route("/ws/{room}/{peer_id}", get(upgrade_websocket))
        .layer(TraceLayer::new_for_http())
        .layer(CorsLayer::permissive())
        .with_state(AppState::default());

    let listener = tokio::net::TcpListener::bind("127.0.0.1:3340")
        .await
        .context("bind spike server to 127.0.0.1:3340")?;
    info!(address = %listener.local_addr()?, "Dioxus WebRTC spike server listening");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("serve spike server")
}

async fn health() -> StatusCode {
    StatusCode::NO_CONTENT
}

async fn upgrade_websocket(
    State(state): State<AppState>,
    Path((room, peer_id)): Path<(String, String)>,
    upgrade: WebSocketUpgrade,
) -> Response {
    upgrade.on_upgrade(move |socket| serve_socket(state, room, peer_id, socket))
}

async fn serve_socket(state: AppState, room: String, peer_id: String, socket: WebSocket) {
    let (mut socket_sender, mut socket_receiver) = socket.split();
    let (outgoing_sender, mut outgoing_receiver) = mpsc::unbounded_channel::<ServerMessage>();

    let existing_peers = {
        let mut rooms = state.rooms.write().await;
        let peers = rooms.entry(room.clone()).or_default();
        let existing = peers.keys().cloned().collect::<Vec<_>>();
        for sender in peers.values() {
            let _ = sender.send(ServerMessage::PeerJoined {
                peer_id: peer_id.clone(),
            });
        }
        peers.insert(peer_id.clone(), outgoing_sender.clone());
        existing
    };

    let _ = outgoing_sender.send(ServerMessage::Peers {
        peers: existing_peers,
    });
    info!(%room, %peer_id, "peer connected");

    let writer = tokio::spawn(async move {
        while let Some(message) = outgoing_receiver.recv().await {
            let Ok(json) = serde_json::to_string(&message) else {
                continue;
            };
            if socket_sender
                .send(Message::Text(json.into()))
                .await
                .is_err()
            {
                break;
            }
        }
    });

    while let Some(result) = socket_receiver.next().await {
        let message = match result {
            Ok(message) => message,
            Err(error) => {
                warn!(%room, %peer_id, %error, "websocket read failed");
                break;
            }
        };

        match message {
            Message::Text(text) => {
                let parsed = serde_json::from_str::<ClientMessage>(&text);
                match parsed {
                    Ok(ClientMessage::Signal { to, signal }) => {
                        let target = {
                            let rooms = state.rooms.read().await;
                            rooms.get(&room).and_then(|peers| peers.get(&to)).cloned()
                        };
                        if let Some(target) = target {
                            let _ = target.send(ServerMessage::Signal {
                                from: peer_id.clone(),
                                signal,
                            });
                        } else {
                            let _ = outgoing_sender.send(ServerMessage::Error {
                                message: format!("target peer {to} is not online"),
                            });
                        }
                    }
                    Err(error) => {
                        let _ = outgoing_sender.send(ServerMessage::Error {
                            message: format!("invalid client message: {error}"),
                        });
                    }
                }
            }
            Message::Close(_) => break,
            Message::Ping(payload) => {
                let _ = outgoing_sender.send(ServerMessage::Error {
                    message: format!(
                        "ping received ({} bytes); browser handles pong automatically",
                        payload.len()
                    ),
                });
            }
            Message::Binary(_) | Message::Pong(_) => {}
        }
    }

    {
        let mut rooms = state.rooms.write().await;
        if let Some(peers) = rooms.get_mut(&room) {
            peers.remove(&peer_id);
            for sender in peers.values() {
                let _ = sender.send(ServerMessage::PeerLeft {
                    peer_id: peer_id.clone(),
                });
            }
            if peers.is_empty() {
                rooms.remove(&room);
            }
        }
    }

    writer.abort();
    info!(%room, %peer_id, "peer disconnected");
}

async fn shutdown_signal() {
    if let Err(error) = tokio::signal::ctrl_c().await {
        warn!(%error, "failed to listen for ctrl-c");
    }
}
