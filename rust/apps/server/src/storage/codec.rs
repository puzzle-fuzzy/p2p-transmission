use p2p_domain::{
    DisplayName, EpochMillis, JoinRequestState, MembershipRole, MembershipState, PeerId, RequestId,
    Revision, RoomCode, RoomId, RoomJoinRequestSnapshot, RoomMembershipSnapshot, RoomState,
    Session, SessionId, SessionState,
};
use sqlx::Row;

use super::StorageError;

pub(super) struct DecodedRoom {
    pub(super) id: RoomId,
    pub(super) code: RoomCode,
    pub(super) owner: SessionId,
    pub(super) state: RoomState,
    pub(super) revision: Revision,
    pub(super) expires_at: EpochMillis,
}

pub(super) fn decode_room(row: &sqlx::sqlite::SqliteRow) -> Result<DecodedRoom, StorageError> {
    let room_id_text: String = row.try_get("id")?;
    let id = RoomId::parse(room_id_text.clone())
        .map_err(|error| corrupt("rooms.id", room_id_text, error))?;
    let room_code_text: String = row.try_get("code")?;
    let code = RoomCode::parse(&room_code_text)
        .map_err(|error| corrupt("rooms.code", room_code_text, error))?;
    let owner_text: String = row.try_get("owner_session_id")?;
    let owner = SessionId::parse(owner_text.clone())
        .map_err(|error| corrupt("rooms.owner_session_id", owner_text, error))?;
    let state = parse_room_state(row.try_get("state")?)?;
    let revision = Revision::new(unsigned_sql_integer(
        row.try_get("revision")?,
        "rooms.revision",
    )?);
    let expires_at = EpochMillis::new(unsigned_sql_integer(
        row.try_get("expires_at_ms")?,
        "rooms.expires_at_ms",
    )?);

    Ok(DecodedRoom {
        id,
        code,
        owner,
        state,
        revision,
        expires_at,
    })
}

pub(super) fn decode_room_code(
    row: &sqlx::sqlite::SqliteRow,
    column: &'static str,
) -> Result<RoomCode, StorageError> {
    let value: String = row.try_get(column)?;
    RoomCode::parse(&value).map_err(|error| corrupt("rooms.code", value, error))
}

pub(super) fn decode_request_id(
    row: &sqlx::sqlite::SqliteRow,
    column: &'static str,
) -> Result<RequestId, StorageError> {
    let value: String = row.try_get(column)?;
    RequestId::parse(value.clone()).map_err(|error| corrupt("join_requests.id", value, error))
}

pub(super) fn decode_session(row: sqlx::sqlite::SqliteRow) -> Result<Session, StorageError> {
    let id_text: String = row.try_get("id")?;
    let id = SessionId::parse(id_text.clone())
        .map_err(|error| corrupt("sessions.id", id_text, error))?;
    let display_name_text: String = row.try_get("display_name")?;
    let display_name = DisplayName::parse(&display_name_text)
        .map_err(|error| corrupt("sessions.display_name", display_name_text, error))?;
    let state = parse_session_state(row.try_get("state")?)?;
    let expires_at = EpochMillis::new(unsigned_sql_integer(
        row.try_get("expires_at_ms")?,
        "sessions.expires_at_ms",
    )?);
    Ok(Session::restore(id, display_name, expires_at, state))
}

pub(super) fn decode_membership(
    row: &sqlx::sqlite::SqliteRow,
) -> Result<RoomMembershipSnapshot, StorageError> {
    let session_text: String = row.try_get("session_id")?;
    let session_id = SessionId::parse(session_text.clone())
        .map_err(|error| corrupt("room_members.session_id", session_text, error))?;
    let role = parse_membership_role(row.try_get("role")?)?;
    let state_text: String = row.try_get("state")?;
    let peer_text: Option<String> = row.try_get("peer_id")?;
    let state = match (state_text.as_str(), peer_text) {
        ("offline", None) => MembershipState::Offline,
        ("left", None) => MembershipState::Left,
        ("online", Some(peer_id)) => MembershipState::Online {
            peer_id: PeerId::parse(peer_id.clone())
                .map_err(|error| corrupt("room_members.peer_id", peer_id, error))?,
        },
        _ => {
            return Err(StorageError::CorruptData(
                "room_members state/peer_id combination is invalid".to_owned(),
            ));
        }
    };
    Ok(RoomMembershipSnapshot {
        session_id,
        role,
        state,
    })
}

