use std::collections::{BTreeMap, BTreeSet};

use dioxus::prelude::*;
use p2p_browser_platform::{
    BrowserPlatformError, RealtimeConnection, RtcConnectionPhase, RtcEvent, RtcPeer,
    SignalAcceptance, sleep_ms,
};
use p2p_protocol::{
    CURRENT_PROTOCOL, ClientRealtimeMessage, ParticipantRoleWire, Signal as ProtocolSignal,
};

use crate::app_state::{
    AppModel, PeerRtcState, PendingRtcSignal, RoomRole, RtcPhase, Screen, TextTransferState,
    TransferLinkState, TransferState,
};
use crate::browser_errors::{friendly_error, friendly_transfer_error};
use crate::realtime_runtime::{RealtimeSessionRuntime, ScopedRtcConfig};
use crate::realtime_target::RealtimeTargetScope;
use crate::rtc_orchestration::{
    schedule_disconnected_recovery, schedule_passive_recovery_timeout, start_rtc_offer,
};
use crate::rtc_transfer_events::handle_transfer_event;
use crate::rtc_transition::{
    RtcRecoveryAction, begin_outgoing_recovery, clear_peer_rtc_error, finish_outgoing_recovery,
    mark_data_channel_ready, mark_peer_start_failed, reduce_connection_state,
    refresh_aggregate_rtc, set_peer_rtc_error,
};

pub(super) fn reset_all_rtc_peers(
    mut model: Signal<AppModel>,
    mut rtc_peers: Signal<BTreeMap<String, RtcPeer>>,
) {
    let peers = std::mem::take(&mut *rtc_peers.write());
    {
        let mut state = model.write();
        if let Some(peer_id) = state
            .rtc_error
            .as_ref()
            .map(|rtc_error| rtc_error.peer_id.clone())
        {
            clear_peer_rtc_error(&mut state, &peer_id);
        }
        state.rtc_peer_states.clear();
        refresh_aggregate_rtc(&mut state);
    }
    for peer in peers.into_values() {
        peer.reset();
    }
}

fn remote_peer_ids(model: &AppModel) -> Option<(RoomRole, Vec<String>)> {
    let Screen::Room { role, snapshot, .. } = &model.screen else {
        return None;
    };
    let remote_role = if *role == RoomRole::Owner {
        ParticipantRoleWire::Receiver
    } else {
        ParticipantRoleWire::Owner
    };
    let peer_ids = snapshot
        .participants
        .iter()
        .filter(|participant| participant.role == remote_role && participant.online)
        .filter_map(|participant| participant.peer_id.clone())
        .collect();
    Some((*role, peer_ids))
}

