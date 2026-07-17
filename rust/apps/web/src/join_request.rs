use dioxus::prelude::*;
use p2p_browser_platform::{bootstrap_room, decide_join, show_modal_dialog};
use p2p_protocol::{JoinDecisionRequest, JoinRequestSnapshot};

use crate::app_state::{AppModel, Screen};
use crate::browser_errors::friendly_error;
use crate::participant_presence::Avatar;
use crate::realtime_connection::{current_realtime_target_scope, realtime_target_scope_is_current};
use crate::realtime_session::{apply_snapshot, schedule_avatar_cleanup};
use crate::realtime_target::{RealtimeTarget, RealtimeTargetScope};

#[component]
pub(super) fn JoinRequestDialog(
    mut model: Signal<AppModel>,
    realtime_target: Signal<Option<RealtimeTarget>>,
    request: JoinRequestSnapshot,
) -> Element {
    use_effect(|| {
        let _ = show_modal_dialog("join-request-dialog");
    });
    let decision_pending = use_memo(move || model.read().decision_request_id.is_some());
    let pending = decision_pending();
    rsx! {
        dialog {
                id: "join-request-dialog",
                class: "join-request-dialog",
                aria_labelledby: "join-request-title",
                oncancel: move |event| event.prevent_default(),
                div { class: "request-person",
                    Avatar { seed: request.session_id.clone(), label: request.display_name.clone(), entering: false, highlighted: false }
                    div {
                        h2 { id: "join-request-title", "加入申请" }
                        p { "{request.display_name}" }
                    }
                }
                div { class: "request-summary",
                    p { "请求加入当前房间" }
                    span { "申请将在授权时间结束后失效" }
                }
                div { class: "dialog-actions",
                    button {
                        class: "secondary-button",
                        r#type: "button",
                        disabled: pending,
                        onclick: {
                            let request_id = request.request_id.clone();
                            move |_| {
                                submit_decision(
                                    model,
                                    realtime_target,
                                    request_id.clone(),
                                    JoinDecisionRequest::Reject,
                                )
                            }
                        },
                        if pending { "处理中…" } else { "拒绝" }
                    }
                    button {
                        class: "primary-button",
                        r#type: "button",
                        disabled: pending,
                        onclick: {
                            let request_id = request.request_id.clone();
                            move |_| {
                                submit_decision(
                                    model,
                                    realtime_target,
                                    request_id.clone(),
                                    JoinDecisionRequest::Approve,
                                )
                            }
                        },
                        if pending { "处理中…" } else { "允许加入" }
                    }
                }
        }
    }
}

fn decision_operation_is_current(
    model: Signal<AppModel>,
    realtime_target: Signal<Option<RealtimeTarget>>,
    target_scope: &RealtimeTargetScope,
    request_id: &str,
) -> bool {
    realtime_target_scope_is_current(target_scope, realtime_target)
        && model.peek().decision_request_id.as_deref() == Some(request_id)
}

fn submit_decision(
    mut model: Signal<AppModel>,
    realtime_target: Signal<Option<RealtimeTarget>>,
    request_id: String,
    decision: JoinDecisionRequest,
) {
    if model.read().decision_request_id.is_some() {
        return;
    }
    let Some(target_scope) = current_realtime_target_scope(realtime_target) else {
        return;
    };
    let (room_code, revision) = {
        let state = model.read();
        let Screen::Room { snapshot, .. } = &state.screen else {
            return;
        };
        (snapshot.room_code.clone(), snapshot.revision)
    };
    model.write().decision_request_id = Some(request_id.clone());
    spawn(async move {
        let decision_result = decide_join(&room_code, &request_id, decision, Some(revision)).await;
        if !decision_operation_is_current(model, realtime_target, &target_scope, &request_id) {
            return;
        }

        let result = match decision_result {
            Ok(_) => bootstrap_room(&room_code).await,
            Err(error) => Err(error),
        };
        if !decision_operation_is_current(model, realtime_target, &target_scope, &request_id) {
            return;
        }

        match result {
            Ok(snapshot) => {
                let entering = apply_snapshot(&mut model.write(), snapshot);
                if let Some(entering) = entering {
                    schedule_avatar_cleanup(model, entering);
                }
            }
            Err(error) => model.write().error = Some(friendly_error(&error)),
        }
        if decision_operation_is_current(model, realtime_target, &target_scope, &request_id) {
            model.write().decision_request_id = None;
        }
    });
}
