use std::time::{SystemTime, UNIX_EPOCH};

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use hmac::{Hmac, Mac};
use p2p_domain::{
    DisplayName, EpochMillis, JoinDecision, JoinRequestState, MembershipRole, MembershipState,
    RequestId, Revision, Room, RoomCode, RoomCommand, RoomError, RoomId, Session, SessionError,
    SessionId,
};
use p2p_protocol::{
    CURRENT_PROTOCOL, CreateInviteResponse, CreateRoomResponse, IceServer, JoinRequestResponse,
    JoinRequestSnapshot, JoinRequestStateWire, ParticipantRoleWire, ParticipantSnapshot,
    RoomBootstrapResponse, RoomMutationResponse, RtcConfigResponse, SessionResponse,
};
use sha1::Sha1;
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;

use crate::{
    config::AppConfig,
    rate_limit::RateLimiter,
    storage::{RoomMutation, Storage, StorageError},
};

const ROOM_CODE_ALPHABET: &[u8; 32] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ROOM_CODE_ATTEMPTS: usize = 8;

#[derive(Clone, Debug)]
pub struct AppServices {
    pub storage: Storage,
    pub config: AppConfig,
    pub limiter: RateLimiter,
}

impl AppServices {
    pub fn new(storage: Storage, config: AppConfig) -> Self {
        Self {
            storage,
            config,
            limiter: RateLimiter::default(),
        }
    }

    pub fn now(&self) -> Result<EpochMillis, ServiceError> {
        let millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(ServiceError::Clock)?
            .as_millis();
        let millis = u64::try_from(millis).map_err(|_| ServiceError::ClockOverflow)?;
        Ok(EpochMillis::new(millis))
    }

    pub async fn create_or_restore_session(
        &self,
        existing_session_id: Option<&str>,
        display_name: &str,
    ) -> Result<Session, ServiceError> {
        let now = self.now()?;
        if let Some(session) = self.session_from_cookie(existing_session_id, now).await? {
            return Ok(session);
        }

        let display_name = DisplayName::parse(display_name)?;
        let id = SessionId::parse(format!("s_{}", Uuid::new_v4().simple()))?;
        let expires_at = now.checked_add(self.config.session_ttl)?;
        let session = Session::create(id, display_name, now, expires_at)?;
        self.storage.insert_session(&session, now).await?;
        Ok(session)
    }

    pub async fn authenticate(&self, session_id: Option<&str>) -> Result<Session, ServiceError> {
        let now = self.now()?;
        self.session_from_cookie(session_id, now)
            .await?
            .ok_or(ServiceError::Unauthorized)
    }

    pub async fn create_room(
        &self,
        owner: &Session,
        request_id: &str,
    ) -> Result<CreateRoomResponse, ServiceError> {
        let now = self.now()?;
        owner.ensure_active(now)?;
        let request_id = RequestId::parse(request_id)?;

        if let Some(existing) = self
            .storage
            .find_room_by_create_request(owner.id(), &request_id)
            .await?
        {
            return Ok(create_room_response(&existing));
        }

        for _ in 0..ROOM_CODE_ATTEMPTS {
            let room_id = RoomId::parse(format!("r_{}", Uuid::new_v4().simple()))?;
            let code = random_room_code()?;
            let expires_at = now.checked_add(self.config.room_ttl)?;
            let room = Room::create(room_id, code, owner.id().clone(), now, expires_at)?.0;
            match self.storage.insert_room(&room, &request_id, now).await {
                Ok(()) => return Ok(create_room_response(&room)),
                Err(StorageError::UniqueConflict) => {
                    if let Some(existing) = self
                        .storage
                        .find_room_by_create_request(owner.id(), &request_id)
                        .await?
                    {
                        return Ok(create_room_response(&existing));
                    }
                }
                Err(error) => return Err(error.into()),
            }
        }
        Err(ServiceError::RoomCodeExhausted)
    }

