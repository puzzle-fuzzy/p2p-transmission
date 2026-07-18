use p2p_browser_platform::{clear_room_session, load_room_session, save_room_session};
use serde::{Deserialize, Serialize};

use crate::app_state::StoredRoomSession;

const ROOM_SESSION_SCHEMA_VERSION: u8 = 5;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredRoomSessionEnvelope {
    schema_version: u8,
    session: StoredRoomSession,
}

#[derive(Serialize)]
#[serde(deny_unknown_fields)]
struct StoredRoomSessionEnvelopeRef<'a> {
    schema_version: u8,
    session: &'a StoredRoomSession,
}

pub(super) fn restored_room_session() -> Option<StoredRoomSession> {
    let value = load_room_session().ok().flatten()?;
    match decode_room_session(&value) {
        Some(session) => Some(session),
        None => {
            let _ = clear_room_session();
            None
        }
    }
}

pub(super) fn persist_room_session(value: &StoredRoomSession) {
    if let Ok(value) = encode_room_session(value) {
        let _ = save_room_session(&value);
    }
}

fn decode_room_session(value: &str) -> Option<StoredRoomSession> {
    let envelope = serde_json::from_str::<StoredRoomSessionEnvelope>(value).ok()?;
    (envelope.schema_version == ROOM_SESSION_SCHEMA_VERSION).then_some(envelope.session)
}

fn encode_room_session(value: &StoredRoomSession) -> Result<String, serde_json::Error> {
    serde_json::to_string(&StoredRoomSessionEnvelopeRef {
        schema_version: ROOM_SESSION_SCHEMA_VERSION,
        session: value,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_state::RoomRole;

    fn session() -> StoredRoomSession {
        StoredRoomSession {
            room_code: "ABC234".to_owned(),
            role: RoomRole::Receiver,
            join_request_id: Some("join_1".to_owned()),
            invite_request_id: None,
            peer_id: "peer_1".to_owned(),
        }
    }

    #[test]
    fn room_session_envelope_accepts_only_exact_v5_schema() {
        let encoded = encode_room_session(&session()).expect("encode v5 room session");
        assert!(encoded.contains(r#""schema_version":5"#));
        assert_eq!(decode_room_session(&encoded), Some(session()));

        let wrong_version = encoded.replace(r#""schema_version":5"#, r#""schema_version":4"#);
        assert!(decode_room_session(&wrong_version).is_none());

        let unknown = encoded.replacen('{', r#"{"unsupported":true,"#, 1);
        assert!(decode_room_session(&unknown).is_none());

        let previous_flat = r#"{"room_code":"ABC234","role":"receiver","join_request_id":"join_1","invite_request_id":null,"peer_id":"peer_1"}"#;
        assert!(decode_room_session(previous_flat).is_none());
    }
}
