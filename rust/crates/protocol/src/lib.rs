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
    MAX_STREAM_ACK_WINDOW_BYTES, MAX_STREAM_SEGMENT_BYTES, MAX_TEXT_TRANSFER_BYTES,
    MAX_TEXT_TRANSFER_CHARS, MAX_TRANSFER_BYTES, MIN_STREAM_SEGMENT_BYTES, ProtocolError, Validate,
};
pub use realtime::{
    ClientRealtimeMessage, JoinDecisionWire, JoinRequestSnapshot, ParticipantRoleWire,
    ParticipantSnapshot, ServerRealtimeMessage, Signal, parse_client_message,
};
pub use version::{
    CURRENT_PROTOCOL, PROTOCOL_VERSION_TEXT, ProtocolVersion, ROOM_SESSION_STORAGE_KEY,
    SESSION_COOKIE_NAME,
};

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
    pub api_minor: u16,
    #[serde(default)]
    pub capabilities: ProtocolCapabilities,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(transparent)]
pub struct ProtocolCapabilities(u8);

impl ProtocolCapabilities {
    pub const DIRECT_TEXT: Self = Self(1 << 0);
    pub const MULTI_RECEIVER: Self = Self(1 << 1);
    pub const STREAM_RESUME_V1: Self = Self(1 << 2);

    pub const fn from_bits(bits: u8) -> Self {
        Self(bits)
    }

    pub const fn bits(self) -> u8 {
        self.0
    }

    pub const fn contains(self, required: Self) -> bool {
        self.0 & required.0 == required.0
    }
}

pub const CURRENT_CAPABILITIES: ProtocolCapabilities = ProtocolCapabilities::from_bits(
    ProtocolCapabilities::DIRECT_TEXT.bits()
        | ProtocolCapabilities::MULTI_RECEIVER.bits()
        | ProtocolCapabilities::STREAM_RESUME_V1.bits(),
);

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

    #[test]
    fn capability_bitset_wire_format_is_stable() {
        let value =
            serde_json::to_value(CURRENT_CAPABILITIES).expect("capabilities should serialize");
        assert_eq!(value, serde_json::json!(7));
        assert!(CURRENT_CAPABILITIES.contains(ProtocolCapabilities::DIRECT_TEXT));
    }
}
