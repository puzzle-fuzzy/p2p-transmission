use serde::{Deserialize, Serialize};

use crate::{
    MAX_JSON_FRAME_BYTES, MAX_SIGNAL_BYTES, ProtocolError, ProtocolVersion, Validate,
    limits::{
        MAX_ERROR_MESSAGE_BYTES, validate_multiline_text, validate_room_code, validate_text,
        validate_token,
    },
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Signal {
    Offer {
        sdp: String,
    },
    Answer {
        sdp: String,
    },
    IceCandidate {
        candidate: String,
        sdp_mid: Option<String>,
        sdp_m_line_index: Option<u16>,
    },
}

impl Validate for Signal {
    fn validate(&self) -> Result<(), ProtocolError> {
        match self {
            Self::Offer { sdp } | Self::Answer { sdp } => {
                validate_multiline_text(sdp, "sdp", MAX_SIGNAL_BYTES)
            }
            Self::IceCandidate {
                candidate, sdp_mid, ..
            } => {
                validate_text(candidate, "candidate", MAX_SIGNAL_BYTES)?;
                if let Some(sdp_mid) = sdp_mid {
                    validate_text(sdp_mid, "sdp_mid", 256)?;
                }
                Ok(())
            }
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ClientRealtimeMessage {
    AttachRoom {
        version: ProtocolVersion,
        room_code: String,
        peer_id: String,
        last_revision: Option<u64>,
    },
    WatchJoinRequest {
        version: ProtocolVersion,
        room_code: String,
        request_id: String,
        last_revision: Option<u64>,
    },
    DetachRoom {
        version: ProtocolVersion,
        room_code: String,
    },
    Signal {
        version: ProtocolVersion,
        room_code: String,
        to_peer_id: String,
        negotiation_id: String,
        signal: Signal,
    },
    Heartbeat {
        version: ProtocolVersion,
        nonce: String,
    },
    AckEvent {
        version: ProtocolVersion,
        event_id: String,
    },
}

impl Validate for ClientRealtimeMessage {
    fn validate(&self) -> Result<(), ProtocolError> {
        let version = match self {
            Self::AttachRoom { version, .. }
            | Self::WatchJoinRequest { version, .. }
            | Self::DetachRoom { version, .. }
            | Self::Signal { version, .. }
            | Self::Heartbeat { version, .. }
            | Self::AckEvent { version, .. } => *version,
        };
        version.validate()?;

        match self {
            Self::AttachRoom {
                room_code, peer_id, ..
            } => {
                validate_room_code(room_code)?;
                validate_token(peer_id, "peer_id")
            }
            Self::WatchJoinRequest {
                room_code,
                request_id,
                ..
            } => {
                validate_room_code(room_code)?;
                validate_token(request_id, "request_id")
            }
            Self::DetachRoom { room_code, .. } => validate_room_code(room_code),
            Self::Signal {
                room_code,
                to_peer_id,
                negotiation_id,
                signal,
                ..
            } => {
                validate_room_code(room_code)?;
                validate_token(to_peer_id, "to_peer_id")?;
                validate_token(negotiation_id, "negotiation_id")?;
                signal.validate()
            }
            Self::Heartbeat { nonce, .. } => validate_token(nonce, "nonce"),
            Self::AckEvent { event_id, .. } => validate_token(event_id, "event_id"),
        }
    }
}

pub fn parse_client_message(input: &str) -> Result<ClientRealtimeMessage, ProtocolError> {
    if input.len() > MAX_JSON_FRAME_BYTES {
        return Err(ProtocolError::FrameTooLarge {
            actual: input.len(),
            max: MAX_JSON_FRAME_BYTES,
        });
    }
    let message = serde_json::from_str::<ClientRealtimeMessage>(input)
        .map_err(|error| ProtocolError::InvalidJson(error.to_string()))?;
    message.validate()?;
    Ok(message)
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ParticipantRoleWire {
    Owner,
    Receiver,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ParticipantSnapshot {
    pub session_id: String,
    pub display_name: String,
    pub role: ParticipantRoleWire,
    pub online: bool,
    pub peer_id: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum JoinDecisionWire {
    Approved,
    Rejected,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct JoinRequestSnapshot {
    pub request_id: String,
    pub session_id: String,
    pub display_name: String,
    pub expires_at_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ServerRealtimeMessage {
    Attached {
        version: ProtocolVersion,
        event_id: String,
        room_id: String,
        revision: u64,
    },
    JoinWatching {
        version: ProtocolVersion,
        event_id: String,
        room_id: String,
        request_id: String,
        revision: u64,
    },
    RoomSnapshot {
        version: ProtocolVersion,
        event_id: String,
        room_id: String,
        room_code: String,
        revision: u64,
        expires_at_ms: u64,
        participants: Vec<ParticipantSnapshot>,
        pending_join_requests: Vec<JoinRequestSnapshot>,
    },
    JoinRequested {
        version: ProtocolVersion,
        event_id: String,
        revision: u64,
        request: JoinRequestSnapshot,
    },
    JoinDecided {
        version: ProtocolVersion,
        event_id: String,
        revision: u64,
        request_id: String,
        decision: JoinDecisionWire,
    },
    PeerOnline {
        version: ProtocolVersion,
        event_id: String,
        revision: u64,
        session_id: String,
        peer_id: String,
    },
    PeerOffline {
        version: ProtocolVersion,
        event_id: String,
        revision: u64,
        session_id: String,
    },
    Signal {
        version: ProtocolVersion,
        event_id: String,
        from_peer_id: String,
        negotiation_id: String,
        signal: Signal,
    },
    RoomExpired {
        version: ProtocolVersion,
        event_id: String,
        revision: u64,
    },
    Error {
        version: ProtocolVersion,
        code: String,
        message: String,
        retryable: bool,
    },
}

impl Validate for ServerRealtimeMessage {
    fn validate(&self) -> Result<(), ProtocolError> {
        let version = match self {
            Self::Attached { version, .. }
            | Self::JoinWatching { version, .. }
            | Self::RoomSnapshot { version, .. }
            | Self::JoinRequested { version, .. }
            | Self::JoinDecided { version, .. }
            | Self::PeerOnline { version, .. }
            | Self::PeerOffline { version, .. }
            | Self::Signal { version, .. }
            | Self::RoomExpired { version, .. }
            | Self::Error { version, .. } => *version,
        };
        version.validate()?;

        match self {
            Self::Signal {
                event_id,
                from_peer_id,
                negotiation_id,
                signal,
                ..
            } => {
                validate_token(event_id, "event_id")?;
                validate_token(from_peer_id, "from_peer_id")?;
                validate_token(negotiation_id, "negotiation_id")?;
                signal.validate()
            }
            Self::Error { code, message, .. } => {
                validate_token(code, "error_code")?;
                validate_text(message, "error_message", MAX_ERROR_MESSAGE_BYTES)
            }
            _ => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::CURRENT_PROTOCOL;

    #[test]
    fn attach_room_has_a_golden_json_fixture() {
        let message = ClientRealtimeMessage::AttachRoom {
            version: CURRENT_PROTOCOL,
            room_code: "AB12CD".to_owned(),
            peer_id: "peer_1".to_owned(),
            last_revision: Some(7),
        };
        let json = serde_json::to_string(&message).expect("serialize attach");
        assert_eq!(
            json,
            include_str!("../tests/fixtures/attach-room.json").trim()
        );
        assert_eq!(parse_client_message(&json), Ok(message));
    }

    #[test]
    fn unsupported_versions_and_large_frames_are_rejected_before_use() {
        let previous = r#"{"type":"heartbeat","version":{"major":4,"minor":0},"nonce":"n_1"}"#;
        assert_eq!(
            parse_client_message(previous),
            Err(ProtocolError::UnsupportedVersion { major: 4, minor: 0 })
        );
        let future = r#"{"type":"heartbeat","version":{"major":6,"minor":0},"nonce":"n_1"}"#;
        assert_eq!(
            parse_client_message(future),
            Err(ProtocolError::UnsupportedVersion { major: 6, minor: 0 })
        );
        let oversized = "x".repeat(MAX_JSON_FRAME_BYTES + 1);
        assert!(matches!(
            parse_client_message(&oversized),
            Err(ProtocolError::FrameTooLarge { .. })
        ));
    }

    #[test]
    fn realtime_messages_and_nested_signals_reject_unknown_fields() {
        let unknown_message = r#"{"type":"heartbeat","version":{"major":5,"minor":1},"nonce":"n_1","unsupported":true}"#;
        assert!(matches!(
            parse_client_message(unknown_message),
            Err(ProtocolError::InvalidJson(_))
        ));

        let unknown_signal = r#"{"type":"signal","version":{"major":5,"minor":1},"room_code":"AB12CD","to_peer_id":"peer_1","negotiation_id":"neg_1","signal":{"kind":"offer","sdp":"v=0","unsupported":true}}"#;
        assert!(matches!(
            parse_client_message(unknown_signal),
            Err(ProtocolError::InvalidJson(_))
        ));
    }

    #[test]
    fn signal_negotiation_id_is_required_and_validated() {
        let valid = r#"{"type":"signal","version":{"major":5,"minor":1},"room_code":"AB12CD","to_peer_id":"peer_1","negotiation_id":"neg_1","signal":{"kind":"offer","sdp":"v=0"}}"#;
        assert!(matches!(
            parse_client_message(valid),
            Ok(ClientRealtimeMessage::Signal { negotiation_id, .. })
                if negotiation_id == "neg_1"
        ));

        let missing = r#"{"type":"signal","version":{"major":5,"minor":1},"room_code":"AB12CD","to_peer_id":"peer_1","signal":{"kind":"offer","sdp":"v=0"}}"#;
        assert!(matches!(
            parse_client_message(missing),
            Err(ProtocolError::InvalidJson(_))
        ));

        let invalid = r#"{"type":"signal","version":{"major":5,"minor":1},"room_code":"AB12CD","to_peer_id":"peer_1","negotiation_id":"neg 1","signal":{"kind":"offer","sdp":"v=0"}}"#;
        assert_eq!(
            parse_client_message(invalid),
            Err(ProtocolError::InvalidField {
                field: "negotiation_id"
            })
        );
    }

    #[test]
    fn sdp_accepts_line_endings_but_rejects_other_control_characters() {
        assert_eq!(
            Signal::Offer {
                sdp: "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n".to_owned(),
            }
            .validate(),
            Ok(())
        );
        assert_eq!(
            Signal::Offer {
                sdp: "v=0\0bad".to_owned(),
            }
            .validate(),
            Err(ProtocolError::InvalidField { field: "sdp" })
        );
    }

    #[test]
    fn arbitrary_text_inputs_never_panic_or_allocate_past_the_frame_limit() {
        let mut value = 1_u64;
        for _ in 0..4_096 {
            value = value
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1);
            let length = (value as usize) % 512;
            let input = (0..length)
                .map(|offset| char::from((value.wrapping_add(offset as u64) & 0x7f) as u8))
                .collect::<String>();
            let _ = parse_client_message(&input);
        }
    }
}
