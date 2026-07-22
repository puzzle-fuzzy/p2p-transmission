use dioxus::prelude::*;
use p2p_browser_platform::{OfferStart, RtcPeer, RtcPeerRegistry, sleep_ms};

use crate::app_state::{AppModel, RoomRole, TransferLinkState};
use crate::app_transition::{AppEvent, reduce_app_event};
use crate::browser_errors::friendly_transfer_error;
use crate::rtc_transition::{
    OwnerTimeoutStep, PassiveDeadlineStep, RtcWorkToken, advance_owner_timeout, begin_owner_offer,
    begin_passive_deadline, claim_disconnected_deadline, claim_owner_retry, claim_passive_deadline,
    clear_peer_rtc_error, mark_data_channel_ready, mark_peer_start_failed, set_peer_rtc_error,
    set_peer_transfer_link_state,
};

// TURN allocation can outlive the first trickled candidate on a slower peer.
// Keep the bounded retry policy, but do not replace an ICE gathering attempt
// before it has had a reasonable relay setup window.
const RTC_NEGOTIATION_TIMEOUT_MS: u32 = 8_000;
const RTC_DISCONNECTED_GRACE_MS: u32 = 5_000;
const RTC_PASSIVE_RECOVERY_TIMEOUT_MS: u32 = 30_000;
const RTC_RETRY_DELAYS_MS: [u32; 4] = [500, 1_000, 2_000, 4_000];

pub(super) fn start_rtc_offer(
    model: Signal<AppModel>,
    rtc_peers: Signal<RtcPeerRegistry>,
    peer: RtcPeer,
    target_peer: String,
) {
    let Some(instance_generation) = model
        .peek()
        .rtc_peer_states
        .get(&target_peer)
        .map(|peer_state| peer_state.instance_generation)
    else {
        return;
    };
    start_owner_offer_attempt(
        model,
        rtc_peers,
        peer,
        target_peer,
        instance_generation,
        0,
        false,
    );
}

fn start_owner_offer_attempt(
    mut model: Signal<AppModel>,
    rtc_peers: Signal<RtcPeerRegistry>,
    peer: RtcPeer,
    target_peer: String,
    instance_generation: u64,
    attempt: u8,
    already_active_is_failure: bool,
) {
    match peer.start_offer(target_peer.clone()) {
        Ok(OfferStart::Started) => {}
        Ok(OfferStart::AlreadyActive) if !already_active_is_failure => return,
        Ok(OfferStart::AlreadyActive) => {
            let mut state = model.write();
            if mark_peer_start_failed(&mut state, &target_peer, instance_generation).is_some() {
                set_peer_rtc_error(
                    &mut state,
                    &target_peer,
                    "点对点连接重试状态异常，请稍后重试".to_owned(),
                );
            }
            return;
        }
        Err(error) => {
            let mut state = model.write();
            if mark_peer_start_failed(&mut state, &target_peer, instance_generation).is_some() {
                set_peer_rtc_error(&mut state, &target_peer, friendly_transfer_error(&error));
            }
            return;
        }
    }

    let token = {
        let mut state = model.write();
        begin_owner_offer(&mut state, &target_peer, instance_generation, attempt)
    };
    let Some(token) = token else {
        peer.prepare_reconnect();
        return;
    };

    spawn(async move {
        sleep_ms(RTC_NEGOTIATION_TIMEOUT_MS).await;
        if !runtime_peer_is_current(rtc_peers, &target_peer, &peer) {
            return;
        }
        if peer.data_channel_ready() {
            mark_ready_from_runtime(&mut model, &target_peer);
            return;
        }

        let step = {
            let mut state = model.write();
            advance_owner_timeout(
                &mut state,
                &target_peer,
                token,
                attempt,
                rtc_retry_delay_ms(attempt),
            )
        };
        match step {
            OwnerTimeoutStep::Ignore => {}
            OwnerTimeoutStep::Failed { transfer_paused } => {
                if !transfer_paused {
                    let mut state = model.write();
                    set_peer_rtc_error(
                        &mut state,
                        &target_peer,
                        "有接收者的点对点连接失败，可以等待其重新连接".to_owned(),
                    );
                }
            }
            OwnerTimeoutStep::Retry {
                token,
                next_attempt,
                delay_ms,
            } => {
                sleep_ms(delay_ms).await;
                if !runtime_peer_is_current(rtc_peers, &target_peer, &peer) {
                    return;
                }
                if peer.data_channel_ready() {
                    mark_ready_from_runtime(&mut model, &target_peer);
                    return;
                }
                let retry_claimed = {
                    let mut state = model.write();
                    claim_owner_retry(&mut state, &target_peer, token, next_attempt)
                };
                if !retry_claimed {
                    return;
                }
                peer.prepare_reconnect();
                start_owner_offer_attempt(
                    model,
                    rtc_peers,
                    peer,
                    target_peer,
                    token.instance_generation(),
                    next_attempt,
                    true,
                );
            }
        }
    });
}

