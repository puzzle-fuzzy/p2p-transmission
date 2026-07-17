use p2p_browser_platform::{clear_room_session, load_room_session, save_room_session};

use crate::app_state::StoredRoomSession;

pub(super) fn restored_room_session() -> Option<StoredRoomSession> {
    let value = load_room_session().ok().flatten()?;
    match serde_json::from_str(&value) {
        Ok(session) => Some(session),
        Err(_) => {
            let _ = clear_room_session();
            None
        }
    }
}

pub(super) fn persist_room_session(value: &StoredRoomSession) {
    if let Ok(value) = serde_json::to_string(value) {
        let _ = save_room_session(&value);
    }
}