    pub async fn request_join(
        &self,
        session: &Session,
        room_code: &RoomCode,
        request_id: &RequestId,
        expected_revision: Option<Revision>,
        invite_capability: Option<&str>,
    ) -> Result<JoinRequestResponse, ServiceError> {
        let now = self.now()?;
        session.ensure_active(now)?;
        let room = self
            .storage
            .find_room_by_code(room_code)
            .await?
            .ok_or(ServiceError::NotFound)?;
        if let Some(capability) = invite_capability {
            let hash = capability_hash(capability);
            if !self
                .storage
                .validate_invite_capability(room.id(), &hash, now)
                .await?
            {
                return Err(ServiceError::Forbidden);
            }
        }
        let requested_expiry = now.checked_add(self.config.join_request_ttl)?;
        let expires_at = EpochMillis::new(requested_expiry.value().min(room.expires_at().value()));
        let mutation = self
            .storage
            .apply_room_command(
                room_code,
                expected_revision,
                RoomCommand::RequestJoin {
                    request_id: request_id.clone(),
                    session_id: session.id().clone(),
                    now,
                    expires_at,
                },
                now,
            )
            .await?;
        let request = mutation
            .room
            .join_request_snapshots()
            .into_iter()
            .find(|request| &request.request_id == request_id)
            .ok_or(ServiceError::Invariant(
                "join request missing after mutation",
            ))?;
        Ok(JoinRequestResponse {
            version: CURRENT_PROTOCOL,
            room_id: mutation.room.id().to_string(),
            request_id: request.request_id.to_string(),
            state: join_request_state_wire(request.state),
            revision: mutation.room.revision().value(),
            expires_at_ms: request.expires_at.value(),
        })
    }

    pub async fn join_request_status(
        &self,
        session: &Session,
        room_code: &RoomCode,
        request_id: &RequestId,
    ) -> Result<JoinRequestResponse, ServiceError> {
        let now = self.now()?;
        session.ensure_active(now)?;
        let room = self
            .storage
            .find_room_by_code(room_code)
            .await?
            .ok_or(ServiceError::NotFound)?;
        let request = room
            .join_request_snapshots()
            .into_iter()
            .find(|request| {
                request.request_id == *request_id && request.session_id == *session.id()
            })
            .ok_or(ServiceError::NotFound)?;
        Ok(JoinRequestResponse {
            version: CURRENT_PROTOCOL,
            room_id: room.id().to_string(),
            request_id: request.request_id.to_string(),
            state: join_request_state_wire(request.state),
            revision: room.revision().value(),
            expires_at_ms: request.expires_at.value(),
        })
    }

    pub async fn create_invite(
        &self,
        owner: &Session,
        room_code: &RoomCode,
        request_id: &RequestId,
    ) -> Result<CreateInviteResponse, ServiceError> {
        let now = self.now()?;
        owner.ensure_active(now)?;
        let room = self
            .storage
            .find_room_by_code(room_code)
            .await?
            .ok_or(ServiceError::NotFound)?;
        if room.owner() != owner.id() || room.state() != p2p_domain::RoomState::Active {
            return Err(ServiceError::Forbidden);
        }
        let capability = derive_capability(
            self.config.capability_secret.as_bytes(),
            room.id(),
            request_id,
        )?;
        if let Some(expires_at) = self
            .storage
            .find_invite_expiry(room.id(), request_id)
            .await?
        {
            return Ok(CreateInviteResponse {
                version: CURRENT_PROTOCOL,
                room_code: room.code().to_string(),
                capability,
                expires_at_ms: expires_at.value(),
            });
        }

        let requested_expiry = now.checked_add(self.config.invite_ttl)?;
        let expires_at = EpochMillis::new(requested_expiry.value().min(room.expires_at().value()));
        if expires_at <= now {
            return Err(ServiceError::Room(RoomError::Inactive));
        }
        let hash = capability_hash(&capability);
        let capability_id = format!("i_{}", Uuid::new_v4().simple());
        match self
            .storage
            .insert_invite_capability(
                &capability_id,
                room.id(),
                request_id,
                &hash,
                now,
                expires_at,
            )
            .await
        {
            Ok(()) => {}
            Err(StorageError::UniqueConflict) => {
                let Some(existing_expiry) = self
                    .storage
                    .find_invite_expiry(room.id(), request_id)
                    .await?
                else {
                    return Err(ServiceError::Storage(StorageError::UniqueConflict));
                };
                return Ok(CreateInviteResponse {
                    version: CURRENT_PROTOCOL,
                    room_code: room.code().to_string(),
                    capability,
                    expires_at_ms: existing_expiry.value(),
                });
            }
            Err(error) => return Err(error.into()),
        }
        Ok(CreateInviteResponse {
            version: CURRENT_PROTOCOL,
            room_code: room.code().to_string(),
            capability,
            expires_at_ms: expires_at.value(),
        })
    }

