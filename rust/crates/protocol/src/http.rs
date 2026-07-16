use serde::{Deserialize, Serialize, de::DeserializeOwned};

use crate::{
    JoinRequestSnapshot, MAX_HTTP_BODY_BYTES, ParticipantSnapshot, ProtocolError, ProtocolVersion,
    Validate,
    limits::{validate_display_name, validate_room_code, validate_text, validate_token},
};

const MAX_PUBLIC_ERROR_MESSAGE_BYTES: usize = 512;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CreateSessionRequest {
    pub version: ProtocolVersion,
    pub display_name: String,
}

impl Validate for CreateSessionRequest {
    fn validate(&self) -> Result<(), ProtocolError> {
        self.version.validate()?;
        validate_display_name(&self.display_name)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SessionResponse {
    pub version: ProtocolVersion,
    pub session_id: String,
    pub display_name: String,
    pub expires_at_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CreateRoomRequest {
    pub version: ProtocolVersion,
    pub request_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CreateRoomResponse {
    pub version: ProtocolVersion,
    pub room_id: String,
    pub room_code: String,
    pub revision: u64,
    pub expires_at_ms: u64,
}

impl Validate for CreateRoomRequest {
    fn validate(&self) -> Result<(), ProtocolError> {
        self.version.validate()?;
        validate_token(&self.request_id, "request_id")
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct RequestJoinRequest {
    pub version: ProtocolVersion,
    pub request_id: String,
    pub room_code: String,
    pub expected_revision: Option<u64>,
    pub invite_capability: Option<String>,
}

impl Validate for RequestJoinRequest {
    fn validate(&self) -> Result<(), ProtocolError> {
        self.version.validate()?;
        validate_token(&self.request_id, "request_id")?;
        validate_room_code(&self.room_code)?;
        validate_optional_revision(self.expected_revision)?;
        if let Some(capability) = &self.invite_capability {
            validate_token(capability, "invite_capability")?;
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum JoinDecisionRequest {
    Approve,
    Reject,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct DecideJoinRequest {
    pub version: ProtocolVersion,
    pub request_id: String,
    pub decision: JoinDecisionRequest,
    pub expected_revision: Option<u64>,
}

impl Validate for DecideJoinRequest {
    fn validate(&self) -> Result<(), ProtocolError> {
        self.version.validate()?;
        validate_token(&self.request_id, "request_id")?;
        validate_optional_revision(self.expected_revision)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct LeaveRoomRequest {
    pub version: ProtocolVersion,
    pub request_id: String,
    pub expected_revision: Option<u64>,
}

impl Validate for LeaveRoomRequest {
    fn validate(&self) -> Result<(), ProtocolError> {
        self.version.validate()?;
        validate_token(&self.request_id, "request_id")?;
        validate_optional_revision(self.expected_revision)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum JoinRequestStateWire {
    Pending,
    Approved,
    Rejected,
    Cancelled,
    Expired,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct JoinRequestResponse {
    pub version: ProtocolVersion,
    pub room_id: String,
    pub request_id: String,
    pub state: JoinRequestStateWire,
    pub revision: u64,
    pub expires_at_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct RoomMutationResponse {
    pub version: ProtocolVersion,
    pub room_id: String,
    pub revision: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CreateInviteRequest {
    pub version: ProtocolVersion,
    pub request_id: String,
}

impl Validate for CreateInviteRequest {
    fn validate(&self) -> Result<(), ProtocolError> {
        self.version.validate()?;
        validate_token(&self.request_id, "request_id")
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CreateInviteResponse {
    pub version: ProtocolVersion,
    pub room_code: String,
    pub capability: String,
    pub expires_at_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct RoomBootstrapResponse {
    pub version: ProtocolVersion,
    pub room_id: String,
    pub room_code: String,
    pub revision: u64,
    pub expires_at_ms: u64,
    pub participants: Vec<ParticipantSnapshot>,
    pub pending_join_requests: Vec<JoinRequestSnapshot>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct IceServer {
    pub urls: Vec<String>,
    pub username: Option<String>,
    pub credential: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct RtcConfigResponse {
    pub version: ProtocolVersion,
    pub ice_servers: Vec<IceServer>,
    pub expires_at_ms: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ApiErrorCode {
    InvalidRequest,
    Unauthorized,
    Forbidden,
    NotFound,
    Conflict,
    RateLimited,
    Unavailable,
    Internal,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ApiErrorBody {
    pub code: ApiErrorCode,
    pub message: String,
    pub request_id: Option<String>,
    pub retryable: bool,
}

impl Validate for ApiErrorBody {
    fn validate(&self) -> Result<(), ProtocolError> {
        validate_text(
            &self.message,
            "error_message",
            MAX_PUBLIC_ERROR_MESSAGE_BYTES,
        )?;
        if let Some(request_id) = &self.request_id {
            validate_token(request_id, "request_id")?;
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ErrorEnvelope {
    pub error: ApiErrorBody,
}

pub fn parse_http_body<T>(input: &[u8]) -> Result<T, ProtocolError>
where
    T: DeserializeOwned + Validate,
{
    if input.len() > MAX_HTTP_BODY_BYTES {
        return Err(ProtocolError::FrameTooLarge {
            actual: input.len(),
            max: MAX_HTTP_BODY_BYTES,
        });
    }

    let value = serde_json::from_slice::<T>(input)
        .map_err(|error| ProtocolError::InvalidJson(error.to_string()))?;
    value.validate()?;
    Ok(value)
}

fn validate_optional_revision(revision: Option<u64>) -> Result<(), ProtocolError> {
    if revision == Some(0) {
        return Err(ProtocolError::InvalidField {
            field: "expected_revision",
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::CURRENT_PROTOCOL;

    #[test]
    fn create_session_request_has_a_golden_fixture() {
        let request = CreateSessionRequest {
            version: CURRENT_PROTOCOL,
            display_name: "Alice".to_owned(),
        };
        let json = serde_json::to_string(&request).expect("serialize session request");
        assert_eq!(
            json,
            include_str!("../tests/fixtures/create-session.json").trim()
        );
        assert_eq!(parse_http_body(json.as_bytes()), Ok(request));
    }

    #[test]
    fn requests_reject_invalid_names_versions_and_room_codes() {
        let blank = br#"{"version":{"major":2,"minor":0},"display_name":"  "}"#;
        assert_eq!(
            parse_http_body::<CreateSessionRequest>(blank),
            Err(ProtocolError::EmptyField {
                field: "display_name"
            })
        );

        let future = br#"{"version":{"major":3,"minor":0},"request_id":"request_1"}"#;
        assert_eq!(
            parse_http_body::<CreateRoomRequest>(future),
            Err(ProtocolError::UnsupportedVersion { major: 3, minor: 0 })
        );

        let invalid_room = RequestJoinRequest {
            version: CURRENT_PROTOCOL,
            request_id: "request_1".to_owned(),
            room_code: "../bad".to_owned(),
            expected_revision: None,
            invite_capability: None,
        };
        assert_eq!(
            invalid_room.validate(),
            Err(ProtocolError::InvalidField { field: "room_code" })
        );
    }

    #[test]
    fn oversized_http_body_is_rejected_before_deserialization() {
        let oversized = vec![b'x'; MAX_HTTP_BODY_BYTES + 1];
        assert_eq!(
            parse_http_body::<CreateRoomRequest>(&oversized),
            Err(ProtocolError::FrameTooLarge {
                actual: MAX_HTTP_BODY_BYTES + 1,
                max: MAX_HTTP_BODY_BYTES,
            })
        );
    }

    #[test]
    fn arbitrary_http_bytes_never_panic() {
        let mut state = 0x4d59_5df4_d0f3_3173_u64;
        for _ in 0..4_096 {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            let length = (state as usize) % 512;
            let mut input = Vec::with_capacity(length);
            for _ in 0..length {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                input.push(state as u8);
            }
            let _ = parse_http_body::<CreateSessionRequest>(&input);
        }
    }
}