pub(super) fn schedule_passive_recovery_timeout(
    mut model: Signal<AppModel>,
    rtc_peers: Signal<RtcPeerRegistry>,
    peer: RtcPeer,
    peer_id: String,
) {
    let token = {
        let mut state = model.write();
        begin_passive_deadline(&mut state, &peer_id)
    };
    let Some(token) = token else {
        return;
    };
    spawn(async move {
        sleep_ms(RTC_PASSIVE_RECOVERY_TIMEOUT_MS).await;
        if !runtime_peer_is_current(rtc_peers, &peer_id, &peer) {
            return;
        }
        if peer.data_channel_ready() {
            mark_ready_from_runtime(&mut model, &peer_id);
            return;
        }
        let step = {
            let mut state = model.write();
            claim_passive_deadline(&mut state, &peer_id, token)
        };
        if let PassiveDeadlineStep::Failed { transfer_paused } = step
            && !transfer_paused
        {
            let mut state = model.write();
            set_peer_rtc_error(
                &mut state,
                &peer_id,
                "点对点连接超时，请检查双方网络后重新进入房间".to_owned(),
            );
        }
    });
}

pub(super) fn schedule_disconnected_recovery(
    mut model: Signal<AppModel>,
    rtc_peers: Signal<RtcPeerRegistry>,
    peer: RtcPeer,
    peer_id: String,
    role: RoomRole,
    token: RtcWorkToken,
) {
    spawn(async move {
        sleep_ms(RTC_DISCONNECTED_GRACE_MS).await;
        if !runtime_peer_is_current(rtc_peers, &peer_id, &peer) {
            return;
        }
        if peer.data_channel_ready() {
            mark_ready_from_runtime(&mut model, &peer_id);
            return;
        }
        let deadline_claimed = {
            let mut state = model.write();
            claim_disconnected_deadline(&mut state, &peer_id, token)
        };
        if !deadline_claimed {
            return;
        }
        if role == RoomRole::Owner {
            peer.prepare_reconnect();
            start_rtc_offer(model, rtc_peers, peer, peer_id);
        } else {
            schedule_passive_recovery_timeout(model, rtc_peers, peer, peer_id);
        }
    });
}

pub(super) fn reconnect_paused_transfer(
    mut model: Signal<AppModel>,
    rtc_peers: Signal<RtcPeerRegistry>,
    peer: RtcPeer,
    peer_id: String,
) {
    peer.prepare_reconnect();
    {
        let mut state = model.write();
        set_peer_transfer_link_state(&mut state, &peer_id, TransferLinkState::Waiting);
        clear_peer_rtc_error(&mut state, &peer_id);
    }
    start_rtc_offer(model, rtc_peers, peer, peer_id);
}

fn mark_ready_from_runtime(model: &mut Signal<AppModel>, peer_id: &str) {
    let mut state = model.write();
    let recovered_stream = mark_data_channel_ready(&mut state, peer_id);
    if recovered_stream {
        reduce_app_event(
            &mut state,
            AppEvent::SetNotice(Some("连接已恢复，传输将从最后检查点继续".to_owned())),
        );
    }
}

fn runtime_peer_is_current(
    rtc_peers: Signal<RtcPeerRegistry>,
    peer_id: &str,
    peer: &RtcPeer,
) -> bool {
    rtc_peers
        .peek()
        .get(peer_id)
        .is_some_and(|current| current.ptr_eq(peer))
}

fn rtc_retry_delay_ms(attempt: u8) -> Option<u32> {
    RTC_RETRY_DELAYS_MS.get(usize::from(attempt)).copied()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retry_backoff_is_bounded_and_increases() {
        assert_eq!(rtc_retry_delay_ms(0), Some(500));
        assert_eq!(rtc_retry_delay_ms(1), Some(1_000));
        assert_eq!(rtc_retry_delay_ms(2), Some(2_000));
        assert_eq!(rtc_retry_delay_ms(3), Some(4_000));
        assert_eq!(rtc_retry_delay_ms(4), None);
    }
}
