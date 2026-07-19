use std::collections::BTreeMap;

use dioxus::prelude::*;
use p2p_browser_platform::{
    RealtimeConnection, RealtimeEvent, RtcPeer, activate_app_mount, mark_app_interactive,
};
use p2p_protocol::RoomBootstrapResponse;
use p2p_ui_shell::VaultShell;

mod about;
mod app_bootstrap;
mod app_state;
mod appearance;
mod browser_errors;
mod browser_lifecycle;
mod icons;
mod join_request;
mod lobby;
mod participant_presence;
mod realtime_connection;
mod realtime_event_reducer;
mod realtime_runtime;
mod realtime_session;
mod realtime_target;
mod room_code_input;
mod room_entry;
mod room_session;
mod room_view;
mod rtc_config;
mod rtc_orchestration;
mod rtc_session;
mod rtc_transfer_events;
mod rtc_transition;
mod share_dialog;
mod transfer_actions;
mod transfer_panel;
mod transfer_presentation;
mod waiting_room;

use about::{AboutDialog, FooterLinks};
use app_bootstrap::initialize;
use app_state::{AppModel, Screen};
use appearance::{Appearance, AppearanceDialog};
use browser_lifecycle::{sync_lifecycle_recovery_target, use_browser_lifecycle};
use lobby::LobbyView;
use realtime_connection::{RealtimeLease, use_realtime_connection};
use realtime_runtime::{
    LifecycleState, RealtimeConnectionRuntime, RealtimeConnectionState, RealtimeSessionRuntime,
    RtcRuntime, ScopedRtcConfig,
};
use realtime_session::{
    apply_authoritative_snapshot, handle_realtime_event, schedule_avatar_cleanup,
};
use realtime_target::{RealtimeTarget, RealtimeTargetScope};
use room_view::RoomView;
use rtc_config::use_rtc_config_session;
use waiting_room::WaitingView;

#[derive(Clone, Copy, Eq, PartialEq)]
enum AppRoute {
    Booting,
    Lobby,
    Waiting,
    Room,
}

fn app_route(screen: &Screen) -> AppRoute {
    match screen {
        Screen::Booting => AppRoute::Booting,
        Screen::Lobby { .. } => AppRoute::Lobby,
        Screen::Waiting { .. } => AppRoute::Waiting,
        Screen::Room { .. } => AppRoute::Room,
    }
}

fn app_shell_state(state: &AppModel) -> (AppRoute, bool, bool) {
    (
        app_route(&state.screen),
        state.about_open,
        state.session.is_some(),
    )
}

fn main() {
    console_error_panic_hook::set_once();
    dioxus::launch(App);
}

#[allow(non_snake_case)]
fn App() -> Element {
    let model = use_signal(AppModel::default);
    let appearance = use_signal(Appearance::load);
    let mut appearance_open = use_signal(|| false);
    let realtime_target = use_signal(|| None::<RealtimeTarget>);
    let connection = use_signal(|| None::<RealtimeConnection>);
    let realtime_connection = RealtimeConnectionRuntime {
        trigger: use_signal(|| 0_u64),
        state: use_signal(RealtimeConnectionState::default),
    };
    let rtc_peers = use_signal(BTreeMap::<String, RtcPeer>::new);
    let rtc_config = use_signal(|| None::<ScopedRtcConfig>);
    let lifecycle_state = use_signal(LifecycleState::default);
    let rtc_runtime = RtcRuntime {
        connection,
        peers: rtc_peers,
        config: rtc_config,
    };
    let realtime_runtime = RealtimeSessionRuntime {
        model,
        target: realtime_target,
        connection: realtime_connection,
        rtc: rtc_runtime,
        lifecycle_state,
    };
    let app_shell = use_memo(move || {
        let state = model.read();
        app_shell_state(&state)
    });

    let apply_lifecycle_snapshot = Callback::new(
        move |(lease, snapshot): (RealtimeLease, RoomBootstrapResponse)| {
            if let Some(entering) = apply_authoritative_snapshot(realtime_runtime, &lease, snapshot)
            {
                schedule_avatar_cleanup(model, entering);
            }
        },
    );
    use_browser_lifecycle(realtime_runtime, apply_lifecycle_snapshot);

    let sync_lifecycle_target = Callback::new(move |scope: Option<RealtimeTargetScope>| {
        sync_lifecycle_recovery_target(lifecycle_state, scope.as_ref());
    });
    let dispatch_realtime_event =
        Callback::new(move |(lease, event): (RealtimeLease, RealtimeEvent)| {
            handle_realtime_event(realtime_runtime, lease, event);
        });
    use_realtime_connection(
        realtime_runtime,
        dispatch_realtime_event,
        sync_lifecycle_target,
    );

    use_effect(move || initialize(model, realtime_target));
    use_effect(move || {
        let (route, _, session_ready) = *app_shell.read();
        if route == AppRoute::Booting {
            return;
        }
        activate_app_mount();
        if !session_ready {
            return;
        }
        mark_app_interactive();
    });

    use_rtc_config_session(realtime_runtime);

    let (route, about_open, _) = *app_shell.read();
    let card_class = match route {
        AppRoute::Booting => "vault-card",
        AppRoute::Lobby => "vault-card vault-card-lobby",
        AppRoute::Waiting => "vault-card vault-card-waiting",
        AppRoute::Room => "vault-card vault-card-room",
    };
    rsx! {
        if route != AppRoute::Booting {
            VaultShell {
                card_class: card_class.to_owned(),
                on_preferences: move |_| appearance_open.set(true),
                footer: rsx! { FooterLinks { model } },
                content: match route {
                    AppRoute::Booting => rsx! {},
                    AppRoute::Lobby => rsx! { LobbyView { model, realtime_target } },
                    AppRoute::Waiting => rsx! { WaitingView { model, realtime_target } },
                    AppRoute::Room => rsx! { RoomView { model, realtime_target, rtc_peers } },
                }
            }
        }
        if appearance_open() {
            AppearanceDialog { appearance, open: appearance_open }
        }
        if about_open {
            AboutDialog { model }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_state::TransferState;

    #[test]
    fn app_shell_selector_ignores_transfer_only_updates() {
        let mut model = AppModel::default();
        let initial = app_shell_state(&model);

        model
            .transfers_by_peer
            .insert("peer-1".to_owned(), TransferState::Idle);
        assert!(app_shell_state(&model) == initial);

        model.about_open = true;
        assert!(app_shell_state(&model) != initial);
    }
}
