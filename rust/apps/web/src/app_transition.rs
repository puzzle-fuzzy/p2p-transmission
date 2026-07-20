use p2p_protocol::SessionResponse;

use crate::app_state::{AppModel, RealtimePhase, Screen};

#[derive(Clone, Debug, PartialEq)]
pub(super) enum AppEvent {
    SessionReady(SessionResponse),
    Navigate(Screen),
    SetRealtime(RealtimePhase),
    SetBusy(bool),
    SetNotice(Option<String>),
    SetError(Option<String>),
    SetAboutOpen(bool),
    SetDecisionRequest(Option<String>),
    UpgradeRequired,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum AppEffect {
    ShowUpgradePrompt,
}

/// Apply a user, network or lifecycle event to plain application state.
/// Platform work is returned as an explicit effect and runs after the state
/// borrow has ended.
pub(super) fn reduce_app_event(model: &mut AppModel, event: AppEvent) -> Vec<AppEffect> {
    match event {
        AppEvent::SessionReady(session) => model.session = Some(session),
        AppEvent::Navigate(screen) => model.screen = screen,
        AppEvent::SetRealtime(phase) => model.realtime = phase,
        AppEvent::SetBusy(busy) => model.busy = busy,
        AppEvent::SetNotice(notice) => model.notice = notice,
        AppEvent::SetError(error) => model.error = error,
        AppEvent::SetAboutOpen(open) => model.about_open = open,
        AppEvent::SetDecisionRequest(request_id) => model.decision_request_id = request_id,
        AppEvent::UpgradeRequired => {
            model.busy = false;
            return vec![AppEffect::ShowUpgradePrompt];
        }
    }
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upgrade_event_is_explicit_and_stops_busy_state() {
        let mut model = AppModel {
            busy: true,
            ..AppModel::default()
        };
        let effects = reduce_app_event(&mut model, AppEvent::UpgradeRequired);
        assert!(!model.busy);
        assert_eq!(effects, vec![AppEffect::ShowUpgradePrompt]);
    }
}