pub(super) fn sync_rtc_peers(
    mut model: Signal<AppModel>,
    connection: Signal<Option<RealtimeConnection>>,
    rtc_peers: Signal<BTreeMap<String, RtcPeer>>,
    rtc_config: Signal<Option<ScopedRtcConfig>>,
    target_scope: &RealtimeTargetScope,
) {
    let config = {
        let scoped_config = rtc_config.read();
        scoped_config
            .as_ref()
            .and_then(|config| config.for_scope(target_scope))
            .cloned()
    };
    let Some(config) = config else {
        return;
    };
    let Some((role, desired_peer_ids)) = remote_peer_ids(&model.read()) else {
        return;
    };
    let desired = desired_peer_ids.iter().cloned().collect::<BTreeSet<_>>();
    let stale = rtc_peers
        .read()
        .keys()
        .filter(|peer_id| !desired.contains(*peer_id))
        .cloned()
        .collect::<Vec<_>>();
    for peer_id in stale {
        if rtc_peers
            .read()
            .get(&peer_id)
            .is_some_and(|peer| peer.data_channel_ready() || peer.resumable_transfer_active())
        {
            continue;
        }
        remove_rtc_peer(model, rtc_peers, &peer_id);
    }
    for peer_id in desired_peer_ids {
        let Some(peer) = ensure_rtc_peer(model, connection, rtc_peers, &config, peer_id.clone())
        else {
            continue;
        };
        if role == RoomRole::Owner {
            let peer_state = model.read().rtc_peer_states.get(&peer_id).copied();
            let phase = peer_state.map(|peer_state| peer_state.phase);
            if phase == Some(RtcPhase::WaitingPeer) {
                let restore_generation = {
                    let mut state = model.write();
                    begin_outgoing_recovery(&mut state, &peer_id)
                };
                start_rtc_offer(model, rtc_peers, peer.clone(), peer_id.clone());
                if let Some(restore_generation) = restore_generation {
                    spawn(async move {
                        let restore_result = peer.restore_outgoing_transfer(&peer_id).await;
                        let still_current = rtc_peers
                            .peek()
                            .get(&peer_id)
                            .is_some_and(|current| current.ptr_eq(&peer));
                        let generation_is_current = rtc_peer_generation_is_current(
                            &model.peek(),
                            &peer_id,
                            restore_generation,
                        );
                        if still_current && generation_is_current {
                            let mut state = model.write();
                            let recovery_finished =
                                finish_outgoing_recovery(&mut state, &peer_id, restore_generation);
                            if recovery_finished && let Err(error) = restore_result {
                                state.error = Some(friendly_transfer_error(&error));
                            }
                        }
                    });
                }
            } else if phase != Some(RtcPhase::Ready)
                && !matches!(
                    model.read().transfers_by_peer.get(&peer_id),
                    Some(TransferState::Active {
                        link_state: TransferLinkState::Paused,
                        ..
                    })
                )
            {
                start_rtc_offer(model, rtc_peers, peer, peer_id);
            }
        } else if model
            .read()
            .rtc_peer_states
            .get(&peer_id)
            .is_some_and(|peer_state| peer_state.phase == RtcPhase::WaitingPeer)
        {
            schedule_passive_recovery_timeout(model, rtc_peers, peer, peer_id);
        }
    }
    refresh_aggregate_rtc(&mut model.write());
}

fn ensure_rtc_peer(
    mut model: Signal<AppModel>,
    connection: Signal<Option<RealtimeConnection>>,
    mut rtc_peers: Signal<BTreeMap<String, RtcPeer>>,
    config: &p2p_browser_platform::RtcConfigLease,
    peer_id: String,
) -> Option<RtcPeer> {
    if let Some(peer) = rtc_peers.read().get(&peer_id).cloned() {
        return Some(peer);
    }
    let callback_peer_id = peer_id.clone();
    let peer_generation = {
        let mut state = model.write();
        allocate_rtc_peer_generation(&mut state, &peer_id)
    };
    let on_rtc_event = Callback::new(move |event| {
        handle_rtc_event(
            model,
            connection,
            rtc_peers,
            callback_peer_id.clone(),
            peer_generation,
            event,
        );
    });
    match RtcPeer::new(config.clone(), on_rtc_event.into_closure()) {
        Ok(peer) => {
            rtc_peers.write().insert(peer_id, peer.clone());
            let mut state = model.write();
            refresh_aggregate_rtc(&mut state);
            Some(peer)
        }
        Err(error) => {
            let mut state = model.write();
            mark_peer_start_failed(&mut state, &peer_id, peer_generation);
            set_peer_rtc_error(&mut state, &peer_id, friendly_error(&error));
            None
        }
    }
}

pub(super) fn remove_rtc_peer(
    mut model: Signal<AppModel>,
    mut rtc_peers: Signal<BTreeMap<String, RtcPeer>>,
    peer_id: &str,
) {
    let peer = rtc_peers.write().remove(peer_id);
    let mut state = model.write();
    clear_peer_rtc_error(&mut state, peer_id);
    state.rtc_peer_states.remove(peer_id);
    state.transfers_by_peer.remove(peer_id);
    state.text_transfers_by_peer.remove(peer_id);
    if matches!(
        state.screen,
        Screen::Room {
            role: RoomRole::Receiver,
            ..
        }
    ) {
        state.transfer = TransferState::Idle;
        state.text_transfer = TextTransferState::Idle;
    }
    refresh_aggregate_rtc(&mut state);
    drop(state);
    if let Some(peer) = peer {
        peer.reset();
    }
}

