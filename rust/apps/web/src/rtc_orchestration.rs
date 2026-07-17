use std::collections::BTreeMap;

use dioxus::prelude::*;
use p2p_browser_platform::{RtcPeer, sleep_ms};

use crate::app_state::{AppModel, RoomRole, RtcPhase, Screen, TransferLinkState, TransferState};

const RTC_NEGOTIATION_TIMEOUT_MS: u32 = 3_000;
const RTC_PASSIVE_RECOVERY_TIMEOUT_MS: u32 = 30_000;
const RTC_RETRY_DELAYS_MS: [u32; 4] = [500, 1_000, 2_000, 4_000];

pub(super) fn start_rtc_offer(
    mut model: Signal<AppModel>,
    rtc_peers: Signal<BTreeMap<String, RtcPeer>>,
    peer: RtcPeer,
    target_peer: String,
    attempt: u8,
) {
    if !peer.start_offer(target_peer.clone()) {
        return;
    }
    {
        let mut state = model.write();
        state
            .rtc_by_peer
            .insert(target_peer.clone(), RtcPhase::Connecting);
        set_peer_transfer_link_state(&mut state, &target_peer, TransferLinkState::Waiting);
        refresh_aggregate_rtc(&mut state);
    }
    spawn(async move {
        sleep_ms(RTC_NEGOTIATION_TIMEOUT_MS).await;
        let still_current = rtc_peers
            .peek()
            .get(&target_peer)
            .is_some_and(|current| current.ptr_eq(&peer));
        if !still_current || model.peek().rtc_by_peer.get(&target_peer) == Some(&RtcPhase::Ready) {
            return;
        }
        if peer.data_channel_ready() {
            let mut state = model.write();
            state
                .rtc_by_peer
                .insert(target_peer.clone(), RtcPhase::Ready);
            refresh_aggregate_rtc(&mut state);
            return;
        }
        let Some(delay_ms) = rtc_retry_delay_ms(attempt) else {
            let mut state = model.write();
            state
                .rtc_by_peer
                .insert(target_peer.clone(), RtcPhase::Failed);
            let transfer_paused =
                set_peer_transfer_link_state(&mut state, &target_peer, TransferLinkState::Paused);
            refresh_aggregate_rtc(&mut state);
            if !transfer_paused {
                state.error = Some("有接收者的点对点连接失败，可以等待其重新连接".to_owned());
            }
            return;
        };
        peer.prepare_reconnect();
        sleep_ms(delay_ms).await;
        let still_current = rtc_peers
            .peek()
            .get(&target_peer)
            .is_some_and(|current| current.ptr_eq(&peer));
        if !still_current
            || model.peek().rtc_by_peer.get(&target_peer) == Some(&RtcPhase::Ready)
            || peer.data_channel_ready()
        {
            return;
        }
        start_rtc_offer(model, rtc_peers, peer, target_peer, attempt + 1);
    });
}

pub(super) fn schedule_passive_recovery_timeout(
    mut model: Signal<AppModel>,
    rtc_peers: Signal<BTreeMap<String, RtcPeer>>,
    peer: RtcPeer,
    peer_id: String,
) {
    spawn(async move {
        sleep_ms(RTC_PASSIVE_RECOVERY_TIMEOUT_MS).await;
        let still_current = rtc_peers
            .peek()
            .get(&peer_id)
            .is_some_and(|current| current.ptr_eq(&peer));
        if !still_current
            || peer.data_channel_ready()
            || model.peek().rtc_by_peer.get(&peer_id) == Some(&RtcPhase::Ready)
        {
            return;
        }
        let mut state = model.write();
        if set_peer_transfer_link_state(&mut state, &peer_id, TransferLinkState::Paused) {
            state.rtc_by_peer.insert(peer_id, RtcPhase::Failed);
            refresh_aggregate_rtc(&mut state);
        }
    });
}

pub(super) fn reconnect_paused_transfer(
    mut model: Signal<AppModel>,
    rtc_peers: Signal<BTreeMap<String, RtcPeer>>,
    peer: RtcPeer,
    peer_id: String,
) {
    peer.prepare_reconnect();
    {
        let mut state = model.write();
        set_peer_transfer_link_state(&mut state, &peer_id, TransferLinkState::Waiting);
        state.error = None;
    }
    start_rtc_offer(model, rtc_peers, peer, peer_id, 0);
}

pub(super) fn mark_streamed_transfers_waiting(model: &mut AppModel) -> bool {
    let peer_ids = model.transfers_by_peer.keys().cloned().collect::<Vec<_>>();
    let mut updated = false;
    for peer_id in peer_ids {
        updated |= set_peer_transfer_link_state(model, &peer_id, TransferLinkState::Waiting);
    }
    updated
}

pub(super) fn set_peer_transfer_link_state(
    model: &mut AppModel,
    peer_id: &str,
    link_state: TransferLinkState,
) -> bool {
    let updated = model
        .transfers_by_peer
        .get_mut(peer_id)
        .and_then(|transfer| {
            if let TransferState::Active {
                streamed: true,
                link_state: current,
                ..
            } = transfer
            {
                *current = link_state;
                Some(transfer.clone())
            } else {
                None
            }
        });
    if let Some(transfer) = updated {
        if matches!(
            model.screen,
            Screen::Room {
                role: RoomRole::Receiver,
                ..
            }
        ) {
            model.transfer = transfer;
        }
        true
    } else {
        false
    }
}

pub(super) fn refresh_aggregate_rtc(model: &mut AppModel) {
    model.rtc = if model.rtc_by_peer.is_empty() {
        if matches!(model.screen, Screen::Room { .. }) {
            RtcPhase::WaitingPeer
        } else {
            RtcPhase::Inactive
        }
    } else if model
        .rtc_by_peer
        .values()
        .any(|phase| *phase == RtcPhase::Ready)
    {
        RtcPhase::Ready
    } else if model
        .rtc_by_peer
        .values()
        .any(|phase| *phase == RtcPhase::Connecting)
    {
        RtcPhase::Connecting
    } else if model
        .rtc_by_peer
        .values()
        .any(|phase| *phase == RtcPhase::Disconnected)
    {
        RtcPhase::Disconnected
    } else if model
        .rtc_by_peer
        .values()
        .any(|phase| *phase == RtcPhase::Failed)
    {
        RtcPhase::Failed
    } else {
        RtcPhase::WaitingPeer
    };
}

fn rtc_retry_delay_ms(attempt: u8) -> Option<u32> {
    RTC_RETRY_DELAYS_MS.get(usize::from(attempt)).copied()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aggregate_stays_ready_when_one_of_multiple_peers_is_ready() {
        let mut model = AppModel::default();
        model
            .rtc_by_peer
            .insert("peer_ready".to_owned(), RtcPhase::Ready);
        model
            .rtc_by_peer
            .insert("peer_connecting".to_owned(), RtcPhase::Connecting);

        refresh_aggregate_rtc(&mut model);

        assert_eq!(model.rtc, RtcPhase::Ready);
    }

    #[test]
    fn retry_backoff_is_bounded_and_increases() {
        assert_eq!(rtc_retry_delay_ms(0), Some(500));
        assert_eq!(rtc_retry_delay_ms(1), Some(1_000));
        assert_eq!(rtc_retry_delay_ms(2), Some(2_000));
        assert_eq!(rtc_retry_delay_ms(3), Some(4_000));
        assert_eq!(rtc_retry_delay_ms(4), None);
    }
}
