use dioxus::prelude::*;
use p2p_browser_platform::{
    LaunchIntent, bootstrap_room, clear_room_session, create_invite, create_session,
    fetch_build_info, join_request_status, new_client_id, take_launch_intent,
};
use p2p_protocol::{JoinRequestStateWire, ParticipantRoleWire, SessionResponse};

use crate::app_runtime::dispatch_app_event;
use crate::app_state::{AppModel, RoomRole, Screen, StoredRoomSession};
use crate::app_transition::{AppEvent, reduce_app_event};
use crate::browser_errors::platform_error_event;
use crate::realtime_session::enter_receiver_room;
use crate::realtime_target::{RealtimeTarget, join_watch_target, member_target};
use crate::room_entry::submit_join;
use crate::room_session::{persist_room_session, restored_room_session};

pub(super) fn initialize(mut model: Signal<AppModel>, target: Signal<Option<RealtimeTarget>>) {
    spawn(async move {
        let launch_intent = take_launch_intent().ok().flatten();
        let (initial_room_code, invite_capability) = match &launch_intent {
            Some(LaunchIntent::JoinRoom {
                room_code,
                capability,
            }) => (room_code.clone(), Some(capability.clone())),
            _ => (String::new(), None),
        };
        let stored_room_session = restored_room_session();
        if let Err(error) = fetch_build_info().await {
            let mut state = model.write();
            reduce_app_event(
                &mut state,
                AppEvent::Navigate(Screen::Lobby {
                    room_code: initial_room_code,
                    invite_capability,
                }),
            );
            drop(state);
            dispatch_app_event(model, platform_error_event(&error));
            return;
        }
        let identity = new_client_id("visitor");
        let suffix = identity
            .chars()
            .rev()
            .take(4)
            .collect::<String>()
            .chars()
            .rev()
            .collect::<String>()
            .to_ascii_uppercase();
        let session = match create_session(&format!("访客 {suffix}")).await {
            Ok(session) => session,
            Err(error) => {
                let mut state = model.write();
                reduce_app_event(
                    &mut state,
                    AppEvent::Navigate(Screen::Lobby {
                        room_code: initial_room_code,
                        invite_capability,
                    }),
                );
                drop(state);
                dispatch_app_event(model, platform_error_event(&error));
                return;
            }
        };
        reduce_app_event(&mut model.write(), AppEvent::SessionReady(session.clone()));

        if let Some(stored) = stored_room_session
            && restore_room(model, target, &session, stored).await
        {
            return;
        }

        reduce_app_event(
            &mut model.write(),
            AppEvent::Navigate(Screen::Lobby {
                room_code: initial_room_code,
                invite_capability,
            }),
        );
        match launch_intent {
            Some(LaunchIntent::JoinRoom { .. }) => submit_join(model, target),
            None => {}
        }
    });
}

async fn restore_room(
    mut model: Signal<AppModel>,
    mut target: Signal<Option<RealtimeTarget>>,
    session: &SessionResponse,
    stored: StoredRoomSession,
) -> bool {
    let Ok(snapshot) = bootstrap_room(&stored.room_code).await else {
        let _ = clear_room_session();
        return false;
    };
    if let Some(participant) = snapshot
        .participants
        .iter()
        .find(|participant| participant.session_id == session.session_id)
    {
        let role = match participant.role {
            ParticipantRoleWire::Owner => RoomRole::Owner,
            ParticipantRoleWire::Receiver => RoomRole::Receiver,
        };
        let invite = if role == RoomRole::Owner {
            if let Some(request_id) = &stored.invite_request_id {
                create_invite(&stored.room_code, request_id).await.ok()
            } else {
                None
            }
        } else {
            None
        };
        let revision = snapshot.revision;
        let room_code = snapshot.room_code.clone();
        {
            let mut state = model.write();
            reduce_app_event(
                &mut state,
                AppEvent::Navigate(Screen::Room {
                    role,
                    snapshot,
                    invite,
                    invite_request_id: stored.invite_request_id.clone(),
                }),
            );
            if role == RoomRole::Owner {
                reduce_app_event(
                    &mut state,
                    AppEvent::SetNotice(Some("房间已创建，可以复制邀请链接".to_owned())),
                );
            }
        }
        let peer_id = stored.peer_id.clone();
        persist_room_session(&StoredRoomSession {
            room_code: room_code.clone(),
            role,
            join_request_id: stored.join_request_id,
            invite_request_id: stored.invite_request_id.clone(),
            peer_id: peer_id.clone(),
        });
        target.set(Some(member_target(room_code, revision, peer_id)));
        return true;
    }

    if let Some(request_id) = stored.join_request_id
        && let Ok(status) = join_request_status(&stored.room_code, &request_id).await
    {
        match status.state {
            JoinRequestStateWire::Pending => {
                reduce_app_event(
                    &mut model.write(),
                    AppEvent::Navigate(Screen::Waiting {
                        room_code: stored.room_code.clone(),
                        request_id: request_id.clone(),
                        peer_id: stored.peer_id.clone(),
                        revision: status.revision,
                        expires_at_ms: status.expires_at_ms,
                    }),
                );
                target.set(Some(join_watch_target(
                    stored.room_code.clone(),
                    request_id.clone(),
                    status.revision,
                )));
                return true;
            }
            JoinRequestStateWire::Approved => {
                enter_receiver_room(model, target, snapshot, request_id, stored.peer_id);
                return true;
            }
            JoinRequestStateWire::Rejected
            | JoinRequestStateWire::Cancelled
            | JoinRequestStateWire::Expired => {}
        }
    }
    let _ = clear_room_session();
    false
}
