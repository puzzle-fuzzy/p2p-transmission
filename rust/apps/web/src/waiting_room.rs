use dioxus::prelude::*;
use p2p_browser_platform::{leave_room, new_client_id};

use crate::app_runtime::dispatch_app_event;
use crate::app_state::{AppModel, RealtimePhase, Screen};
use crate::app_transition::AppEvent;
use crate::browser_errors::platform_error_event;
use crate::participant_presence::Avatar;
use crate::realtime_session::return_to_lobby;
use crate::realtime_target::{RealtimeTarget, RealtimeTargetScope};

#[derive(Clone)]
struct WaitingCancelScope {
    room_code: String,
    request_id: String,
    target: Option<RealtimeTargetScope>,
}

impl WaitingCancelScope {
    fn is_current(&self, state: &AppModel, target: Option<&RealtimeTarget>) -> bool {
        let same_request = matches!(
            &state.screen,
            Screen::Waiting {
                room_code,
                request_id,
                ..
            } if room_code == &self.room_code && request_id == &self.request_id
        );
        same_request
            && match &self.target {
                Some(scope) => scope.is_current(target),
                None => target.is_none(),
            }
    }
}

#[component]
pub(super) fn WaitingView(
    model: Signal<AppModel>,
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
        section { class: "waiting-view workspace-panel panel-motion-forward", aria_labelledby: "waiting-title",
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
                class: "btn btn--ghost waiting-change-button",
                r#type: "button",
                disabled: snapshot.busy,
                onclick: move |_| submit_cancel_waiting(model, realtime_target),
                if snapshot.busy { "正在取消…" } else { "更换房间" }
            }
        }
    }
}

fn submit_cancel_waiting(model: Signal<AppModel>, realtime_target: Signal<Option<RealtimeTarget>>) {
    let (room_code, request_id, revision) = {
        let state = model.read();
        let Screen::Waiting {
            room_code,
            request_id,
            revision,
            ..
        } = &state.screen
        else {
            return;
        };
        (room_code.clone(), request_id.clone(), *revision)
    };
    let cancel_scope = WaitingCancelScope {
        room_code: room_code.clone(),
        request_id,
        target: realtime_target
            .read()
            .as_ref()
            .cloned()
            .map(RealtimeTargetScope::new),
    };
    dispatch_app_event(model, AppEvent::SetBusy(true));
    spawn(async move {
        let result = leave_room(&room_code, &new_client_id("cancel_join"), Some(revision)).await;
        if !cancel_scope.is_current(&model.read(), realtime_target.read().as_ref()) {
            return;
        }
        match result {
            Ok(_) => return_to_lobby(model, realtime_target, None),
            Err(error) => {
                dispatch_app_event(model, AppEvent::SetBusy(false));
                dispatch_app_event(model, platform_error_event(&error));
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::realtime_target::join_watch_target;

    fn waiting_model() -> AppModel {
        AppModel {
            screen: Screen::Waiting {
                room_code: "ABC234".to_owned(),
                request_id: "request-1".to_owned(),
                peer_id: "peer-receiver".to_owned(),
                revision: 1,
                expires_at_ms: 1_000,
            },
            ..AppModel::default()
        }
    }

    #[test]
    fn cancel_scope_rejects_a_replacement_join_request_target() {
        let mut model = waiting_model();
        let target = join_watch_target("ABC234".to_owned(), "request-1".to_owned(), 1);
        let scope = WaitingCancelScope {
            room_code: "ABC234".to_owned(),
            request_id: "request-1".to_owned(),
            target: Some(RealtimeTargetScope::new(target.clone())),
        };

        assert!(scope.is_current(&model, Some(&target)));

        let replacement = join_watch_target("ABC234".to_owned(), "request-1".to_owned(), 1);
        assert!(!scope.is_current(&model, Some(&replacement)));

        model.screen = Screen::Lobby {
            room_code: String::new(),
            invite_capability: None,
        };
        assert!(!scope.is_current(&model, Some(&target)));
    }
}
