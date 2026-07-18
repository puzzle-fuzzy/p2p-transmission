#![forbid(unsafe_code)]

mod data_channel;
mod http;
mod limits;
mod realtime;
mod version;

use serde::{Deserialize, Serialize};

pub use data_channel::{
    BinaryChunkHeader, CHUNK_HEADER_LEN, CHUNK_MAGIC, CancelReason, ControlMessage, FileDigest,
    FileManifest, ResumeCursor, StreamPauseReason, TransferMode, decode_binary_frame,
    parse_control_message,
};
pub use http::{
    ApiErrorBody, ApiErrorCode, CreateInviteRequest, CreateInviteResponse, CreateRoomRequest,
    CreateRoomResponse, CreateSessionRequest, DecideJoinRequest, ErrorEnvelope, IceServer,
    JoinDecisionRequest, JoinRequestResponse, JoinRequestStateWire, LeaveRoomRequest,
    RequestJoinRequest, RoomBootstrapResponse, RoomMutationResponse, RtcConfigResponse,
    SessionResponse, parse_http_body,
};
pub use limits::{
    MAX_BUFFERED_TRANSFER_BYTES, MAX_CHUNK_BYTES, MAX_CONTROL_FRAME_BYTES, MAX_DISPLAY_NAME_CHARS,
    MAX_FILES_PER_MANIFEST, MAX_HTTP_BODY_BYTES, MAX_JSON_FRAME_BYTES, MAX_SIGNAL_BYTES,
    MAX_STREAM_ACK_WINDOW_BYTES, MAX_STREAM_SEGMENT_BYTES, MAX_TRANSFER_BYTES,
    MIN_STREAM_SEGMENT_BYTES, ProtocolError, Validate,
};
pub use realtime::{
    ClientRealtimeMessage, JoinDecisionWire, JoinRequestSnapshot, ParticipantRoleWire,
    ParticipantSnapshot, ServerRealtimeMessage, Signal, parse_client_message,
};
pub use version::{CURRENT_PROTOCOL, ProtocolVersion};

pub const API_MAJOR_VERSION: u16 = CURRENT_PROTOCOL.major;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HealthState {
    Ready,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct HealthResponse {
    pub status: HealthState,
    pub service: String,
    pub version: String,
    pub release: String,
}

impl HealthResponse {
    pub fn ready(
        service: impl Into<String>,
        version: impl Into<String>,
        release: impl Into<String>,
    ) -> Self {
        Self {
            status: HealthState::Ready,
            service: service.into(),
            version: version.into(),
            release: release.into(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BuildInfo {
    pub product: String,
    pub version: String,
    pub release: String,
    pub api_major: u16,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn health_wire_format_is_stable() {
        let value = serde_json::to_value(HealthResponse::ready(
            "p2p-server",
            "2.0.0",
            "2.0.0-abcdef0",
        ))
        .expect("health response serializes");
        assert_eq!(value["status"], "ready");
        assert_eq!(value["service"], "p2p-server");
        assert_eq!(value["release"], "2.0.0-abcdef0");
    }
}
