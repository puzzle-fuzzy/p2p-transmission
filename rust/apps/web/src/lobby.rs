use dioxus::prelude::*;
use p2p_browser_platform::prime_notification_permission;
use p2p_ui_shell::{
    CREATE_ROOM_LABEL, JOIN_REQUEST_LABEL, LobbyFeedback, LobbyShell, ROOM_CODE_LENGTH,
};

use crate::about::FooterLinks;
use crate::app_state::{AppModel, Screen};
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
    let feedback = snapshot
        .error
        .clone()
        .map(LobbyFeedback::error)
        .unwrap_or_default();
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
        LobbyShell {
            room_code: rsx! {
                RoomCodeInput {
                    value: room_code,
                    disabled: snapshot.busy,
                    invalid: snapshot.error.is_some(),
                    on_change: move |value| {
                        let mut state = model.write();
                        if let Screen::Lobby { room_code, invite_capability } = &mut state.screen {
                            *room_code = value;
                            *invite_capability = None;
                        }
                        state.error = None;
                    }
                }
            },
            footer: rsx! { FooterLinks { model } },
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