    pub fn rtc_config(&self, session: &Session) -> Result<RtcConfigResponse, ServiceError> {
        let now = self.now()?;
        session.ensure_active(now)?;
        let mut ice_servers = self.config.ice_servers.clone();
        let mut expires_at = now.checked_add(self.config.rtc_config_ttl)?;
        if let Some(turn) = &self.config.turn {
            let turn_expiry = now.checked_add(turn.ttl)?;
            expires_at = EpochMillis::new(expires_at.value().min(turn_expiry.value()));
            let username = format!("{}:{}", turn_expiry.value() / 1_000, session.id());
            let mut mac = Hmac::<Sha1>::new_from_slice(turn.secret.as_bytes())
                .map_err(|_| ServiceError::Invariant("TURN HMAC secret is invalid"))?;
            mac.update(username.as_bytes());
            let credential = BASE64_STANDARD.encode(mac.finalize().into_bytes());
            ice_servers.push(IceServer {
                urls: turn.urls.clone(),
                username: Some(username),
                credential: Some(credential),
            });
        }
        Ok(RtcConfigResponse {
            version: CURRENT_PROTOCOL,
            ice_servers,
            expires_at_ms: expires_at.value(),
            ttl_ms: expires_at.value().saturating_sub(now.value()),
        })
    }

    pub async fn decide_join(
        &self,
        actor: &Session,
        room_code: &RoomCode,
        request_id: &RequestId,
        decision: JoinDecision,
        expected_revision: Option<Revision>,
    ) -> Result<RoomMutation, ServiceError> {
        let now = self.now()?;
        actor.ensure_active(now)?;
        self.storage
            .apply_room_command(
                room_code,
                expected_revision,
                RoomCommand::DecideJoin {
                    actor: actor.id().clone(),
                    request_id: request_id.clone(),
                    decision,
                    now,
                },
                now,
            )
            .await
            .map_err(Into::into)
    }

    pub async fn leave_room(
        &self,
        session: &Session,
        room_code: &RoomCode,
        expected_revision: Option<Revision>,
    ) -> Result<RoomMutation, ServiceError> {
        let now = self.now()?;
        let mutation = self
            .storage
            .apply_room_command(
                room_code,
                expected_revision,
                RoomCommand::Leave {
                    session_id: session.id().clone(),
                },
                now,
            )
            .await?;
        Ok(mutation)
    }