pub(super) fn accept_rtc_signal(
    runtime: RealtimeSessionRuntime,
    target_scope: &RealtimeTargetScope,
    from_peer_id: String,
    negotiation_id: String,
    signal: ProtocolSignal,
) {
    let mut model = runtime.model;
    let connection = runtime.rtc.connection;
    let rtc_peers = runtime.rtc.peers;
    let rtc_config = runtime.rtc.config;
    let config = {
        let scoped_config = rtc_config.read();
        scoped_config
            .as_ref()
            .and_then(|config| config.for_scope(target_scope))
            .cloned()
    };
    let Some(config) = config else {
        let mut state = model.write();
        if state.pending_signals.len() < 64 {
            state.pending_signals.push(PendingRtcSignal {
                from_peer_id,
                negotiation_id,
                signal,
            });
        } else {
            state.error = Some("点对点协商消息过多，请重新进入房间".to_owned());
        }
        return;
    };
    let Some((role, remote_peer_ids)) = remote_peer_ids(&model.read()) else {
        return;
    };
    if !remote_peer_ids.contains(&from_peer_id) {
        return;
    }
    let arm_passive_deadline =
        role == RoomRole::Receiver && matches!(&signal, ProtocolSignal::Offer { .. });
    if let Some(peer) = ensure_rtc_peer(model, connection, rtc_peers, &config, from_peer_id.clone())
    {
        let signal_accepted = match peer.accept_signal(from_peer_id.clone(), negotiation_id, signal)
        {
            Ok(signal_accepted) => signal_accepted,
            Err(error) => {
                let mut state = model.write();
                let instance_generation = state
                    .rtc_peer_states
                    .get(&from_peer_id)
                    .map(|peer_state| peer_state.instance_generation);
                if let Some(instance_generation) = instance_generation {
                    mark_peer_start_failed(&mut state, &from_peer_id, instance_generation);
                }
                set_peer_rtc_error(&mut state, &from_peer_id, friendly_transfer_error(&error));
                return;
            }
        };
        if arm_passive_deadline && signal_accepted == SignalAcceptance::Scheduled {
            schedule_passive_recovery_timeout(model, rtc_peers, peer, from_peer_id);
        }
    }
}

