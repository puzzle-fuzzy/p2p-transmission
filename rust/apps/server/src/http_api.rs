use std::{net::SocketAddr, sync::Arc};

use axum::{
    Json, Router,
    body::Bytes,
    extract::{ConnectInfo, FromRequestParts, Path, State, rejection::BytesRejection},
    http::{HeaderMap, StatusCode, header, request::Parts},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use axum_extra::extract::{
    CookieJar,
    cookie::{Cookie, SameSite},
};
use p2p_domain::{JoinDecision, RequestId, Revision, RoomCode, RoomError, RoomId, RoomState};
use p2p_protocol::{
    ApiErrorBody, ApiErrorCode, CreateInviteRequest, CreateRoomRequest, CreateSessionRequest,
    DecideJoinRequest, ErrorEnvelope, JoinDecisionRequest, JoinDecisionWire, JoinRequestSnapshot,
    LeaveRoomRequest, MAX_HTTP_BODY_BYTES, RequestJoinRequest, ServerRealtimeMessage,
    parse_http_body,
};
use time::Duration as CookieDuration;
use tracing::error;

use crate::{
    realtime::hub::RealtimeHub,
    realtime::socket::{cleanup_attachments, event_id},
    services::{AppServices, ServiceError, room_mutation_response, session_response},
    storage::StorageError,
};

pub const SESSION_COOKIE_NAME: &str = "p2p_session";

struct ClientAddress(Option<SocketAddr>);

impl<S> FromRequestParts<S> for ClientAddress
where
    S: Send + Sync,
{
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        Ok(Self(
            parts
                .extensions
                .get::<ConnectInfo<SocketAddr>>()
                .map(|ConnectInfo(address)| *address),
        ))
    }
}

#[derive(Clone, Debug)]
pub struct AppState {
    pub services: Arc<AppServices>,
    pub hub: RealtimeHub,
}

impl AppState {
    pub fn new(services: AppServices) -> Self {
        let hub = RealtimeHub::new(services.config.outbound_queue_capacity);
        Self {
            services: Arc::new(services),
            hub,
        }
    }
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/session", post(create_session))
        .route("/rooms", post(create_room))
        .route("/rooms/{code}/invite-capabilities", post(create_invite))
        .route("/rooms/{code}/bootstrap", get(bootstrap_room))
        .route("/rooms/{code}/join-requests", post(request_join))
        .route(
            "/rooms/{code}/join-requests/{request_id}",
            get(join_request_status),
        )
        .route(
            "/rooms/{code}/join-requests/{request_id}/decision",
            post(decide_join),
        )
        .route("/rooms/{code}/leave", post(leave_room))
        .route("/rtc/config", get(rtc_config))
        .layer(axum::extract::DefaultBodyLimit::max(MAX_HTTP_BODY_BYTES))
}

pub async fn ready(
    State(state): State<AppState>,
) -> Result<Json<p2p_protocol::HealthResponse>, HttpError> {
    state
        .services
        .storage
        .ready()
        .await
        .map_err(ServiceError::from)
        .map_err(HttpError::from)?;
    Ok(Json(p2p_protocol::HealthResponse::ready(
        "p2p-server",
        env!("CARGO_PKG_VERSION"),
    )))
}