    pub async fn bootstrap_room(
        &self,
        session: &Session,
        room_code: &RoomCode,
    ) -> Result<RoomBootstrapResponse, ServiceError> {
        let now = self.now()?;
        session.ensure_active(now)?;
        let room = self
            .storage
            .find_room_by_code(room_code)
            .await?
            .ok_or(ServiceError::NotFound)?;

        let membership = room.membership_state(session.id());
        let own_request = room
            .join_request_snapshots()
            .into_iter()
            .find(|request| request.session_id == *session.id());
        if membership.is_none_or(|state| *state == MembershipState::Left) && own_request.is_none() {
            return Err(ServiceError::Forbidden);
        }

        let mut participants = Vec::new();
        for membership in room.membership_snapshots() {
            if membership.state == MembershipState::Left {
                continue;
            }
            let member = self
                .storage
                .find_session(&membership.session_id)
                .await?
                .ok_or(ServiceError::Invariant("room member session missing"))?;
            let (online, peer_id) = match &membership.state {
                MembershipState::Online { peer_id } => (true, Some(peer_id.to_string())),
                MembershipState::Offline | MembershipState::Left => (false, None),
            };
            participants.push(ParticipantSnapshot {
                session_id: member.id().to_string(),
                display_name: member.display_name().as_str().to_owned(),
                role: match membership.role {
                    MembershipRole::Owner => ParticipantRoleWire::Owner,
                    MembershipRole::Receiver => ParticipantRoleWire::Receiver,
                },
                online,
                peer_id,
            });
        }

        let is_owner = room.owner() == session.id();
        let mut pending_join_requests = Vec::new();
        for request in room.join_request_snapshots().into_iter().filter(|request| {
            request.state == JoinRequestState::Pending
                && (is_owner || request.session_id == *session.id())
        }) {
            let requester = self
                .storage
                .find_session(&request.session_id)
                .await?
                .ok_or(ServiceError::Invariant("join requester session missing"))?;
            pending_join_requests.push(JoinRequestSnapshot {
                request_id: request.request_id.to_string(),
                session_id: request.session_id.to_string(),
                display_name: requester.display_name().as_str().to_owned(),
                expires_at_ms: request.expires_at.value(),
            });
        }

        Ok(RoomBootstrapResponse {
            version: CURRENT_PROTOCOL,
            room_id: room.id().to_string(),
            room_code: room.code().to_string(),
            revision: room.revision().value(),
            expires_at_ms: room.expires_at().value(),
            participants,
            pending_join_requests,
        })
    }

    async fn session_from_cookie(
        &self,
        session_id: Option<&str>,
        now: EpochMillis,
    ) -> Result<Option<Session>, ServiceError> {
        let Some(session_id) = session_id else {
            return Ok(None);
        };
        let Ok(session_id) = SessionId::parse(session_id) else {
            return Ok(None);
        };
        let Some(session) = self.storage.find_session(&session_id).await? else {
            return Ok(None);
        };
        if session.ensure_active(now).is_err() {
            return Ok(None);
        }
        Ok(Some(session))
    }
}

pub fn room_mutation_response(mutation: &RoomMutation) -> RoomMutationResponse {
    RoomMutationResponse {
        version: CURRENT_PROTOCOL,
        room_id: mutation.room.id().to_string(),
        revision: mutation.room.revision().value(),
    }
}

fn create_room_response(room: &Room) -> CreateRoomResponse {
    CreateRoomResponse {
        version: CURRENT_PROTOCOL,
        room_id: room.id().to_string(),
        room_code: room.code().to_string(),
        revision: room.revision().value(),
        expires_at_ms: room.expires_at().value(),
    }
}

fn join_request_state_wire(state: JoinRequestState) -> JoinRequestStateWire {
    match state {
        JoinRequestState::Pending => JoinRequestStateWire::Pending,
        JoinRequestState::Approved => JoinRequestStateWire::Approved,
        JoinRequestState::Rejected => JoinRequestStateWire::Rejected,
        JoinRequestState::Cancelled => JoinRequestStateWire::Cancelled,
        JoinRequestState::Expired => JoinRequestStateWire::Expired,
    }
}

pub fn session_response(session: &Session) -> SessionResponse {
    SessionResponse {
        version: CURRENT_PROTOCOL,
        session_id: session.id().to_string(),
        display_name: session.display_name().as_str().to_owned(),
        expires_at_ms: session.expires_at().value(),
    }
}

fn random_room_code() -> Result<RoomCode, ServiceError> {
    let uuid = Uuid::new_v4();
    let bytes = uuid.as_bytes();
    let mut code = String::with_capacity(RoomCode::LENGTH);
    for byte in bytes.iter().take(RoomCode::LENGTH) {
        code.push(char::from(
            ROOM_CODE_ALPHABET[usize::from(*byte) % ROOM_CODE_ALPHABET.len()],
        ));
    }
    RoomCode::parse(code).map_err(Into::into)
}

