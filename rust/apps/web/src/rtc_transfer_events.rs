mod transition;

use dioxus::prelude::*;
use p2p_browser_platform::{RtcEvent, send_notification};

use crate::app_state::AppModel;
use transition::{NotificationEffect, plan_transfer_event};

fn execute_effect(effect: &NotificationEffect) {
    let _ = send_notification(&effect.title, &effect.body, &effect.tag);
}

pub(super) fn handle_transfer_event(mut model: Signal<AppModel>, peer_id: String, event: RtcEvent) {
    let plan = {
        let state = model.peek();
        plan_transfer_event(&state, peer_id, event)
    };

    if let Some(effect) = plan.notification() {
        execute_effect(effect);
    }
    if plan.changes_model() {
        let mut state = model.write();
        plan.apply(&mut state);
    }
}