async fn create_session(
    State(state): State<AppState>,
    jar: CookieJar,
    ClientAddress(client_address): ClientAddress,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Result<Response, HttpError> {
    require_mutation_headers(&state, &headers)?;
    let body = limited_body(body)?;
    let now = state.services.now().map_err(HttpError::from)?;
    let client_key = client_address
        .map(|address| address.ip().to_string())
        .unwrap_or_else(|| "unknown".to_owned());
    if !state
        .services
        .limiter
        .check(
            "session",
            &client_key,
            state.services.config.session_rate,
            now.value(),
        )
        .await
    {
        return Err(HttpError::rate_limited(None));
    }

    let request: CreateSessionRequest = parse_http_body(&body)?;
    let existing = jar
        .get(SESSION_COOKIE_NAME)
        .map(|cookie| cookie.value().to_owned());
    let session = state
        .services
        .create_or_restore_session(existing.as_deref(), &request.display_name)
        .await?;
    let cookie = session_cookie(
        session.id().as_str(),
        session.expires_at().value().saturating_sub(now.value()),
        state.services.config.secure_cookies,
    )?;
    let jar = jar.add(cookie);
    Ok((StatusCode::CREATED, jar, Json(session_response(&session))).into_response())
}

async fn create_room(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Result<Response, HttpError> {
    require_mutation_headers(&state, &headers)?;
    let body = limited_body(body)?;
    let request: CreateRoomRequest = parse_http_body(&body)?;
    let session = authenticate(&state, &jar).await?;
    let now = state.services.now()?;
    if !state
        .services
        .limiter
        .check(
            "room",
            session.id().as_str(),
            state.services.config.room_rate,
            now.value(),
        )
        .await
    {
        return Err(HttpError::rate_limited(Some(request.request_id)));
    }
    let response = state
        .services
        .create_room(&session, &request.request_id)
        .await
        .map_err(|error| HttpError::with_request(error, Some(request.request_id)))?;
    Ok((StatusCode::CREATED, Json(response)).into_response())
}

async fn bootstrap_room(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(code): Path<String>,
) -> Result<Response, HttpError> {
    let session = authenticate(&state, &jar).await?;
    let code = parse_room_code(&code)?;
    let response = state.services.bootstrap_room(&session, &code).await?;
    Ok(Json(response).into_response())
}

async fn request_join(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(code): Path<String>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Result<Response, HttpError> {
    require_mutation_headers(&state, &headers)?;
    let body = limited_body(body)?;
    let request: RequestJoinRequest = parse_http_body(&body)?;
    let session = authenticate(&state, &jar).await?;
    let code = parse_room_code(&code)?;
    let body_code = parse_room_code(&request.room_code)?;
    if body_code != code {
        return Err(HttpError::invalid_request(
            "room code in path and body must match",
            Some(request.request_id),
        ));
    }
    let request_id = parse_request_id(&request.request_id)?;
    let now = state.services.now()?;
    if !state
        .services
        .limiter
        .check(
            "join",
            &format!("{}:{code}", session.id()),
            state.services.config.join_rate,
            now.value(),
        )
        .await
    {
        return Err(HttpError::rate_limited(Some(request.request_id)));
    }
    let response = state
        .services
        .request_join(
            &session,
            &code,
            &request_id,
            request.expected_revision.map(Revision::new),
            request.invite_capability.as_deref(),
        )
        .await
        .map_err(|error| HttpError::with_request(error, Some(request.request_id)))?;
    let room_id = parse_generated_room_id(&response.room_id)?;
    let evicted = state
        .hub
        .broadcast(
            &room_id,
            ServerRealtimeMessage::JoinRequested {
                version: p2p_protocol::CURRENT_PROTOCOL,
                event_id: event_id(),
                revision: response.revision,
                request: JoinRequestSnapshot {
                    request_id: response.request_id.clone(),
                    session_id: session.id().to_string(),
                    display_name: session.display_name().as_str().to_owned(),
                    expires_at_ms: response.expires_at_ms,
                },
            },
        )
        .await;
    cleanup_attachments(&state, evicted).await;
    Ok((StatusCode::CREATED, Json(response)).into_response())
}

async fn create_invite(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(code): Path<String>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Result<Response, HttpError> {
    require_mutation_headers(&state, &headers)?;
    let body = limited_body(body)?;
    let request: CreateInviteRequest = parse_http_body(&body)?;
    let session = authenticate(&state, &jar).await?;
    let code = parse_room_code(&code)?;
    let request_id = parse_request_id(&request.request_id)?;
    let response = state
        .services
        .create_invite(&session, &code, &request_id)
        .await
        .map_err(|error| HttpError::with_request(error, Some(request.request_id)))?;
    Ok((StatusCode::CREATED, Json(response)).into_response())
}

async fn join_request_status(
    State(state): State<AppState>,
    jar: CookieJar,
    Path((code, request_id)): Path<(String, String)>,
) -> Result<Response, HttpError> {
    let session = authenticate(&state, &jar).await?;
    let code = parse_room_code(&code)?;
    let request_id = parse_request_id(&request_id)?;
    Ok(Json(
        state
            .services
            .join_request_status(&session, &code, &request_id)
            .await?,
    )
    .into_response())
}

async fn decide_join(
    State(state): State<AppState>,
    jar: CookieJar,
    Path((code, path_request_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Result<Response, HttpError> {
    require_mutation_headers(&state, &headers)?;
    let body = limited_body(body)?;
    let request: DecideJoinRequest = parse_http_body(&body)?;
    if request.request_id != path_request_id {
        return Err(HttpError::invalid_request(
            "join request id in path and body must match",
            Some(request.request_id),
        ));
    }
    let session = authenticate(&state, &jar).await?;
    let code = parse_room_code(&code)?;
    let request_id = parse_request_id(&request.request_id)?;
    let (decision, wire_decision) = match request.decision {
        JoinDecisionRequest::Approve => (JoinDecision::Approve, JoinDecisionWire::Approved),
        JoinDecisionRequest::Reject => (JoinDecision::Reject, JoinDecisionWire::Rejected),
    };
    let mutation = state
        .services
        .decide_join(
            &session,
            &code,
            &request_id,
            decision,
            request.expected_revision.map(Revision::new),
        )
        .await
        .map_err(|error| HttpError::with_request(error, Some(request.request_id)))?;
    let evicted = state
        .hub
        .broadcast(
            mutation.room.id(),
            ServerRealtimeMessage::JoinDecided {
                version: p2p_protocol::CURRENT_PROTOCOL,
                event_id: event_id(),
                revision: mutation.room.revision().value(),
                request_id: request_id.to_string(),
                decision: wire_decision,
            },
        )
        .await;
    cleanup_attachments(&state, evicted).await;
    Ok(Json(room_mutation_response(&mutation)).into_response())
}

async fn leave_room(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(code): Path<String>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Result<Response, HttpError> {
    require_mutation_headers(&state, &headers)?;
    let body = limited_body(body)?;
    let request: LeaveRoomRequest = parse_http_body(&body)?;
    let session = authenticate(&state, &jar).await?;
    let code = parse_room_code(&code)?;
    let mutation = state
        .services
        .leave_room(
            &session,
            &code,
            request.expected_revision.map(Revision::new),
        )
        .await
        .map_err(|error| HttpError::with_request(error, Some(request.request_id)))?;
    let message = if mutation.room.state() == RoomState::Expired {
        ServerRealtimeMessage::RoomExpired {
            version: p2p_protocol::CURRENT_PROTOCOL,
            event_id: event_id(),
            revision: mutation.room.revision().value(),
        }
    } else {
        ServerRealtimeMessage::PeerOffline {
            version: p2p_protocol::CURRENT_PROTOCOL,
            event_id: event_id(),
            revision: mutation.room.revision().value(),
            session_id: session.id().to_string(),
        }
    };
    let mut cleanup = state.hub.broadcast(mutation.room.id(), message).await;
    if mutation.room.state() == RoomState::Expired {
        cleanup.extend(
            state
                .hub
                .disconnect_room(mutation.room.id(), 4002, "room expired")
                .await,
        );
    } else {
        cleanup.extend(
            state
                .hub
                .disconnect_session(
                    mutation.room.id(),
                    session.id(),
                    4003,
                    "room membership ended",
                )
                .await,
        );
    }
    cleanup_attachments(&state, cleanup).await;
    Ok(Json(room_mutation_response(&mutation)).into_response())
}

async fn rtc_config(State(state): State<AppState>, jar: CookieJar) -> Result<Response, HttpError> {
    let session = authenticate(&state, &jar).await?;
    Ok(Json(state.services.rtc_config(&session)?).into_response())
}

pub(crate) async fn authenticate(
    state: &AppState,
    jar: &CookieJar,
) -> Result<p2p_domain::Session, HttpError> {
    let session_id = jar
        .get(SESSION_COOKIE_NAME)
        .map(|cookie| cookie.value().to_owned());
    state
        .services
        .authenticate(session_id.as_deref())
        .await
        .map_err(Into::into)
}

fn require_mutation_headers(state: &AppState, headers: &HeaderMap) -> Result<(), HttpError> {
    require_origin(state, headers)?;
    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if !content_type
        .split(';')
        .next()
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("application/json"))
    {
        return Err(HttpError::invalid_request(
            "content-type must be application/json",
            None,
        ));
    }
    Ok(())
}

pub(crate) fn require_origin(state: &AppState, headers: &HeaderMap) -> Result<(), HttpError> {
    let origin = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(HttpError::forbidden)?;
    if state.services.config.allows_origin(origin)
        || allows_null_same_origin(state, headers, origin)
    {
        return Ok(());
    }
    Err(HttpError::forbidden())
}

fn allows_null_same_origin(state: &AppState, headers: &HeaderMap, origin: &str) -> bool {
    if origin != "null" {
        return false;
    }
    let header_is = |name: &'static str, expected: &'static str| {
        headers
            .get(name)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.eq_ignore_ascii_case(expected))
    };
    if !header_is("sec-fetch-site", "same-origin")
        || !header_is("sec-fetch-mode", "same-origin")
        || !header_is("sec-fetch-dest", "empty")
    {
        return false;
    }
    let Some(authority) = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    state.services.config.allows_authority(authority)
}

fn limited_body(body: Result<Bytes, BytesRejection>) -> Result<Bytes, HttpError> {
    body.map_err(|_| HttpError::invalid_request("request body exceeds the allowed size", None))
}

fn parse_room_code(value: &str) -> Result<RoomCode, HttpError> {
    RoomCode::parse(value).map_err(|_| HttpError::invalid_request("room code is invalid", None))
}

fn parse_request_id(value: &str) -> Result<RequestId, HttpError> {
    RequestId::parse(value)
        .map_err(|_| HttpError::invalid_request("request id is invalid", Some(value.to_owned())))
}

fn parse_generated_room_id(value: &str) -> Result<RoomId, HttpError> {
    RoomId::parse(value)
        .map_err(|_| HttpError::internal("service generated an invalid room identifier"))
}

fn session_cookie(
    session_id: &str,
    max_age_ms: u64,
    secure: bool,
) -> Result<Cookie<'static>, HttpError> {
    let max_age_ms = i64::try_from(max_age_ms)
        .map_err(|_| HttpError::internal("session cookie expiry is outside the supported range"))?;
    Ok(Cookie::build((SESSION_COOKIE_NAME, session_id.to_owned()))
        .path("/")
        .http_only(true)
        .same_site(SameSite::Lax)
        .secure(secure)
        .max_age(CookieDuration::milliseconds(max_age_ms))
        .build())
}

#[derive(Debug)]
pub struct HttpError {
    status: StatusCode,
    code: ApiErrorCode,
    message: &'static str,
    request_id: Option<String>,
    retryable: bool,
}

impl HttpError {
    fn invalid_request(message: &'static str, request_id: Option<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            code: ApiErrorCode::InvalidRequest,
            message,
            request_id,
            retryable: false,
        }
    }

    fn forbidden() -> Self {
        Self {
            status: StatusCode::FORBIDDEN,
            code: ApiErrorCode::Forbidden,
            message: "request origin is not allowed",
            request_id: None,
            retryable: false,
        }
    }

    fn rate_limited(request_id: Option<String>) -> Self {
        Self {
            status: StatusCode::TOO_MANY_REQUESTS,
            code: ApiErrorCode::RateLimited,
            message: "request rate limit exceeded",
            request_id,
            retryable: true,
        }
    }

    fn internal(message: &'static str) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: ApiErrorCode::Internal,
            message,
            request_id: None,
            retryable: false,
        }
    }

    fn with_request(error: ServiceError, request_id: Option<String>) -> Self {
        let mut response = Self::from(error);
        response.request_id = request_id;
        response
    }
}

impl From<p2p_protocol::ProtocolError> for HttpError {
    fn from(_: p2p_protocol::ProtocolError) -> Self {
        Self::invalid_request("request body is invalid", None)
    }
}

impl From<p2p_domain::time::TimeError> for HttpError {
    fn from(error: p2p_domain::time::TimeError) -> Self {
        Self::from(ServiceError::from(error))
    }
}

impl From<ServiceError> for HttpError {
    fn from(error: ServiceError) -> Self {
        match &error {
            ServiceError::Unauthorized => Self {
                status: StatusCode::UNAUTHORIZED,
                code: ApiErrorCode::Unauthorized,
                message: "session is missing or expired",
                request_id: None,
                retryable: false,
            },
            ServiceError::Forbidden
            | ServiceError::Storage(StorageError::Room(RoomError::Unauthorized)) => Self {
                status: StatusCode::FORBIDDEN,
                code: ApiErrorCode::Forbidden,
                message: "operation is not allowed",
                request_id: None,
                retryable: false,
            },
            ServiceError::NotFound
            | ServiceError::Storage(StorageError::RoomNotFound)
            | ServiceError::Storage(StorageError::Room(RoomError::RequestNotFound)) => Self {
                status: StatusCode::NOT_FOUND,
                code: ApiErrorCode::NotFound,
                message: "resource does not exist",
                request_id: None,
                retryable: false,
            },
            ServiceError::Storage(StorageError::RevisionConflict { .. })
            | ServiceError::Storage(StorageError::UniqueConflict)
            | ServiceError::Storage(StorageError::Room(
                RoomError::IdempotencyConflict
                | RoomError::AlreadyMember
                | RoomError::PendingRequestExists
                | RoomError::TerminalRequest
                | RoomError::MembershipLeft,
            )) => Self {
                status: StatusCode::CONFLICT,
                code: ApiErrorCode::Conflict,
                message: "request conflicts with current room state",
                request_id: None,
                retryable: false,
            },
            ServiceError::Storage(StorageError::Room(
                RoomError::Inactive | RoomError::RequestExpired,
            ))
            | ServiceError::Session(p2p_domain::SessionError::Expired) => Self {
                status: StatusCode::CONFLICT,
                code: ApiErrorCode::Conflict,
                message: "session or room has expired",
                request_id: None,
                retryable: false,
            },
            ServiceError::Id(_)
            | ServiceError::RoomCode(_)
            | ServiceError::DisplayName(_)
            | ServiceError::Room(RoomError::InvalidExpiry | RoomError::InvalidRequestExpiry) => {
                Self::invalid_request("request contains an invalid value", None)
            }
            _ => {
                error!(error = %error, "request failed at internal boundary");
                Self::internal("service is temporarily unavailable")
            }
        }
    }
}

impl IntoResponse for HttpError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(ErrorEnvelope {
                error: ApiErrorBody {
                    code: self.code,
                    message: self.message.to_owned(),
                    request_id: self.request_id,
                    retryable: self.retryable,
                },
            }),
        )
            .into_response()
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use axum::{
        body::Body,
        http::{HeaderValue, Request, header},
    };
    use http_body_util::BodyExt;
    use p2p_protocol::{
        CreateInviteResponse, CreateRoomResponse, JoinRequestResponse, RoomBootstrapResponse,
        RoomMutationResponse, SessionResponse,
    };
    use serde::de::DeserializeOwned;
    use serde_json::{Value, json};
    use tower::ServiceExt;
    use uuid::Uuid;

    use super::*;

    use crate::{app, config::AppConfig, services::AppServices, storage::Storage};

    struct TestApp {
        router: Router,
        state: AppState,
        directory: PathBuf,
    }

    impl TestApp {
        async fn create(secure_cookies: bool) -> Self {
            let directory = std::env::temp_dir().join(format!("p2p-http-{}", Uuid::new_v4()));
            std::fs::create_dir_all(&directory).expect("create test directory");
            std::fs::write(directory.join("index.html"), "<main>test</main>")
                .expect("write test index");
            let config = AppConfig {
                database_path: directory.join("control.sqlite3"),
                secure_cookies,
                ..AppConfig::default()
            };
            let storage = Storage::connect(&config.database_path)
                .await
                .expect("connect test storage");
            let state = AppState::new(AppServices::new(storage, config));
            let router = app(&directory, state.clone());
            Self {
                router,
                state,
                directory,
            }
        }

        async fn cleanup(self) {
            drop(self.router);
            self.state.services.storage.close().await;
            std::fs::remove_dir_all(self.directory).expect("remove test directory");
        }
    }

    fn json_request(
        method: &'static str,
        uri: &str,
        value: Value,
        cookie: Option<&str>,
        origin: Option<&str>,
    ) -> Request<Body> {
        let mut builder = Request::builder()
            .method(method)
            .uri(uri)
            .header(header::CONTENT_TYPE, "application/json");
        if let Some(cookie) = cookie {
            builder = builder.header(header::COOKIE, cookie);
        }
        if let Some(origin) = origin {
            builder = builder.header(header::ORIGIN, origin);
        }
        builder
            .body(Body::from(value.to_string()))
            .expect("build JSON request")
    }

    fn get_request(uri: &str, cookie: Option<&str>) -> Request<Body> {
        let mut builder = Request::get(uri);
        if let Some(cookie) = cookie {
            builder = builder.header(header::COOKIE, cookie);
        }
        builder.body(Body::empty()).expect("build GET request")
    }

    fn with_fetch_metadata(
        mut request: Request<Body>,
        authority: &str,
        site: &'static str,
    ) -> Request<Body> {
        request.headers_mut().insert(
            header::HOST,
            HeaderValue::from_str(authority).expect("valid authority"),
        );
        request
            .headers_mut()
            .insert("sec-fetch-site", HeaderValue::from_static(site));
        request
            .headers_mut()
            .insert("sec-fetch-mode", HeaderValue::from_static("same-origin"));
        request
            .headers_mut()
            .insert("sec-fetch-dest", HeaderValue::from_static("empty"));
        request
    }

    async fn response_json<T: DeserializeOwned>(response: Response) -> T {
        let body = response
            .into_body()
            .collect()
            .await
            .expect("collect response body")
            .to_bytes();
        serde_json::from_slice(&body).expect("decode JSON response")
    }

    fn cookie_pair(response: &Response) -> String {
        response
            .headers()
            .get(header::SET_COOKIE)
            .expect("set-cookie header")
            .to_str()
            .expect("set-cookie text")
            .split(';')
            .next()
            .expect("cookie pair")
            .to_owned()
    }

    async fn create_session_for(app: &TestApp, display_name: &str) -> (String, SessionResponse) {
        let response = app
            .router
            .clone()
            .oneshot(json_request(
                "POST",
                "/api/session",
                json!({
                    "version": { "major": 2, "minor": 0 },
                    "display_name": display_name
                }),
                None,
                Some("http://localhost:3410"),
            ))
            .await
            .expect("create session response");
        assert_eq!(response.status(), StatusCode::CREATED);
        let cookie = cookie_pair(&response);
        let body = response_json(response).await;
        (cookie, body)
    }

    #[tokio::test]
    async fn mutation_origin_and_cookie_flags_are_enforced() {
        let app = TestApp::create(true).await;
        let body = json!({
            "version": { "major": 2, "minor": 0 },
            "display_name": "Owner"
        });

        let missing_origin = app
            .router
            .clone()
            .oneshot(json_request(
                "POST",
                "/api/session",
                body.clone(),
                None,
                None,
            ))
            .await
            .expect("missing origin response");
        assert_eq!(missing_origin.status(), StatusCode::FORBIDDEN);

        let foreign_origin = app
            .router
            .clone()
            .oneshot(json_request(
                "POST",
                "/api/session",
                body.clone(),
                None,
                Some("https://evil.example"),
            ))
            .await
            .expect("foreign origin response");
        assert_eq!(foreign_origin.status(), StatusCode::FORBIDDEN);

        let null_without_metadata = app
            .router
            .clone()
            .oneshot(json_request(
                "POST",
                "/api/session",
                body.clone(),
                None,
                Some("null"),
            ))
            .await
            .expect("null origin response");
        assert_eq!(null_without_metadata.status(), StatusCode::FORBIDDEN);

        let null_cross_site = app
            .router
            .clone()
            .oneshot(with_fetch_metadata(
                json_request("POST", "/api/session", body.clone(), None, Some("null")),
                "localhost:3410",
                "cross-site",
            ))
            .await
            .expect("cross-site null origin response");
        assert_eq!(null_cross_site.status(), StatusCode::FORBIDDEN);

        let null_foreign_authority = app
            .router
            .clone()
            .oneshot(with_fetch_metadata(
                json_request("POST", "/api/session", body.clone(), None, Some("null")),
                "evil.example",
                "same-origin",
            ))
            .await
            .expect("foreign-authority null origin response");
        assert_eq!(null_foreign_authority.status(), StatusCode::FORBIDDEN);

        let null_same_origin = app
            .router
            .clone()
            .oneshot(with_fetch_metadata(
                json_request("POST", "/api/session", body.clone(), None, Some("null")),
                "localhost:3410",
                "same-origin",
            ))
            .await
            .expect("same-origin null origin response");
        assert_eq!(null_same_origin.status(), StatusCode::CREATED);

        let allowed = app
            .router
            .clone()
            .oneshot(json_request(
                "POST",
                "/api/session",
                body,
                None,
                Some("http://localhost:3410"),
            ))
            .await
            .expect("allowed origin response");
        assert_eq!(allowed.status(), StatusCode::CREATED);
        let set_cookie = allowed
            .headers()
            .get(header::SET_COOKIE)
            .expect("set-cookie")
            .to_str()
            .expect("set-cookie text");
        assert!(set_cookie.contains("HttpOnly"));
        assert!(set_cookie.contains("SameSite=Lax"));
        assert!(set_cookie.contains("Secure"));
        assert!(set_cookie.contains("Path=/"));
        app.cleanup().await;
    }

    #[tokio::test]
    async fn room_join_decision_and_bootstrap_flow_is_persisted() {
        let app = TestApp::create(false).await;
        let (owner_cookie, owner) = create_session_for(&app, "Owner").await;
        assert_eq!(owner.display_name, "Owner");

        let create_body = json!({
            "version": { "major": 2, "minor": 0 },
            "request_id": "create_1"
        });
        let created = app
            .router
            .clone()
            .oneshot(json_request(
                "POST",
                "/api/rooms",
                create_body.clone(),
                Some(&owner_cookie),
                Some("http://localhost:3410"),
            ))
            .await
            .expect("create room response");
        assert_eq!(created.status(), StatusCode::CREATED);
        let room: CreateRoomResponse = response_json(created).await;
        assert_eq!(room.revision, 1);

        let replayed = app
            .router
            .clone()
            .oneshot(json_request(
                "POST",
                "/api/rooms",
                create_body,
                Some(&owner_cookie),
                Some("http://localhost:3410"),
            ))
            .await
            .expect("replay room response");
        let replayed_room: CreateRoomResponse = response_json(replayed).await;
        assert_eq!(replayed_room.room_id, room.room_id);

        let invite_request = json!({
            "version": { "major": 2, "minor": 0 },
            "request_id": "invite_1"
        });
        let invite = app
            .router
            .clone()
            .oneshot(json_request(
                "POST",
                &format!("/api/rooms/{}/invite-capabilities", room.room_code),
                invite_request.clone(),
                Some(&owner_cookie),
                Some("http://localhost:3410"),
            ))
            .await
            .expect("create invite response");
        assert_eq!(invite.status(), StatusCode::CREATED);
        let invite: CreateInviteResponse = response_json(invite).await;
        assert_eq!(invite.capability.len(), 64);
        let invite_replay = app
            .router
            .clone()
            .oneshot(json_request(
                "POST",
                &format!("/api/rooms/{}/invite-capabilities", room.room_code),
                invite_request,
                Some(&owner_cookie),
                Some("http://localhost:3410"),
            ))
            .await
            .expect("replay invite response");
        let invite_replay: CreateInviteResponse = response_json(invite_replay).await;
        assert_eq!(invite_replay, invite);
        let stored_hash: String = sqlx::query_scalar(
            "SELECT lower(hex(capability_hash)) FROM invite_capabilities WHERE request_id = 'invite_1'",
        )
        .fetch_one(app.state.services.storage.pool())
        .await
        .expect("stored capability hash");
        assert_ne!(stored_hash, invite.capability);

        let (receiver_cookie, receiver) = create_session_for(&app, "Receiver").await;
        let invalid_invite = app
            .router
            .clone()
            .oneshot(json_request(
                "POST",
                &format!("/api/rooms/{}/join-requests", room.room_code),
                json!({
                    "version": { "major": 2, "minor": 0 },
                    "request_id": "join_bad",
                    "room_code": room.room_code,
                    "expected_revision": 1,
                    "invite_capability": "0".repeat(64)
                }),
                Some(&receiver_cookie),
                Some("http://localhost:3410"),
            ))
            .await
            .expect("invalid invite response");
        assert_eq!(invalid_invite.status(), StatusCode::FORBIDDEN);
        let joined = app
            .router
            .clone()
            .oneshot(json_request(
                "POST",
                &format!("/api/rooms/{}/join-requests", room.room_code),
                json!({
                    "version": { "major": 2, "minor": 0 },
                    "request_id": "join_1",
                    "room_code": room.room_code,
                    "expected_revision": 1,
                    "invite_capability": invite.capability
                }),
                Some(&receiver_cookie),
                Some("http://localhost:3410"),
            ))
            .await
            .expect("join response");
        assert_eq!(joined.status(), StatusCode::CREATED);
        let joined: JoinRequestResponse = response_json(joined).await;
        assert_eq!(joined.revision, 2);
        let join_status = app
            .router
            .clone()
            .oneshot(get_request(
                &format!("/api/rooms/{}/join-requests/join_1", room.room_code),
                Some(&receiver_cookie),
            ))
            .await
            .expect("join status response");
        assert_eq!(join_status.status(), StatusCode::OK);
        let join_status: JoinRequestResponse = response_json(join_status).await;
        assert_eq!(
            join_status.state,
            p2p_protocol::JoinRequestStateWire::Pending
        );

        let owner_snapshot = app
            .router
            .clone()
            .oneshot(get_request(
                &format!("/api/rooms/{}/bootstrap", room.room_code),
                Some(&owner_cookie),
            ))
            .await
            .expect("owner bootstrap");
        let owner_snapshot: RoomBootstrapResponse = response_json(owner_snapshot).await;
        assert_eq!(owner_snapshot.pending_join_requests.len(), 1);
        assert_eq!(
            owner_snapshot.pending_join_requests[0].display_name,
            "Receiver"
        );

        let approved = app
            .router
            .clone()
            .oneshot(json_request(
                "POST",
                &format!(
                    "/api/rooms/{}/join-requests/join_1/decision",
                    room.room_code
                ),
                json!({
                    "version": { "major": 2, "minor": 0 },
                    "request_id": "join_1",
                    "decision": "approve",
                    "expected_revision": 2
                }),
                Some(&owner_cookie),
                Some("http://localhost:3410"),
            ))
            .await
            .expect("approve response");
        assert_eq!(approved.status(), StatusCode::OK);
        let approved: RoomMutationResponse = response_json(approved).await;
        assert_eq!(approved.revision, 3);

        let receiver_snapshot = app
            .router
            .clone()
            .oneshot(get_request(
                &format!("/api/rooms/{}/bootstrap", room.room_code),
                Some(&receiver_cookie),
            ))
            .await
            .expect("receiver bootstrap");
        assert_eq!(receiver_snapshot.status(), StatusCode::OK);
        let receiver_snapshot: RoomBootstrapResponse = response_json(receiver_snapshot).await;
        assert_eq!(receiver_snapshot.participants.len(), 2);
        assert!(
            receiver_snapshot
                .participants
                .iter()
                .any(|participant| participant.session_id == receiver.session_id)
        );

        let stale_leave = app
            .router
            .clone()
            .oneshot(json_request(
                "POST",
                &format!("/api/rooms/{}/leave", room.room_code),
                json!({
                    "version": { "major": 2, "minor": 0 },
                    "request_id": "leave_1",
                    "expected_revision": 2
                }),
                Some(&receiver_cookie),
                Some("http://localhost:3410"),
            ))
            .await
            .expect("stale leave response");
        assert_eq!(stale_leave.status(), StatusCode::CONFLICT);

        let anonymous = app
            .router
            .clone()
            .oneshot(get_request(
                &format!("/api/rooms/{}/bootstrap", room.room_code),
                None,
            ))
            .await
            .expect("anonymous bootstrap");
        assert_eq!(anonymous.status(), StatusCode::UNAUTHORIZED);
        app.cleanup().await;
    }

    #[tokio::test]
    async fn body_limit_rejections_use_the_error_envelope() {
        let app = TestApp::create(false).await;
        let response = app
            .router
            .clone()
            .oneshot(
                Request::post("/api/session")
                    .header(header::CONTENT_TYPE, "application/json")
                    .header(header::ORIGIN, "http://localhost:3410")
                    .body(Body::from("x".repeat(MAX_HTTP_BODY_BYTES + 1)))
                    .expect("oversized request"),
            )
            .await
            .expect("oversized response");
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let error: ErrorEnvelope = response_json(response).await;
        assert_eq!(error.error.code, ApiErrorCode::InvalidRequest);
        app.cleanup().await;
    }
}