fn derive_capability(
    secret: &[u8],
    room_id: &RoomId,
    request_id: &RequestId,
) -> Result<String, ServiceError> {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret)
        .map_err(|_| ServiceError::Invariant("capability HMAC secret is invalid"))?;
    mac.update(room_id.as_str().as_bytes());
    mac.update(b":");
    mac.update(request_id.as_str().as_bytes());
    Ok(hex_lower(&mac.finalize().into_bytes()))
}

fn capability_hash(capability: &str) -> [u8; 32] {
    Sha256::digest(capability.as_bytes()).into()
}

fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(char::from(HEX[usize::from(byte >> 4)]));
        output.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    output
}

#[derive(Debug, Error)]
pub enum ServiceError {
    #[error("system clock is before the Unix epoch: {0}")]
    Clock(std::time::SystemTimeError),
    #[error("system clock does not fit protocol time")]
    ClockOverflow,
    #[error("generated room codes repeatedly collided")]
    RoomCodeExhausted,
    #[error("session is not authenticated")]
    Unauthorized,
    #[error("operation is forbidden")]
    Forbidden,
    #[error("resource does not exist")]
    NotFound,
    #[error("service invariant failed: {0}")]
    Invariant(&'static str),
    #[error("identifier is invalid: {0}")]
    Id(#[from] p2p_domain::ids::IdError),
    #[error("room code is invalid: {0}")]
    RoomCode(#[from] p2p_domain::ids::RoomCodeError),
    #[error("display name is invalid: {0}")]
    DisplayName(#[from] p2p_domain::session::DisplayNameError),
    #[error("time calculation failed: {0}")]
    Time(#[from] p2p_domain::time::TimeError),
    #[error("session operation failed: {0}")]
    Session(#[from] SessionError),
    #[error("room operation failed: {0}")]
    Room(#[from] RoomError),
    #[error("storage operation failed: {0}")]
    Storage(#[from] StorageError),
}

#[cfg(test)]
mod tests {
    use p2p_domain::{DisplayName, DurationMillis, EpochMillis, Session, SessionId};
    use uuid::Uuid;

    use super::*;
    use crate::{
        config::{SecretBytes, TurnConfig},
        storage::Storage,
    };

    #[tokio::test]
    async fn rtc_config_issues_session_scoped_turn_credentials_without_exposing_secrets() {
        let directory = std::env::temp_dir().join(format!("p2p-turn-{}", Uuid::new_v4()));
        let database_path = directory.join("control.sqlite3");
        let storage = Storage::connect(&database_path)
            .await
            .expect("connect test storage");
        let turn_secret = "turn-test-secret-value";
        let config = AppConfig {
            database_path,
            turn: Some(TurnConfig {
                urls: vec!["turns:relay.example.test:5349".to_owned()],
                secret: SecretBytes::new(turn_secret.as_bytes().to_vec()),
                ttl: DurationMillis::new(60_000),
            }),
            ..AppConfig::default()
        };
        assert!(!format!("{config:?}").contains(turn_secret));

        let services = AppServices::new(storage, config);
        let now = services.now().expect("current time");
        let session = Session::create(
            SessionId::parse("s_turn_test").expect("session id"),
            DisplayName::parse("Receiver").expect("display name"),
            EpochMillis::new(now.value().saturating_sub(1)),
            now.checked_add(DurationMillis::new(120_000))
                .expect("session expiry"),
        )
        .expect("active session");

        let response = services.rtc_config(&session).expect("RTC config");
        let turn = response.ice_servers.last().expect("TURN server");
        assert_eq!(turn.urls, ["turns:relay.example.test:5349"]);
        assert!(
            turn.username
                .as_deref()
                .is_some_and(|username| username.ends_with(":s_turn_test"))
        );
        assert!(
            turn.credential
                .as_deref()
                .is_some_and(|credential| !credential.is_empty())
        );
        assert!(response.expires_at_ms > now.value());
        assert!(response.expires_at_ms <= now.value() + 60_000);
        assert_eq!(response.ttl_ms, 60_000);

        services.storage.close().await;
        std::fs::remove_dir_all(directory).expect("remove test directory");
    }
}
