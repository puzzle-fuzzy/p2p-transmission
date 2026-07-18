use std::collections::BTreeMap;

use p2p_protocol::{
    CancelReason, CreateInviteResponse, RoomBootstrapResponse, SessionResponse,
    Signal as ProtocolSignal, StreamPauseReason, TransferMode,
};
use p2p_transfer::{TransferDirection, TransferFile};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum RoomRole {
    Owner,
    Receiver,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct StoredRoomSession {
    pub(super) room_code: String,
    pub(super) role: RoomRole,
    pub(super) join_request_id: Option<String>,
    pub(super) invite_request_id: Option<String>,
    pub(super) peer_id: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum RealtimePhase {
    Disconnected,
    Connecting,
    Connected,
    Reconnecting,
    Superseded,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum RtcPhase {
    Inactive,
    WaitingPeer,
    Connecting,
    Ready,
    Disconnected,
    Failed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum RtcConfigPhase {
    Inactive,
    Loading,
    Ready,
    Failed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum OutgoingRecoveryPhase {
    Pending,
    Checking,
    Complete,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum PendingRtcWork {
    OwnerOfferTimeout { attempt: u8 },
    OwnerRetryDelay { next_attempt: u8 },
    PassiveDeadline,
    DisconnectedDeadline,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct PeerRtcError {
    pub(super) peer_id: String,
    pub(super) message: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) enum LobbyActionError {
    Join(String),
    Create(String),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct PendingRtcSignal {
    pub(super) from_peer_id: String,
    pub(super) negotiation_id: String,
    pub(super) signal: ProtocolSignal,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct PeerRtcState {
    pub(super) phase: RtcPhase,
    pub(super) instance_generation: u64,
    pub(super) work_generation: u64,
    pub(super) pending_work: Option<PendingRtcWork>,
    outgoing_recovery: OutgoingRecoveryPhase,
}

impl PeerRtcState {
    pub(super) fn new(instance_generation: u64) -> Self {
        Self {
            phase: RtcPhase::WaitingPeer,
            instance_generation,
            work_generation: 0,
            pending_work: None,
            outgoing_recovery: OutgoingRecoveryPhase::Pending,
        }
    }

    pub(super) fn begin_outgoing_recovery(&mut self) -> Option<u64> {
        if self.outgoing_recovery != OutgoingRecoveryPhase::Pending {
            return None;
        }
        self.outgoing_recovery = OutgoingRecoveryPhase::Checking;
        Some(self.instance_generation)
    }

    pub(super) fn finish_outgoing_recovery(&mut self, instance_generation: u64) -> bool {
        if self.instance_generation != instance_generation
            || self.outgoing_recovery != OutgoingRecoveryPhase::Checking
        {
            return false;
        }
        self.outgoing_recovery = OutgoingRecoveryPhase::Complete;
        true
    }

    pub(super) fn outgoing_recovery_is_checking(self) -> bool {
        self.outgoing_recovery == OutgoingRecoveryPhase::Checking
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum TransferLinkState {
    Ready,
    Waiting,
    Paused,
}

#[derive(Clone, Debug, PartialEq)]
pub(super) enum TransferState {
    Idle,
    Offering {
        transfer_id: String,
        file: TransferFile,
        files: Vec<TransferFile>,
    },
    OutgoingRecovery {
        transfer_id: String,
        file: TransferFile,
        files: Vec<TransferFile>,
    },
    Incoming {
        transfer_id: String,
        mode: TransferMode,
        file: TransferFile,
        files: Vec<TransferFile>,
        recovery_available: bool,
    },
    Active {
        transfer_id: String,
        direction: TransferDirection,
        streamed: bool,
        file: TransferFile,
        files: Vec<TransferFile>,
        completed_bytes: u64,
        awaiting_verification: bool,
        link_state: TransferLinkState,
        storage_pause: Option<StreamPauseReason>,
    },
    Rejected {
        direction: TransferDirection,
        file: TransferFile,
        files: Vec<TransferFile>,
    },
    Completed {
        direction: TransferDirection,
        file: TransferFile,
        files: Vec<TransferFile>,
        blake3: String,
        download_url: Option<String>,
    },
    Cancelled {
        file: Option<TransferFile>,
        reason: CancelReason,
    },
    Failed {
        file: Option<TransferFile>,
        message: String,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub(super) enum Screen {
    Booting,
    Lobby {
        room_code: String,
        invite_capability: Option<String>,
    },
    Waiting {
        room_code: String,
        request_id: String,
        peer_id: String,
        revision: u64,
        expires_at_ms: u64,
    },
    Room {
        role: RoomRole,
        snapshot: RoomBootstrapResponse,
        invite: Option<CreateInviteResponse>,
        invite_request_id: Option<String>,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub(super) struct AppModel {
    pub(super) session: Option<SessionResponse>,
    pub(super) screen: Screen,
    pub(super) realtime: RealtimePhase,
    pub(super) rtc_config_phase: RtcConfigPhase,
    pub(super) rtc_aggregate_phase: RtcPhase,
    pub(super) transfer: TransferState,
    pub(super) busy: bool,
    pub(super) lobby_action_error: Option<LobbyActionError>,
    pub(super) error: Option<String>,
    pub(super) notice: Option<String>,
    pub(super) about_open: bool,
    pub(super) decision_request_id: Option<String>,
    pub(super) entering_receivers: Vec<String>,
    pub(super) pending_signals: Vec<PendingRtcSignal>,
    pub(super) rtc_peer_generation: u64,
    pub(super) rtc_peer_states: BTreeMap<String, PeerRtcState>,
    pub(super) rtc_config_error: Option<String>,
    pub(super) rtc_error: Option<PeerRtcError>,
    pub(super) transfers_by_peer: BTreeMap<String, TransferState>,
}

impl Default for AppModel {
    fn default() -> Self {
        Self {
            session: None,
            screen: Screen::Booting,
            realtime: RealtimePhase::Disconnected,
            rtc_config_phase: RtcConfigPhase::Inactive,
            rtc_aggregate_phase: RtcPhase::Inactive,
            transfer: TransferState::Idle,
            busy: false,
            lobby_action_error: None,
            error: None,
            notice: None,
            about_open: false,
            decision_request_id: None,
            entering_receivers: Vec::new(),
            pending_signals: Vec::new(),
            rtc_peer_generation: 0,
            rtc_peer_states: BTreeMap::new(),
            rtc_config_error: None,
            rtc_error: None,
            transfers_by_peer: BTreeMap::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stored_room_session_requires_peer_identity() {
        let missing_peer_id = serde_json::from_str::<StoredRoomSession>(
            r#"{"room_code":"ABC234","role":"receiver","join_request_id":"join_1","invite_request_id":null}"#,
        );
        assert!(missing_peer_id.is_err());

        let current = StoredRoomSession {
            room_code: "ABC234".to_owned(),
            role: RoomRole::Receiver,
            join_request_id: Some("join_1".to_owned()),
            invite_request_id: None,
            peer_id: "peer_stable".to_owned(),
        };
        let encoded = serde_json::to_string(&current).expect("room session should serialize");
        let restored = serde_json::from_str::<StoredRoomSession>(&encoded)
            .expect("room session should restore");
        assert_eq!(restored.peer_id, "peer_stable");

        let unknown = r#"{"room_code":"ABC234","role":"receiver","join_request_id":"join_1","invite_request_id":null,"peer_id":"peer_stable","unsupported":true}"#;
        assert!(serde_json::from_str::<StoredRoomSession>(unknown).is_err());
    }
}
