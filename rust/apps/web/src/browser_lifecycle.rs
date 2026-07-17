use dioxus::prelude::*;
use p2p_browser_platform::{
    BrowserLifecycleEvent, SLEEP_RESUME_GAP_MS, bootstrap_room, connect_browser_lifecycle,
};
use p2p_protocol::RoomBootstrapResponse;

use crate::app_state::{AppModel, RealtimePhase, RtcPhase, Screen};
use crate::browser_errors::friendly_error;
use crate::realtime_connection::{
    RealtimeLease, current_realtime_lease, current_realtime_target_scope,
    invalidate_realtime_lease, realtime_lease_is_current, realtime_target_is_suppressed,
    schedule_reconnect,
};
use crate::realtime_runtime::{
    LifecycleRecovery, LifecycleState, RealtimeSessionRuntime, RtcRuntime,
};
use crate::realtime_target::RealtimeTargetScope;
use crate::rtc_orchestration::{mark_streamed_transfers_waiting, refresh_aggregate_rtc};

const BACKGROUND_CONTROL_RECOVERY_MS: u64 = 15_000;

impl LifecycleState {
    fn sync_target(&mut self, target: Option<&RealtimeTargetScope>) {
        if self.recovery.as_ref().is_some_and(|recovery| {
            !target.is_some_and(|target| recovery.target.is_same_instance(target))
        }) {
            self.recovery = None;
        }
    }

    fn begin_recovery(&mut self, target: &RealtimeTargetScope, rebuild_peers: bool) {
        self.sync_target(Some(target));
        match self.recovery.as_mut() {
            Some(recovery) => {
                recovery.rebuild_resumable_peers_after_attach |= rebuild_peers;
            }
            None => {
                self.recovery = Some(LifecycleRecovery {
                    target: target.clone(),
                    rebuild_resumable_peers_after_attach: rebuild_peers,
                });
            }
        }
    }