pub(super) fn decode_join_request(
    row: &sqlx::sqlite::SqliteRow,
) -> Result<RoomJoinRequestSnapshot, StorageError> {
    let request_text: String = row.try_get("id")?;
    let request_id = RequestId::parse(request_text.clone())
        .map_err(|error| corrupt("join_requests.id", request_text, error))?;
    let session_text: String = row.try_get("session_id")?;
    let session_id = SessionId::parse(session_text.clone())
        .map_err(|error| corrupt("join_requests.session_id", session_text, error))?;
    let state = parse_join_request_state(row.try_get("state")?)?;
    let expires_at = EpochMillis::new(unsigned_sql_integer(
        row.try_get("expires_at_ms")?,
        "join_requests.expires_at_ms",
    )?);
    Ok(RoomJoinRequestSnapshot {
        request_id,
        session_id,
        expires_at,
        state,
    })
}

pub(super) fn session_state_text(state: SessionState) -> &'static str {
    match state {
        SessionState::Active => "active",
        SessionState::Expired => "expired",
    }
}

fn parse_session_state(value: String) -> Result<SessionState, StorageError> {
    match value.as_str() {
        "active" => Ok(SessionState::Active),
        "expired" => Ok(SessionState::Expired),
        _ => Err(StorageError::CorruptData(format!(
            "sessions.state contains {value:?}"
        ))),
    }
}

pub(super) fn room_state_text(state: RoomState) -> &'static str {
    match state {
        RoomState::Active => "active",
        RoomState::Expired => "expired",
    }
}

pub(super) fn parse_room_state(value: String) -> Result<RoomState, StorageError> {
    match value.as_str() {
        "active" => Ok(RoomState::Active),
        "expired" => Ok(RoomState::Expired),
        _ => Err(StorageError::CorruptData(format!(
            "rooms.state contains {value:?}"
        ))),
    }
}

pub(super) fn membership_role_text(role: MembershipRole) -> &'static str {
    match role {
        MembershipRole::Owner => "owner",
        MembershipRole::Receiver => "receiver",
    }
}

fn parse_membership_role(value: String) -> Result<MembershipRole, StorageError> {
    match value.as_str() {
        "owner" => Ok(MembershipRole::Owner),
        "receiver" => Ok(MembershipRole::Receiver),
        _ => Err(StorageError::CorruptData(format!(
            "room_members.role contains {value:?}"
        ))),
    }
}

pub(super) fn membership_state_parts(state: &MembershipState) -> (&'static str, Option<&str>) {
    match state {
        MembershipState::Offline => ("offline", None),
        MembershipState::Online { peer_id } => ("online", Some(peer_id.as_str())),
        MembershipState::Left => ("left", None),
    }
}

pub(super) fn join_request_state_text(state: JoinRequestState) -> &'static str {
    match state {
        JoinRequestState::Pending => "pending",
        JoinRequestState::Approved => "approved",
        JoinRequestState::Rejected => "rejected",
        JoinRequestState::Cancelled => "cancelled",
        JoinRequestState::Expired => "expired",
    }
}

fn parse_join_request_state(value: String) -> Result<JoinRequestState, StorageError> {
    match value.as_str() {
        "pending" => Ok(JoinRequestState::Pending),
        "approved" => Ok(JoinRequestState::Approved),
        "rejected" => Ok(JoinRequestState::Rejected),
        "cancelled" => Ok(JoinRequestState::Cancelled),
        "expired" => Ok(JoinRequestState::Expired),
        _ => Err(StorageError::CorruptData(format!(
            "join_requests.state contains {value:?}"
        ))),
    }
}

pub(super) fn sql_integer(value: u64) -> Result<i64, StorageError> {
    i64::try_from(value).map_err(|_| StorageError::IntegerOutOfRange(value))
}

pub(super) fn unsigned_sql_integer(value: i64, field: &'static str) -> Result<u64, StorageError> {
    u64::try_from(value)
        .map_err(|_| StorageError::CorruptData(format!("{field} contains negative value {value}")))
}

pub(super) fn corrupt(
    field: &'static str,
    value: String,
    error: impl std::fmt::Display,
) -> StorageError {
    StorageError::CorruptData(format!("{field} contains {value:?}: {error}"))
}