fn handle_rtc_event(
    mut model: Signal<AppModel>,
    connection: Signal<Option<RealtimeConnection>>,
    rtc_peers: Signal<BTreeMap<String, RtcPeer>>,
    peer_id: String,
    peer_generation: u64,
    event: RtcEvent,
) {
    if !rtc_peer_generation_is_current(&model.peek(), &peer_id, peer_generation) {
        return;
    }
    match event {
        RtcEvent::OutboundSignal {
            to_peer_id,
            negotiation_id,
            signal,
        } => {
            let room_code = match &model.read().screen {
                Screen::Room { snapshot, .. } => snapshot.room_code.clone(),
                _ => return,
            };
            let result = connection.read().as_ref().map_or_else(
                || {
                    Err(BrowserPlatformError::Browser(
                        "realtime connection is unavailable".to_owned(),
                    ))
                },
                |active| {
                    active.send(&ClientRealtimeMessage::Signal {
                        version: CURRENT_PROTOCOL,
                        room_code,
                        to_peer_id,
                        negotiation_id,
                        signal,
                    })
                },
            );
            if let Err(error) = result {
                let mut state = model.write();
                set_peer_rtc_error(&mut state, &peer_id, friendly_transfer_error(&error));
            }
        }
        RtcEvent::ConnectionState(phase) => {
            let role = match &model.read().screen {
                Screen::Room { role, .. } => *role,
                _ => return,
            };
            let Some(peer) = rtc_peers.read().get(&peer_id).cloned() else {
                return;
            };
            let connected_channel_ready =
                phase == RtcConnectionPhase::Connected && peer.data_channel_ready();
            let recovery = {
                let mut state = model.write();
                let recovery = reduce_connection_state(&mut state, &peer_id, role, phase);
                if connected_channel_ready {
                    let recovered_stream = mark_data_channel_ready(&mut state, &peer_id);
                    if recovered_stream {
                        state.notice = Some("连接已恢复，传输将从最后检查点继续".to_owned());
                    }
                    RtcRecoveryAction::None
                } else {
                    recovery
                }
            };
            match recovery {
                RtcRecoveryAction::None => {}
                RtcRecoveryAction::ArmPassiveDeadline => {
                    schedule_passive_recovery_timeout(model, rtc_peers, peer, peer_id);
                }
                RtcRecoveryAction::WaitForReconnect { token } => {
                    schedule_disconnected_recovery(model, rtc_peers, peer, peer_id, role, token);
                }
                RtcRecoveryAction::RestartOffer => {
                    spawn(async move {
                        sleep_ms(0).await;
                        let still_current = rtc_peers
                            .peek()
                            .get(&peer_id)
                            .is_some_and(|current| current.ptr_eq(&peer));
                        let generation_is_current = rtc_peer_generation_is_current(
                            &model.peek(),
                            &peer_id,
                            peer_generation,
                        );
                        if !still_current
                            || !generation_is_current
                            || matches!(
                                model
                                    .peek()
                                    .rtc_peer_states
                                    .get(&peer_id)
                                    .map(|peer_state| peer_state.phase),
                                Some(RtcPhase::Connecting | RtcPhase::Ready)
                            )
                        {
                            return;
                        }
                        peer.prepare_reconnect();
                        start_rtc_offer(model, rtc_peers, peer, peer_id);
                    });
                }
            }
        }
        RtcEvent::DataChannelReady => {
            let mut state = model.write();
            let recovered_stream = mark_data_channel_ready(&mut state, &peer_id);
            if recovered_stream {
                state.notice = Some("连接已恢复，传输将从最后检查点继续".to_owned());
            }
        }
        RtcEvent::NegotiationFailed { message } => {
            let mut state = model.write();
            set_peer_rtc_error(&mut state, &peer_id, message);
        }
        event => handle_transfer_event(model, peer_id, event),
    }
}

fn allocate_rtc_peer_generation(model: &mut AppModel, peer_id: &str) -> u64 {
    model.rtc_peer_generation = model.rtc_peer_generation.wrapping_add(1);
    let generation = model.rtc_peer_generation;
    model
        .rtc_peer_states
        .insert(peer_id.to_owned(), PeerRtcState::new(generation));
    generation
}

fn rtc_peer_generation_is_current(model: &AppModel, peer_id: &str, generation: u64) -> bool {
    model
        .rtc_peer_states
        .get(peer_id)
        .is_some_and(|peer_state| peer_state.instance_generation == generation)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaced_peer_rejects_events_from_the_previous_generation() {
        let mut model = AppModel::default();
        let first = allocate_rtc_peer_generation(&mut model, "peer");
        let second = allocate_rtc_peer_generation(&mut model, "peer");

        assert_ne!(first, second);
        assert!(!rtc_peer_generation_is_current(&model, "peer", first));
        assert!(rtc_peer_generation_is_current(&model, "peer", second));
    }

    #[test]
    fn generation_counter_survives_target_state_cleanup() {
        let mut model = AppModel::default();
        let first = allocate_rtc_peer_generation(&mut model, "peer");
        model.rtc_peer_states.clear();
        let second = allocate_rtc_peer_generation(&mut model, "peer");

        assert!(second > first);
        assert!(!rtc_peer_generation_is_current(&model, "peer", first));
    }
}