    fn take_recovery(&mut self, target: &RealtimeTargetScope) -> Option<bool> {
        let recovery = self.recovery.take()?;
        recovery
            .target
            .is_same_instance(target)
            .then_some(recovery.rebuild_resumable_peers_after_attach)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum LifecycleRecoveryAction {
    None,
    ControlPlane,
    RebuildResumablePeers,
}

pub(super) fn use_browser_lifecycle(
    runtime: RealtimeSessionRuntime,
    apply_snapshot: Callback<(RealtimeLease, RoomBootstrapResponse)>,
) {
    let mut model = runtime.model;
    use_hook(move || {
        let on_event = Callback::new(move |event| {
            handle_browser_lifecycle_event(runtime, event, apply_snapshot);
        });
        match connect_browser_lifecycle(on_event.into_closure()) {
            Ok(active) => Some(active),
            Err(error) => {
                model.write().error = Some(friendly_error(&error));
                None
            }
        }
    });
}

pub(super) fn sync_lifecycle_recovery_target(
    mut lifecycle_state: Signal<LifecycleState>,
    target: Option<&RealtimeTargetScope>,
) {
    lifecycle_state.write().sync_target(target);
}

fn lifecycle_recovery_action(
    event: BrowserLifecycleEvent,
    state: &LifecycleState,
) -> LifecycleRecoveryAction {
    match event {
        BrowserLifecycleEvent::Hidden | BrowserLifecycleEvent::Offline => {
            LifecycleRecoveryAction::None
        }
        BrowserLifecycleEvent::Online => LifecycleRecoveryAction::RebuildResumablePeers,
        BrowserLifecycleEvent::Visible { .. } if state.network_recovery_pending => {
            LifecycleRecoveryAction::RebuildResumablePeers
        }
        BrowserLifecycleEvent::Visible { hidden_ms }
            if hidden_ms >= BACKGROUND_CONTROL_RECOVERY_MS =>
        {
            LifecycleRecoveryAction::ControlPlane
        }
        BrowserLifecycleEvent::Visible { .. } => LifecycleRecoveryAction::None,
        BrowserLifecycleEvent::Resumed { gap_ms }
            if !state.hidden && gap_ms >= SLEEP_RESUME_GAP_MS =>
        {
            LifecycleRecoveryAction::RebuildResumablePeers
        }
        BrowserLifecycleEvent::Resumed { .. } => LifecycleRecoveryAction::None,
    }
}

fn handle_browser_lifecycle_event(
    runtime: RealtimeSessionRuntime,
    event: BrowserLifecycleEvent,
    apply_snapshot: Callback<(RealtimeLease, RoomBootstrapResponse)>,
) {
    let RealtimeSessionRuntime {
        mut model,
        target: realtime_target,
        connection: realtime_connection,
        mut rtc,
        mut lifecycle_state,
    } = runtime;
    let action = {
        let current = lifecycle_state.read().clone();
        let action = lifecycle_recovery_action(event, &current);
        let mut state = lifecycle_state.write();
        match event {
            BrowserLifecycleEvent::Hidden => state.hidden = true,
            BrowserLifecycleEvent::Visible { .. } => {
                state.hidden = false;
                if action != LifecycleRecoveryAction::None {
                    state.network_recovery_pending = false;
                }
            }
            BrowserLifecycleEvent::Offline => state.network_recovery_pending = true,
            BrowserLifecycleEvent::Online => {
                if action != LifecycleRecoveryAction::None {
                    state.network_recovery_pending = false;
                }
            }
            BrowserLifecycleEvent::Resumed { .. } => {}
        }
        action
    };

    let Some(target_scope) = current_realtime_target_scope(realtime_target) else {
        lifecycle_state.write().sync_target(None);
        return;
    };
    lifecycle_state.write().sync_target(Some(&target_scope));
    if realtime_target_is_suppressed(realtime_connection, realtime_target) {
        return;
    }

    if event == BrowserLifecycleEvent::Offline {
        lifecycle_state.write().begin_recovery(&target_scope, true);
        invalidate_realtime_lease(realtime_connection);
        rtc.connection.set(None);
        {
            let mut state = model.write();
            state.realtime = RealtimePhase::Reconnecting;
            let has_stream = mark_streamed_transfers_waiting(&mut state);
            state.notice = Some(if has_stream {
                "网络已断开，恢复后将从最后检查点继续传输".to_owned()
            } else {
                "网络已断开，恢复后会自动重新连接".to_owned()
            });
        }
        if let Some(lease) = current_realtime_lease(realtime_connection, realtime_target) {
            schedule_reconnect(realtime_connection, realtime_target, model, lease);
        }
        return;
    }

    if action == LifecycleRecoveryAction::None {
        return;
    }

    lifecycle_state.write().begin_recovery(
        &target_scope,
        action == LifecycleRecoveryAction::RebuildResumablePeers,
    );

    {
        let mut state = model.write();
        state.realtime = RealtimePhase::Reconnecting;
        state.error = None;
        let has_stream = mark_streamed_transfers_waiting(&mut state);
        if has_stream {
            state.notice = Some("正在恢复连接，将从最后检查点继续传输".to_owned());
        } else {
            state.notice = Some("正在恢复连接".to_owned());
        }
    }

    invalidate_realtime_lease(realtime_connection);
    rtc.connection.set(None);
    let lease = current_realtime_lease(realtime_connection, realtime_target);
    if let Some(lease) = lease.clone() {
        schedule_reconnect(realtime_connection, realtime_target, model, lease);
    }

    let room_code = match &model.read().screen {
        Screen::Room { snapshot, .. } => Some(snapshot.room_code.clone()),
        _ => None,
    };
    if let Some(room_code) = room_code {
        spawn(async move {
            let result = bootstrap_room(&room_code).await;
            let Some(lease) = lease.as_ref() else {
                return;
            };
            if !realtime_lease_is_current(lease, realtime_connection, realtime_target) {
                return;
            }
            match result {
                Ok(snapshot) => apply_snapshot.call((lease.clone(), snapshot)),
                Err(error) => model.write().error = Some(friendly_error(&error)),
            }
        });
    }
}

pub(super) fn complete_lifecycle_recovery(
    mut model: Signal<AppModel>,
    rtc: RtcRuntime,
    mut lifecycle_state: Signal<LifecycleState>,
    target: &RealtimeTargetScope,
    allow_peer_rebuild: bool,
) -> bool {
    let Some(should_rebuild) = lifecycle_state.write().take_recovery(target) else {
        return false;
    };
    if !allow_peer_rebuild || !should_rebuild {
        return true;
    }

    let peers = rtc
        .peers
        .read()
        .iter()
        .filter(|(_, peer)| peer.resumable_transfer_active() || !peer.data_channel_ready())
        .map(|(peer_id, peer)| (peer_id.clone(), peer.clone()))
        .collect::<Vec<_>>();
    for (_, peer) in &peers {
        peer.prepare_reconnect();
    }
    let mut state = model.write();
    for (peer_id, _) in peers {
        state.rtc_by_peer.insert(peer_id, RtcPhase::WaitingPeer);
    }
    refresh_aggregate_rtc(&mut state);
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_lifecycle_recovery_distinguishes_short_hides_network_changes_and_sleep() {
        assert_eq!(
            lifecycle_recovery_action(
                BrowserLifecycleEvent::Visible { hidden_ms: 2_000 },
                &LifecycleState {
                    hidden: true,
                    network_recovery_pending: false,
                    ..LifecycleState::default()
                },
            ),
            LifecycleRecoveryAction::None
        );
        assert_eq!(
            lifecycle_recovery_action(
                BrowserLifecycleEvent::Visible {
                    hidden_ms: BACKGROUND_CONTROL_RECOVERY_MS,
                },
                &LifecycleState {
                    hidden: true,
                    network_recovery_pending: false,
                    ..LifecycleState::default()
                },
            ),
            LifecycleRecoveryAction::ControlPlane
        );
        assert_eq!(
            lifecycle_recovery_action(
                BrowserLifecycleEvent::Visible { hidden_ms: 1_000 },
                &LifecycleState {
                    hidden: true,
                    network_recovery_pending: true,
                    ..LifecycleState::default()
                },
            ),
            LifecycleRecoveryAction::RebuildResumablePeers
        );
        assert_eq!(
            lifecycle_recovery_action(
                BrowserLifecycleEvent::Online,
                &LifecycleState {
                    hidden: true,
                    network_recovery_pending: true,
                    ..LifecycleState::default()
                },
            ),
            LifecycleRecoveryAction::RebuildResumablePeers
        );
        assert_eq!(
            lifecycle_recovery_action(
                BrowserLifecycleEvent::Online,
                &LifecycleState {
                    hidden: false,
                    network_recovery_pending: true,
                    ..LifecycleState::default()
                },
            ),
            LifecycleRecoveryAction::RebuildResumablePeers
        );
        assert_eq!(
            lifecycle_recovery_action(
                BrowserLifecycleEvent::Resumed {
                    gap_ms: SLEEP_RESUME_GAP_MS,
                },
                &LifecycleState::default(),
            ),
            LifecycleRecoveryAction::RebuildResumablePeers
        );
    }

    #[test]
    fn lifecycle_recovery_is_consumed_only_by_the_same_target_instance() {
        let old_target = RealtimeTargetScope::new(crate::realtime_target::member_target(
            "ABC234".to_owned(),
            1,
            "peer-owner".to_owned(),
        ));
        let reentered_target = RealtimeTargetScope::new(crate::realtime_target::member_target(
            "ABC234".to_owned(),
            1,
            "peer-owner".to_owned(),
        ));
        let mut state = LifecycleState::default();

        state.begin_recovery(&old_target, true);
        assert_eq!(state.take_recovery(&reentered_target), None);
        assert!(state.recovery.is_none());
    }

    #[test]
    fn join_watch_recovery_is_consumed_without_leaking_peer_rebuild() {
        let target = RealtimeTargetScope::new(crate::realtime_target::join_watch_target(
            "ABC234".to_owned(),
            "request-1".to_owned(),
            1,
        ));
        let next_member = RealtimeTargetScope::new(crate::realtime_target::member_target(
            "ABC234".to_owned(),
            1,
            "peer-receiver".to_owned(),
        ));
        let mut state = LifecycleState::default();

        state.begin_recovery(&target, false);
        assert_eq!(state.take_recovery(&target), Some(false));
        assert_eq!(state.take_recovery(&next_member), None);
    }
}
