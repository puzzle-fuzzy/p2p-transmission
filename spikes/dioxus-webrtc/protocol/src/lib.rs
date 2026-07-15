use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
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

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMessage {
    Signal { to: String, signal: Signal },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMessage {
    Peers { peers: Vec<String> },
    PeerJoined { peer_id: String },
    PeerLeft { peer_id: String },
    Signal { from: String, signal: Signal },
    Error { message: String },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DataControlFrame {
    Text {
        text: String,
    },
    FileStart {
        transfer_id: String,
        name: String,
        mime_type: String,
        size: u64,
    },
    FileEnd {
        transfer_id: String,
        blake3: String,
    },
    Cancel {
        transfer_id: String,
        reason: String,
    },
}

#[cfg(test)]
mod tests {
    use super::{ClientMessage, DataControlFrame, ServerMessage, Signal};

    #[test]
    fn signaling_round_trips() {
        let message = ClientMessage::Signal {
            to: "peer-b".to_owned(),
            signal: Signal::IceCandidate {
                candidate: "candidate:1".to_owned(),
                sdp_mid: Some("0".to_owned()),
                sdp_m_line_index: Some(0),
            },
        };

        let encoded = serde_json::to_string(&message).expect("serialize client message");
        let decoded: ClientMessage =
            serde_json::from_str(&encoded).expect("deserialize client message");
        assert_eq!(decoded, message);
    }

    #[test]
    fn server_and_data_frames_are_tagged() {
        let peer = ServerMessage::PeerJoined {
            peer_id: "peer-b".to_owned(),
        };
        let frame = DataControlFrame::Text {
            text: "hello".to_owned(),
        };

        assert!(
            serde_json::to_string(&peer)
                .expect("serialize peer event")
                .contains("peer_joined")
        );
        assert!(
            serde_json::to_string(&frame)
                .expect("serialize data frame")
                .contains("text")
        );
    }
}
