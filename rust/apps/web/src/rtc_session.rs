use std::collections::{BTreeMap, BTreeSet};

use dioxus::prelude::*;
use p2p_browser_platform::{
    BrowserPlatformError, RealtimeConnection, RtcConnectionPhase, RtcEvent, RtcPeer, sleep_ms,
};
use p2p_protocol::{
    CURRENT_PROTOCOL, ClientRealtimeMessage, ParticipantRoleWire, RtcConfigResponse,
    Signal as ProtocolSignal,
};

use crate::rtc_orchestration::{
    refresh_aggregate_rtc, schedule_passive_recovery_timeout, set_peer_transfer_link_state,
    start_rtc_offer,
};
use crate::rtc_transfer_events::handle_transfer_event;

use super::{
    AppModel, RoomRole, RtcPhase, Screen, TransferLinkState, TransferState, friendly_error,
    friendly_transfer_error,
};

pub(super) fn reset_all_rtc_peers(mut rtc_peers: Signal<BTreeMap<String, RtcPeer>>) {
    let peers = std::mem::take(&mut *rtc_peers.write());
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
    rtc_config: Signal<Option<RtcConfigResponse>>,
) {
    let Some(config) = rtc_config.read().clone() else {
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
            let phase = model.read().rtc_by_peer.get(&peer_id).copied();
            if phase == Some(RtcPhase::WaitingPeer) {
                {
                    let mut state = model.write();
                    state
                        .rtc_by_peer
                        .insert(peer_id.clone(), RtcPhase::Connecting);
                    refresh_aggregate_rtc(&mut state);
                }
                spawn(async move {
                    if let Err(error) = peer.restore_outgoing_transfer(&peer_id).await {
                        model.write().error = Some(friendly_transfer_error(&error));
                    }
                    let still_current = rtc_peers
                        .peek()
                        .get(&peer_id)
                        .is_some_and(|current| current.ptr_eq(&peer));
                    if still_current {
                        start_rtc_offer(model, rtc_peers, peer, peer_id, 0);
                    }
                });
            } else if phase != Some(RtcPhase::Ready)
                && !matches!(
                    model.read().transfers_by_peer.get(&peer_id),
                    Some(TransferState::Active {
                        link_state: TransferLinkState::Paused,
                        ..
                    })
                )
            {
                start_rtc_offer(model, rtc_peers, peer, peer_id, 0);
            }
        }
    }
    refresh_aggregate_rtc(&mut model.write());
}

fn ensure_rtc_peer(
    mut model: Signal<AppModel>,
    connection: Signal<Option<RealtimeConnection>>,
    mut rtc_peers: Signal<BTreeMap<String, RtcPeer>>,
    config: &RtcConfigResponse,
    peer_id: String,
) -> Option<RtcPeer> {
    if let Some(peer) = rtc_peers.read().get(&peer_id).cloned() {
        return Some(peer);
    }
    let callback_peer_id = peer_id.clone();
    let on_rtc_event = Callback::new(move |event| {
        handle_rtc_event(
            model,
            connection,
            rtc_peers,
            callback_peer_id.clone(),
            event,
        );
    });
    match RtcPeer::new(config.clone(), on_rtc_event.into_closure()) {
        Ok(peer) => {
            rtc_peers.write().insert(peer_id.clone(), peer.clone());
            let mut state = model.write();
            state
                .rtc_by_peer
                .entry(peer_id)
                .or_insert(RtcPhase::WaitingPeer);
            refresh_aggregate_rtc(&mut state);
            Some(peer)
        }
        Err(error) => {
            let mut state = model.write();
            state.error = Some(friendly_error(&error));
            state.rtc = RtcPhase::Failed;
            None
        }
    }
}

pub(super) fn remove_rtc_peer(
    mut model: Signal<AppModel>,
    mut rtc_peers: Signal<BTreeMap<String, RtcPeer>>,
    peer_id: &str,
) {
    if let Some(peer) = rtc_peers.write().remove(peer_id) {
        peer.reset();
    }
    let mut state = model.write();
    state.rtc_by_peer.remove(peer_id);
    state.transfers_by_peer.remove(peer_id);
    if matches!(
        state.screen,
        Screen::Room {
            role: RoomRole::Receiver,
            ..
        }
    ) {
        state.transfer = TransferState::Idle;
    }
    refresh_aggregate_rtc(&mut state);
}

