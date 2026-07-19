use std::{collections::HashSet, time::Duration};

use axum::{
    extract::{
        State, WebSocketUpgrade,
        ws::{CloseFrame, Message, WebSocket},
    },
    http::HeaderMap,
    response::{IntoResponse, Response},
};
use axum_extra::extract::CookieJar;
use futures_util::{SinkExt, StreamExt};
use p2p_domain::RoomCommand;
use p2p_protocol::{
    CURRENT_PROTOCOL, ClientRealtimeMessage, ServerRealtimeMessage, parse_client_message,
};
use tokio::time::timeout;
use tracing::{debug, warn};
use uuid::Uuid;

use crate::{
    http_api::{AppState, HttpError, authenticate, require_origin},
    realtime::hub::{Attachment, ConnectionId, Outbound},
};

mod commands;

use commands::{SocketAction, handle_client_message};

const SOCKET_IDLE_TIMEOUT: Duration = Duration::from_secs(90);
const MAX_PROTOCOL_VIOLATIONS: u8 = 3;

pub async fn upgrade(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Result<Response, HttpError> {
    require_origin(&state, &headers)?;
    let session = authenticate(&state, &jar).await?;
    Ok(upgrade
        .on_upgrade(move |socket| serve_socket(socket, state, session))
        .into_response())
}

async fn serve_socket(socket: WebSocket, state: AppState, session: p2p_domain::Session) {
    let _connection = state.observability.websocket_connection();
    let registration = state.hub.register(session.id().clone()).await;
    let connection_id = registration.connection_id;
    let mut receiver = registration.receiver;
    let (mut sink, mut stream) = socket.split();
    let writer = tokio::spawn(async move {
        while let Some(outbound) = receiver.recv().await {
            let result = match outbound {
                Outbound::Message(message) => match serde_json::to_string(&message) {
                    Ok(json) => sink.send(Message::Text(json.into())).await,
                    Err(error) => {
                        warn!(%error, "failed to serialize realtime message");
                        break;
                    }
                },
                Outbound::Close { code, reason } => {
                    let result = sink
                        .send(Message::Close(Some(CloseFrame {
                            code,
                            reason: reason.into(),
                        })))
                        .await;
                    if result.is_ok() {
                        break;
                    }
                    result
                }
            };
            if result.is_err() {
                break;
            }
        }
    });

    let mut attached = false;
    let mut violations = 0_u8;
    loop {
        let message = match timeout(SOCKET_IDLE_TIMEOUT, stream.next()).await {
            Ok(Some(Ok(message))) => message,
            Ok(Some(Err(error))) => {
                debug!(%error, "realtime socket read failed");
                break;
            }
            Ok(None) | Err(_) => break,
        };

        let client_message = match message {
            Message::Text(text) => match parse_client_message(text.as_str()) {
                Ok(message) => message,
                Err(_) => {
                    violations = violations.saturating_add(1);
                    send_socket_error(
                        &state,
                        &connection_id,
                        "invalid_message",
                        "realtime message is invalid",
                        false,
                    )
                    .await;
                    if violations >= MAX_PROTOCOL_VIOLATIONS {
                        break;
                    }
                    continue;
                }
            },
            Message::Binary(_) => {
                violations = violations.saturating_add(1);
                send_socket_error(
                    &state,
                    &connection_id,
                    "binary_not_allowed",
                    "realtime control messages must use JSON text frames",
                    false,
                )
                .await;
                if violations >= MAX_PROTOCOL_VIOLATIONS {
                    break;
                }
                continue;
            }
            Message::Close(_) => break,
            Message::Ping(_) | Message::Pong(_) => continue,
        };

        if !attached
            && !matches!(
                client_message,
                ClientRealtimeMessage::AttachRoom { .. }
                    | ClientRealtimeMessage::WatchJoinRequest { .. }
            )
        {
            send_socket_error(
                &state,
                &connection_id,
                "attach_required",
                "the first realtime message must attach a room",
                false,
            )
            .await;
            break;
        }

        match handle_client_message(&state, &connection_id, &session, client_message).await {
            Ok(SocketAction::Attached) => attached = true,
            Ok(SocketAction::Detached) => attached = false,
            Ok(SocketAction::Continue) => {}
            Err(error) => {
                send_socket_error(
                    &state,
                    &connection_id,
                    error.code,
                    error.message,
                    error.retryable,
                )
                .await;
                if error.fatal {
                    break;
                }
            }
        }
    }

    if let Some(attachment) = state.hub.unregister(&connection_id).await {
        cleanup_attachments(&state, vec![attachment]).await;
    }
    let _ = timeout(Duration::from_secs(1), writer).await;
}

pub(crate) async fn cleanup_attachments(state: &AppState, initial: Vec<Attachment>) {
    let mut pending = initial;
    let mut seen = HashSet::new();
    while let Some(attachment) = pending.pop() {
        let key = format!(
            "{}:{}:{}",
            attachment.room_id, attachment.session_id, attachment.peer_id
        );
        if !seen.insert(key) {
            continue;
        }
        let Ok(now) = state.services.now() else {
            continue;
        };
        match state
            .services
            .storage
            .apply_room_command(
                &attachment.room_code,
                None,
                RoomCommand::Detach {
                    session_id: attachment.session_id.clone(),
                    peer_id: attachment.peer_id.clone(),
                },
                now,
            )
            .await
        {
            Ok(mutation) if mutation.outcome.changed() => {
                let evicted = state
                    .hub
                    .broadcast(
                        &attachment.room_id,
                        ServerRealtimeMessage::PeerOffline {
                            version: CURRENT_PROTOCOL,
                            event_id: event_id(),
                            revision: mutation.room.revision().value(),
                            session_id: attachment.session_id.to_string(),
                        },
                    )
                    .await;
                pending.extend(evicted);
            }
            Ok(_) => {}
            Err(error) => debug!(%error, "realtime detach cleanup was ignored"),
        }
    }
}

async fn send_socket_error(
    state: &AppState,
    connection_id: &ConnectionId,
    code: &'static str,
    message: &'static str,
    retryable: bool,
) {
    let _ = state
        .hub
        .send(
            connection_id,
            Outbound::Message(ServerRealtimeMessage::Error {
                version: CURRENT_PROTOCOL,
                code: code.to_owned(),
                message: message.to_owned(),
                retryable,
            }),
        )
        .await;
}

pub(crate) fn event_id() -> String {
    format!("e_{}", Uuid::new_v4().simple())
}

#[cfg(test)]
mod tests {
    use std::{net::SocketAddr, path::PathBuf};

    use axum::{
        body::Body,
        http::{HeaderValue, Request, StatusCode, header},
    };
    use futures_util::{SinkExt, StreamExt};
    use p2p_domain::{JoinDecision, MembershipState, PeerId, RequestId, Revision, RoomCode};
    use p2p_protocol::{ClientRealtimeMessage, ServerRealtimeMessage, Signal};
    use serde_json::json;
    use tokio::{net::TcpStream, sync::oneshot, task::JoinHandle, time::sleep};
    use tokio_tungstenite::{
        MaybeTlsStream, WebSocketStream, connect_async,
        tungstenite::{Error as WebSocketError, Message as ClientFrame, client::IntoClientRequest},
    };
    use tower::ServiceExt;

    use super::*;

    use crate::{
        app,
        config::AppConfig,
        http_api::{AppState, SESSION_COOKIE_NAME},
        services::AppServices,
        storage::Storage,
        web_shell::TEST_WEB_SHELL_TEMPLATE,
    };

    type ClientSocket = WebSocketStream<MaybeTlsStream<TcpStream>>;

    struct TestServer {
        state: AppState,
        directory: PathBuf,
        address: SocketAddr,
        shutdown: oneshot::Sender<()>,
        task: JoinHandle<Result<(), std::io::Error>>,
        owner: p2p_domain::Session,
        receiver: p2p_domain::Session,
        room_code: RoomCode,
    }

    impl TestServer {
        async fn start() -> Self {
            let directory = std::env::temp_dir().join(format!("p2p-ws-{}", Uuid::new_v4()));
            std::fs::create_dir_all(&directory).expect("create test directory");
            std::fs::write(directory.join("index.html"), TEST_WEB_SHELL_TEMPLATE)
                .expect("write test index");
            let config = AppConfig {
                database_path: directory.join("control.sqlite3"),
                ..AppConfig::default()
            };
            let storage = Storage::connect(&config.database_path)
                .await
                .expect("connect test storage");
            let state = AppState::new(AppServices::new(storage, config));
            let owner = state
                .services
                .create_or_restore_session(None, "Owner")
                .await
                .expect("create owner");
            let receiver = state
                .services
                .create_or_restore_session(None, "Receiver")
                .await
                .expect("create receiver");
            let room = state
                .services
                .create_room(&owner, "create_1")
                .await
                .expect("create room");
            let room_code = RoomCode::parse(&room.room_code).expect("room code");
            let request_id = RequestId::parse("join_1").expect("request id");
            state
                .services
                .request_join(
                    &receiver,
                    &room_code,
                    &request_id,
                    Some(Revision::new(1)),
                    None,
                )
                .await
                .expect("request join");
            state
                .services
                .decide_join(
                    &owner,
                    &room_code,
                    &request_id,
                    JoinDecision::Approve,
                    Some(Revision::new(2)),
                )
                .await
                .expect("approve join");

            let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
                .await
                .expect("bind test server");
            let address = listener.local_addr().expect("test server address");
            let (shutdown, shutdown_receiver) = oneshot::channel();
            let router = app(&directory, state.clone()).expect("assemble test web shell");
            let task = tokio::spawn(async move {
                axum::serve(listener, router)
                    .with_graceful_shutdown(async {
                        let _ = shutdown_receiver.await;
                    })
                    .await
            });
            Self {
                state,
                directory,
                address,
                shutdown,
                task,
                owner,
                receiver,
                room_code,
            }
        }

        async fn connect(&self, session: &p2p_domain::Session) -> ClientSocket {
            connect_socket(self.address, session.id().as_str(), "http://localhost:3410")
                .await
                .expect("connect websocket")
        }

        async fn finish(self) {
            let _ = self.shutdown.send(());
            self.task
                .await
                .expect("join test server")
                .expect("stop test server");
            self.state.services.storage.close().await;
            std::fs::remove_dir_all(self.directory).expect("remove test directory");
        }
    }

    async fn connect_socket(
        address: SocketAddr,
        session_id: &str,
        origin: &str,
    ) -> Result<ClientSocket, WebSocketError> {
        let mut request = format!("ws://{address}/realtime")
            .into_client_request()
            .expect("websocket request");
        request.headers_mut().insert(
            header::ORIGIN,
            HeaderValue::from_str(origin).expect("origin header"),
        );
        request.headers_mut().insert(
            header::COOKIE,
            HeaderValue::from_str(&format!("{SESSION_COOKIE_NAME}={session_id}"))
                .expect("cookie header"),
        );
        connect_async(request).await.map(|(socket, _)| socket)
    }

    async fn send_message(socket: &mut ClientSocket, message: ClientRealtimeMessage) {
        let json = serde_json::to_string(&message).expect("serialize client message");
        socket
            .send(ClientFrame::Text(json.into()))
            .await
            .expect("send websocket message");
    }

    async fn wait_for_message(
        socket: &mut ClientSocket,
        predicate: impl Fn(&ServerRealtimeMessage) -> bool,
    ) -> ServerRealtimeMessage {
        timeout(Duration::from_secs(3), async {
            loop {
                match socket.next().await.expect("websocket remains open") {
                    Ok(ClientFrame::Text(text)) => {
                        let message = serde_json::from_str::<ServerRealtimeMessage>(text.as_str())
                            .expect("decode server message");
                        if predicate(&message) {
                            return message;
                        }
                    }
                    Ok(ClientFrame::Ping(payload)) => {
                        socket
                            .send(ClientFrame::Pong(payload))
                            .await
                            .expect("send pong");
                    }
                    Ok(ClientFrame::Close(frame)) => panic!("socket closed early: {frame:?}"),
                    Ok(_) => {}
                    Err(error) => panic!("websocket read failed: {error}"),
                }
            }
        })
        .await
        .expect("timed out waiting for server message")
    }

    fn attach(room_code: &RoomCode, peer_id: &str) -> ClientRealtimeMessage {
        ClientRealtimeMessage::AttachRoom {
            version: CURRENT_PROTOCOL,
            room_code: room_code.to_string(),
            peer_id: peer_id.to_owned(),
            last_revision: None,
        }
    }

    #[tokio::test]
    async fn websocket_attach_reconnect_and_signal_authorization_work_end_to_end() {
        let server = TestServer::start().await;
        let mut owner_socket = server.connect(&server.owner).await;
        send_message(&mut owner_socket, attach(&server.room_code, "peer_owner")).await;
        let owner_attached = wait_for_message(&mut owner_socket, |message| {
            matches!(message, ServerRealtimeMessage::Attached { .. })
        })
        .await;
        assert!(matches!(
            owner_attached,
            ServerRealtimeMessage::Attached { revision: 4, .. }
        ));

        let mut receiver_socket = server.connect(&server.receiver).await;
        send_message(
            &mut receiver_socket,
            attach(&server.room_code, "peer_receiver"),
        )
        .await;
        wait_for_message(&mut receiver_socket, |message| {
            matches!(message, ServerRealtimeMessage::Attached { .. })
        })
        .await;
        let receiver_online = wait_for_message(&mut owner_socket, |message| {
            matches!(
                message,
                ServerRealtimeMessage::PeerOnline { peer_id, .. } if peer_id == "peer_receiver"
            )
        })
        .await;
        assert!(matches!(
            receiver_online,
            ServerRealtimeMessage::PeerOnline { revision: 5, .. }
        ));

        send_message(
            &mut receiver_socket,
            ClientRealtimeMessage::Signal {
                version: CURRENT_PROTOCOL,
                room_code: server.room_code.to_string(),
                to_peer_id: "peer_owner".to_owned(),
                negotiation_id: "neg_offer_1".to_owned(),
                signal: Signal::Offer {
                    sdp: "v=0\r\n".to_owned(),
                },
            },
        )
        .await;
        let signal = wait_for_message(&mut owner_socket, |message| {
            matches!(message, ServerRealtimeMessage::Signal { .. })
        })
        .await;
        assert!(matches!(
            signal,
            ServerRealtimeMessage::Signal {
                from_peer_id,
                negotiation_id,
                ..
            } if from_peer_id == "peer_receiver" && negotiation_id == "neg_offer_1"
        ));

        send_message(
            &mut receiver_socket,
            ClientRealtimeMessage::Signal {
                version: CURRENT_PROTOCOL,
                room_code: server.room_code.to_string(),
                to_peer_id: "peer_missing".to_owned(),
                negotiation_id: "neg_offer_2".to_owned(),
                signal: Signal::Offer {
                    sdp: "v=0\r\n".to_owned(),
                },
            },
        )
        .await;
        let forbidden = wait_for_message(&mut receiver_socket, |message| {
            matches!(
                message,
                ServerRealtimeMessage::Error { code, .. } if code == "signal_forbidden"
            )
        })
        .await;
        assert!(matches!(forbidden, ServerRealtimeMessage::Error { .. }));

        let mut replacement = server.connect(&server.receiver).await;
        send_message(
            &mut replacement,
            attach(&server.room_code, "peer_receiver_new"),
        )
        .await;
        wait_for_message(&mut replacement, |message| {
            matches!(message, ServerRealtimeMessage::Attached { .. })
        })
        .await;
        let replaced = wait_for_message(&mut receiver_socket, |message| {
            matches!(
                message,
                ServerRealtimeMessage::Error { code, .. } if code == "connection_replaced"
            )
        })
        .await;
        assert!(matches!(replaced, ServerRealtimeMessage::Error { .. }));

        let room = server
            .state
            .services
            .storage
            .find_room_by_code(&server.room_code)
            .await
            .expect("load room")
            .expect("room exists");
        assert_eq!(
            room.membership_state(server.receiver.id()),
            Some(&MembershipState::Online {
                peer_id: PeerId::parse("peer_receiver_new").expect("peer id")
            })
        );

        replacement.close(None).await.expect("close replacement");
        for _ in 0..50 {
            let room = server
                .state
                .services
                .storage
                .find_room_by_code(&server.room_code)
                .await
                .expect("load room")
                .expect("room exists");
            if room.membership_state(server.receiver.id()) == Some(&MembershipState::Offline) {
                break;
            }
            sleep(Duration::from_millis(20)).await;
        }
        let room = server
            .state
            .services
            .storage
            .find_room_by_code(&server.room_code)
            .await
            .expect("load room")
            .expect("room exists");
        assert_eq!(
            room.membership_state(server.receiver.id()),
            Some(&MembershipState::Offline)
        );

        owner_socket.close(None).await.expect("close owner");
        server.finish().await;
    }

    #[tokio::test]
    async fn websocket_handshake_and_first_frame_require_security_context() {
        let server = TestServer::start().await;
        let foreign = connect_socket(
            server.address,
            server.owner.id().as_str(),
            "https://evil.example",
        )
        .await;
        assert!(matches!(
            foreign,
            Err(WebSocketError::Http(response)) if response.status() == axum::http::StatusCode::FORBIDDEN
        ));

        let mut socket = server.connect(&server.owner).await;
        send_message(
            &mut socket,
            ClientRealtimeMessage::Heartbeat {
                version: CURRENT_PROTOCOL,
                nonce: "heartbeat_1".to_owned(),
            },
        )
        .await;
        let error = wait_for_message(&mut socket, |message| {
            matches!(
                message,
                ServerRealtimeMessage::Error { code, .. } if code == "attach_required"
            )
        })
        .await;
        assert!(matches!(error, ServerRealtimeMessage::Error { .. }));
        server.finish().await;
    }

    #[tokio::test]
    async fn http_join_commands_are_pushed_to_the_attached_owner() {
        let server = TestServer::start().await;
        let mut owner_socket = server.connect(&server.owner).await;
        send_message(&mut owner_socket, attach(&server.room_code, "peer_owner")).await;
        wait_for_message(&mut owner_socket, |message| {
            matches!(message, ServerRealtimeMessage::Attached { .. })
        })
        .await;

        let pending = server
            .state
            .services
            .create_or_restore_session(None, "Pending")
            .await
            .expect("create pending session");
        let router = app(&server.directory, server.state.clone()).expect("assemble test web shell");
        let joined = router
            .clone()
            .oneshot(
                Request::post(format!("/api/rooms/{}/join-requests", server.room_code))
                    .header(header::CONTENT_TYPE, "application/json")
                    .header(header::ORIGIN, "http://localhost:3410")
                    .header(
                        header::COOKIE,
                        format!("{SESSION_COOKIE_NAME}={}", pending.id()),
                    )
                    .body(Body::from(
                        json!({
                            "version": { "major": 5, "minor": 1 },
                            "request_id": "join_event_1",
                            "room_code": server.room_code.to_string(),
                            "expected_revision": 4
                        })
                        .to_string(),
                    ))
                    .expect("join request"),
            )
            .await
            .expect("join response");
        assert_eq!(joined.status(), StatusCode::CREATED);
        let requested = wait_for_message(&mut owner_socket, |message| {
            matches!(
                message,
                ServerRealtimeMessage::JoinRequested { request, .. }
                    if request.request_id == "join_event_1"
            )
        })
        .await;
        assert!(matches!(
            requested,
            ServerRealtimeMessage::JoinRequested { revision: 5, .. }
        ));

        let mut pending_socket = server.connect(&pending).await;
        send_message(
            &mut pending_socket,
            ClientRealtimeMessage::WatchJoinRequest {
                version: CURRENT_PROTOCOL,
                room_code: server.room_code.to_string(),
                request_id: "join_event_1".to_owned(),
                last_revision: Some(5),
            },
        )
        .await;
        let watching = wait_for_message(&mut pending_socket, |message| {
            matches!(
                message,
                ServerRealtimeMessage::JoinWatching { request_id, .. }
                    if request_id == "join_event_1"
            )
        })
        .await;
        assert!(matches!(
            watching,
            ServerRealtimeMessage::JoinWatching { revision: 5, .. }
        ));

        let decided = router
            .oneshot(
                Request::post(format!(
                    "/api/rooms/{}/join-requests/join_event_1/decision",
                    server.room_code
                ))
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::ORIGIN, "http://localhost:3410")
                .header(
                    header::COOKIE,
                    format!("{SESSION_COOKIE_NAME}={}", server.owner.id()),
                )
                .body(Body::from(
                    json!({
                        "version": { "major": 5, "minor": 1 },
                        "request_id": "join_event_1",
                        "decision": "reject",
                        "expected_revision": 5
                    })
                    .to_string(),
                ))
                .expect("decision request"),
            )
            .await
            .expect("decision response");
        assert_eq!(decided.status(), StatusCode::OK);
        let decision = wait_for_message(&mut owner_socket, |message| {
            matches!(
                message,
                ServerRealtimeMessage::JoinDecided { request_id, .. }
                    if request_id == "join_event_1"
            )
        })
        .await;
        assert!(matches!(
            decision,
            ServerRealtimeMessage::JoinDecided { revision: 6, .. }
        ));
        let pending_decision = wait_for_message(&mut pending_socket, |message| {
            matches!(
                message,
                ServerRealtimeMessage::JoinDecided { request_id, .. }
                    if request_id == "join_event_1"
            )
        })
        .await;
        assert!(matches!(
            pending_decision,
            ServerRealtimeMessage::JoinDecided { revision: 6, .. }
        ));

        pending_socket.close(None).await.expect("close pending");
        owner_socket.close(None).await.expect("close owner");
        server.finish().await;
    }
}
