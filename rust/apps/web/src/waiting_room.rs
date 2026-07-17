use dioxus::prelude::*;
use p2p_browser_platform::{leave_room, new_client_id};

use crate::app_state::{AppModel, RealtimePhase, Screen};
use crate::browser_errors::friendly_error;
use crate::participant_presence::Avatar;
use crate::realtime_session::return_to_lobby;
use crate::realtime_target::RealtimeTarget;

#[component]
pub(super) fn WaitingView(
    mut model: Signal<AppModel>,
    mut realtime_target: Signal<Option<RealtimeTarget>>,
) -> Element {
    let snapshot = model.read().clone();
    let Screen::Waiting {
        room_code,
        expires_at_ms,
        ..
    } = snapshot.screen
    else {
        return rsx! {};
    };
    let session = snapshot.session.clone();
    let realtime_copy = match snapshot.realtime {
        RealtimePhase::Connected => "已送达发送者，正在等待确认",
        RealtimePhase::Reconnecting => "连接中断，正在重新连接",
        RealtimePhase::Superseded => "已在另一个标签页接管，本页已停止重连",
        _ => "正在连接房间",
    };

    rsx! {
        section { class: "waiting-view", aria_labelledby: "waiting-title",
            if let Some(session) = session {
                Avatar { seed: session.session_id, label: session.display_name.clone(), entering: false, highlighted: false }
                p { class: "participant-name", "{session.display_name}" }
            }
            p { class: "subtle-copy", "正在申请加入房间" }
            div { class: "waiting-card",
                h1 { id: "waiting-title", "等待发送者确认" }
                p { class: "waiting-code", "{room_code}" }
                p { class: "waiting-status", role: "status", "{realtime_copy}" }
                p { class: "waiting-expiry", "申请会在房间授权过期后自动失效" }
                span { class: "sr-only", "授权过期时间 {expires_at_ms}" }
            }
            if let Some(error) = snapshot.error {
                p { class: "inline-error", role: "alert", "{error}" }
            }
            button {
                class: "secondary-button waiting-change-button",
                r#type: "button",
                disabled: snapshot.busy,
                onclick: move |_| submit_cancel_waiting(model, realtime_target),
                if snapshot.busy { "正在取消…" } else { "更换房间" }
            }
        }
    }
}

fn submit_cancel_waiting(
    mut model: Signal<AppModel>,
    realtime_target: Signal<Option<RealtimeTarget>>,
) {
    let (room_code, revision) = {
        let state = model.read();
        let Screen::Waiting {
            room_code,
            revision,
            ..
        } = &state.screen
        else {
            return;
        };
        (room_code.clone(), *revision)
    };
    model.write().busy = true;
    spawn(async move {
        match leave_room(&room_code, &new_client_id("cancel_join"), Some(revision)).await {
            Ok(_) => return_to_lobby(model, realtime_target, None),
            Err(error) => {
                let mut state = model.write();
                state.busy = false;
                state.error = Some(friendly_error(&error));
            }
        }
    });
}