pub(super) fn accept_rtc_signal(
    mut model: Signal<AppModel>,
    connection: Signal<Option<RealtimeConnection>>,
    rtc_peers: Signal<BTreeMap<String, RtcPeer>>,
    rtc_config: Signal<Option<RtcConfigResponse>>,
    from_peer_id: String,
    signal: ProtocolSignal,
) {
    let Some(config) = rtc_config.read().clone() else {
        let mut state = model.write();
        if state.pending_signals.len() < 64 {
            state.pending_signals.push((from_peer_id, signal));
        } else {
            state.error = Some("点对点协商消息过多，请重新进入房间".to_owned());
        }
        return;
    };
    let allowed = remote_peer_ids(&model.read())
        .is_some_and(|(_, peer_ids)| peer_ids.contains(&from_peer_id));
    if !allowed {
        return;
    }
    if let Some(peer) = ensure_rtc_peer(model, connection, rtc_peers, &config, from_peer_id.clone())
    {
        peer.accept_signal(from_peer_id, signal);
    }
}

fn handle_rtc_event(
    mut model: Signal<AppModel>,
    connection: Signal<Option<RealtimeConnection>>,
    rtc_peers: Signal<BTreeMap<String, RtcPeer>>,
    peer_id: String,
    event: RtcEvent,
) {
    match event {
        RtcEvent::OutboundSignal { to_peer_id, signal } => {
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
                        signal,
                    })
                },
            );
            if let Err(error) = result {
                model.write().error = Some(friendly_transfer_error(&error));
            }
        }
        RtcEvent::ConnectionState(phase) => {
            let should_reconnect = matches!(
                phase,
                RtcConnectionPhase::Failed | RtcConnectionPhase::Closed
            );
            let phase = match phase {
                RtcConnectionPhase::New | RtcConnectionPhase::Connecting => RtcPhase::Connecting,
                RtcConnectionPhase::Connected => RtcPhase::Connecting,
                RtcConnectionPhase::Disconnected | RtcConnectionPhase::Closed => {
                    RtcPhase::Disconnected
                }
                RtcConnectionPhase::Failed => RtcPhase::Failed,
            };
            let owner = matches!(
                model.read().screen,
                Screen::Room {
                    role: RoomRole::Owner,
                    ..
                }
            );
            {
                let mut state = model.write();
                state.rtc_by_peer.insert(peer_id.clone(), phase);
                if should_reconnect {
                    set_peer_transfer_link_state(&mut state, &peer_id, TransferLinkState::Waiting);
                }
                refresh_aggregate_rtc(&mut state);
            }
            if should_reconnect {
                let peer = rtc_peers.read().get(&peer_id).cloned();
                if let Some(peer) = peer {
                    spawn(async move {
                        sleep_ms(0).await;
                        let still_current = rtc_peers
                            .peek()
                            .get(&peer_id)
                            .is_some_and(|current| current.ptr_eq(&peer));
                        if !still_current
                            || owner
                                && model.peek().rtc_by_peer.get(&peer_id)
                                    == Some(&RtcPhase::Connecting)
                        {
                            return;
                        }
                        peer.prepare_reconnect();
                        if owner {
                            start_rtc_offer(model, rtc_peers, peer, peer_id, 0);
                        } else {
                            schedule_passive_recovery_timeout(model, rtc_peers, peer, peer_id);
                        }
                    });
                }
            }
        }
        RtcEvent::DataChannelReady => {
            let mut state = model.write();
            let recovered_stream = matches!(
                state.transfers_by_peer.get(&peer_id),
                Some(TransferState::Active {
                    streamed: true,
                    link_state: TransferLinkState::Waiting | TransferLinkState::Paused,
                    storage_pause: None,
                    ..
                })
            );
            state.rtc_by_peer.insert(peer_id, RtcPhase::Ready);
            refresh_aggregate_rtc(&mut state);
            state.error = None;
            if recovered_stream {
                state.notice = Some("连接已恢复，传输将从最后检查点继续".to_owned());
            }
        }
        event => handle_transfer_event(model, peer_id, event),
    }
}
