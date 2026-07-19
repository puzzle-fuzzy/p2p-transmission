use dioxus::prelude::*;
use p2p_browser_platform::prime_notification_permission;
use p2p_ui_shell::{
    CREATE_ROOM_LABEL, JOIN_REQUEST_LABEL, LobbyFeedback, LobbyPanel, ROOM_CODE_LENGTH,
};

use crate::app_state::{AppModel, LobbyActionError, Screen};
use crate::realtime_target::RealtimeTarget;
use crate::room_code_input::RoomCodeInput;
use crate::room_entry::{submit_create_room, submit_join};

#[component]
pub(super) fn LobbyView(
    mut model: Signal<AppModel>,
    mut realtime_target: Signal<Option<RealtimeTarget>>,
) -> Element {
    let snapshot = model.read().clone();
    let (room_code, invite_capability) = match &snapshot.screen {
        Screen::Lobby {
            room_code,
            invite_capability,
        } => (room_code.clone(), invite_capability.clone()),
        _ => return rsx! {},
    };
    let can_join =
        room_code.len() == ROOM_CODE_LENGTH && !snapshot.busy && snapshot.session.is_some();
    let (feedback, room_code_invalid) = lobby_feedback(
        snapshot.lobby_action_error.as_ref(),
        snapshot.error.as_deref(),
    );
    let primary_label = if snapshot.busy {
        "申请中…"
    } else if invite_capability.is_some() {
        "加入房间"
    } else {
        JOIN_REQUEST_LABEL
    };
    let secondary_label = if snapshot.busy {
        "创建中…"
    } else {
        CREATE_ROOM_LABEL
    };

    rsx! {
        LobbyPanel {
            room_code: rsx! {
                RoomCodeInput {
                    value: room_code,
                    disabled: snapshot.busy,
                    invalid: room_code_invalid,
                    on_change: move |value| {
                        let mut state = model.write();
                        if let Screen::Lobby { room_code, invite_capability } = &mut state.screen {
                            *room_code = value;
                            *invite_capability = None;
                        }
                        if matches!(
                            state.lobby_action_error.as_ref(),
                            Some(LobbyActionError::Join(_))
                        ) {
                            state.lobby_action_error = None;
                        }
                    }
                }
            },
            feedback,
            invite_ready: invite_capability.is_some(),
            primary_label: primary_label.to_owned(),
            primary_disabled: !can_join,
            secondary_label: secondary_label.to_owned(),
            secondary_disabled: snapshot.busy || snapshot.session.is_none(),
            on_submit: move |_| {
                let join_ready = {
                    let state = model.read();
                    !state.busy
                        && state.session.is_some()
                        && matches!(
                            &state.screen,
                            Screen::Lobby { room_code, .. }
                                if room_code.len() == ROOM_CODE_LENGTH
                        )
                };
                if join_ready {
                    let _ = prime_notification_permission();
                    submit_join(model, realtime_target);
                }
            },
            on_create: move |_| {
                let _ = prime_notification_permission();
                submit_create_room(model, realtime_target);
            },
        }
    }
}

fn lobby_feedback(
    action_error: Option<&LobbyActionError>,
    system_error: Option<&str>,
) -> (LobbyFeedback, bool) {
    match action_error {
        Some(LobbyActionError::Join(message)) => (LobbyFeedback::join_error(message.clone()), true),
        Some(LobbyActionError::Create(message)) => {
            (LobbyFeedback::create_error(message.clone()), false)
        }
        None => (
            system_error.map(LobbyFeedback::error).unwrap_or_default(),
            false,
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_join_errors_invalidate_the_room_code() {
        let join_error = LobbyActionError::Join("房间不存在".to_owned());
        let create_error = LobbyActionError::Create("暂时无法创建房间".to_owned());

        assert_eq!(
            lobby_feedback(Some(&join_error), None),
            (LobbyFeedback::JoinError("房间不存在".to_owned()), true)
        );
        assert_eq!(
            lobby_feedback(Some(&create_error), None),
            (
                LobbyFeedback::CreateError("暂时无法创建房间".to_owned()),
                false
            )
        );
        assert_eq!(
            lobby_feedback(None, Some("安全会话初始化失败")),
            (LobbyFeedback::Error("安全会话初始化失败".to_owned()), false)
        );
    }
}
