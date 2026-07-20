use dioxus::prelude::*;
use p2p_browser_platform::set_document_attribute;

use crate::app_state::AppModel;
use crate::app_transition::{AppEffect, AppEvent, reduce_app_event};

pub(super) fn dispatch_app_event(mut model: Signal<AppModel>, event: AppEvent) {
    let effects = {
        let mut state = model.write();
        reduce_app_event(&mut state, event)
    };
    for effect in effects {
        execute_app_effect(effect);
    }
}

fn execute_app_effect(effect: AppEffect) {
    match effect {
        AppEffect::ShowUpgradePrompt => {
            let _ = set_document_attribute("data-p2p-upgrade", "true");
        }
    }
}
