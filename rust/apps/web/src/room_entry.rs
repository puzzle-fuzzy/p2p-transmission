use dioxus::prelude::*;
use p2p_browser_platform::{
    BrowserPlatformError, bootstrap_room, create_invite, create_room, new_client_id, request_join,
};
use p2p_ui_shell::ROOM_CODE_LENGTH;

use crate::app_state::{AppModel, RoomRole, Screen, StoredRoomSession};
use crate::browser_errors::friendly_error;
use crate::realtime_target::{RealtimeTarget, join_watch_target, member_target};
use crate::room_session::persist_room_session;

pub(super) fn submit_create_room(
    mut model: Signal<AppModel>,
    mut realtime_target: Signal<Option<RealtimeTarget>>,
) {
    if model.read().busy || model.read().session.is_none() {
        return;
    }
    model.write().busy = true;
    model.write().error = None;
    spawn(async move {
        let create_request_id = new_client_id("create");
        let invite_request_id = new_client_id("invite");
        let result = async {
            let room = create_room(&create_request_id).await?;
            let invite = create_invite(&room.room_code, &invite_request_id).await?;
            let snapshot = bootstrap_room(&room.room_code).await?;
            Ok::<_, BrowserPlatformError>((snapshot, invite))
        }
        .await;
        match result {
            Ok((snapshot, invite)) => {
                let peer_id = new_client_id("peer");
                let stored = StoredRoomSession {
                    room_code: snapshot.room_code.clone(),
                    role: RoomRole::Owner,
                    join_request_id: None,
                    invite_request_id: Some(invite_request_id.clone()),
                    peer_id: peer_id.clone(),
                };
                persist_room_session(&stored);
                let revision = snapshot.revision;
                let room_code = snapshot.room_code.clone();
                {
                    let mut state = model.write();
                    state.busy = false;
                    state.notice = Some("房间已创建，可以分享邀请链接".to_owned());
                    state.screen = Screen::Room {
                        role: RoomRole::Owner,
                        snapshot,
                        invite: Some(invite),
                        invite_request_id: Some(invite_request_id),
                    };
                }
                realtime_target.set(Some(member_target(room_code, revision, peer_id)));
            }
            Err(error) => {
                let mut state = model.write();
                state.busy = false;
                state.error = Some(friendly_error(&error));
            }
        }
    });
}

pub(super) fn submit_join(
    mut model: Signal<AppModel>,
    mut realtime_target: Signal<Option<RealtimeTarget>>,
) {
    let snapshot = model.read().clone();
    let Screen::Lobby {
        room_code,
        invite_capability,
    } = snapshot.screen
    else {
        return;
    };
    if snapshot.busy || room_code.len() != ROOM_CODE_LENGTH || snapshot.session.is_none() {
        return;
    }
    model.write().busy = true;
    model.write().error = None;
    spawn(async move {
        let request_id = new_client_id("join");
        match request_join(&room_code, &request_id, None, invite_capability.clone()).await {
            Ok(response) => {
                let peer_id = new_client_id("peer");
                persist_room_session(&StoredRoomSession {
                    room_code: room_code.clone(),
                    role: RoomRole::Receiver,
                    join_request_id: Some(request_id.clone()),
                    invite_request_id: None,
                    peer_id: peer_id.clone(),
                });
                {
                    let mut state = model.write();
                    state.busy = false;
                    state.screen = Screen::Waiting {
                        room_code: room_code.clone(),
                        request_id: request_id.clone(),
                        peer_id,
                        revision: response.revision,
                        expires_at_ms: response.expires_at_ms,
                    };
                }
                realtime_target.set(Some(join_watch_target(
                    room_code.clone(),
                    request_id.clone(),
                    response.revision,
                )));
            }
            Err(error) => {
                let mut state = model.write();
                state.busy = false;
                state.error = Some(friendly_error(&error));
            }
        }
    });
}
