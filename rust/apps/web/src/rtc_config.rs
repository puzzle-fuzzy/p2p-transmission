use dioxus::prelude::*;
use p2p_browser_platform::{RtcConfigLease, fetch_rtc_config, monotonic_millis, sleep_ms};

use crate::app_state::TransferState;
use crate::browser_errors::friendly_error;
use crate::realtime_connection::{realtime_target_is_suppressed, realtime_target_scope_is_current};
use crate::realtime_runtime::{RealtimeSessionRuntime, ScopedRtcConfig};
use crate::realtime_target::{RealtimeTarget, RealtimeTargetScope};
use crate::rtc_session::{accept_rtc_signal, reset_all_rtc_peers, sync_rtc_peers};
use crate::rtc_transition::{
    begin_rtc_config_loading, deactivate_rtc_config, mark_rtc_config_failed, mark_rtc_config_ready,
};

const RTC_CONFIG_REFRESH_EARLY_MS: u64 = 60_000;
const RTC_CONFIG_REFRESH_MAX_MS: u64 = 8 * 60_000;
const RTC_CONFIG_REFRESH_MIN_MS: u64 = 1_000;
const RTC_CONFIG_RETRY_MS: u32 = 15_000;
const RTC_CONFIG_EXPIRED_MESSAGE: &str = "点对点连接配置已过期，正在重新获取";
const RTC_CONFIG_INVALID_TTL_MESSAGE: &str = "点对点连接配置有效期不足，正在重试";

pub(super) fn use_rtc_config_session(mut runtime: RealtimeSessionRuntime) {
    use_effect(move || {
        let target = runtime.target.read().clone();
        let target_scope = target
            .filter(RealtimeTarget::is_member)
            .map(RealtimeTargetScope::new);
        reset_all_rtc_peers(runtime.model, runtime.rtc.peers);
        let mut rtc_config = runtime.rtc.config;
        rtc_config.set(None);
        {
            let mut state = runtime.model.write();
            state.transfer = TransferState::Idle;
            state.transfers_by_peer.clear();
            state.pending_signals.clear();
            if target_scope.is_some() {
                begin_rtc_config_loading(&mut state);
            } else {
                deactivate_rtc_config(&mut state);
            }
        }
        let Some(target_scope) = target_scope else {
            return;
        };
        spawn(async move {
            let mut next_delay_ms = 0;
            loop {
                if next_delay_ms > 0 {
                    sleep_ms(next_delay_ms).await;
                }
                if !rtc_config_scope_is_current(runtime, &target_scope) {
                    return;
                }

                let request_started_at_ms = monotonic_millis();
                let config_result = fetch_rtc_config().await;
                if !rtc_config_scope_is_current(runtime, &target_scope) {
                    return;
                }
                match config_result {
                    Ok(config) => {
                        let lease =
                            RtcConfigLease::from_request_start(config, request_started_at_ms);
                        if !lease.is_valid() {
                            next_delay_ms = retry_delay_for_current_config(
                                runtime,
                                &target_scope,
                                RTC_CONFIG_INVALID_TTL_MESSAGE,
                            );
                            continue;
                        }
                        apply_rtc_config(runtime, &target_scope, lease.clone());
                        replay_pending_signals(runtime, &target_scope);
                        schedule_rtc_config_expiry(runtime, target_scope.clone(), lease.clone());
                        next_delay_ms = rtc_config_refresh_delay_ms(lease.remaining_ms());
                    }
                    Err(error) => {
                        next_delay_ms = retry_delay_for_current_config(
                            runtime,
                            &target_scope,
                            &friendly_error(&error),
                        );
                    }
                }
            }
        });
    });
}

fn apply_rtc_config(
    mut runtime: RealtimeSessionRuntime,
    target_scope: &RealtimeTargetScope,
    lease: RtcConfigLease,
) {
    let peers = runtime
        .rtc
        .peers
        .peek()
        .values()
        .cloned()
        .collect::<Vec<_>>();
    for peer in peers {
        let _ = peer.replace_reconnect_rtc_config(lease.clone());
    }
    let mut rtc_config = runtime.rtc.config;
    rtc_config.set(Some(ScopedRtcConfig::new(target_scope.clone(), lease)));
    mark_rtc_config_ready(&mut runtime.model.write());
    sync_rtc_peers(
        runtime.model,
        runtime.rtc.connection,
        runtime.rtc.peers,
        runtime.rtc.config,
        target_scope,
    );
}

fn replay_pending_signals(mut runtime: RealtimeSessionRuntime, target_scope: &RealtimeTargetScope) {
    let pending = std::mem::take(&mut runtime.model.write().pending_signals);
    for pending_signal in pending {
        accept_rtc_signal(
            runtime,
            target_scope,
            pending_signal.from_peer_id,
            pending_signal.negotiation_id,
            pending_signal.signal,
        );
    }
}

fn schedule_rtc_config_expiry(
    mut runtime: RealtimeSessionRuntime,
    target_scope: RealtimeTargetScope,
    lease: RtcConfigLease,
) {
    spawn(async move {
        loop {
            let remaining_ms = lease.remaining_ms();
            if remaining_ms == 0 {
                break;
            }
            sleep_ms(rtc_config_sleep_ms(remaining_ms)).await;
            if !rtc_config_scope_is_current(runtime, &target_scope) {
                return;
            }
        }
        if !rtc_config_scope_is_current(runtime, &target_scope) {
            return;
        }
        let lease_is_current = runtime
            .rtc
            .config
            .peek()
            .as_ref()
            .is_some_and(|config| config.matches(&target_scope, &lease));
        if !lease_is_current {
            return;
        }
        runtime.rtc.config.set(None);
        mark_rtc_config_failed(
            &mut runtime.model.write(),
            RTC_CONFIG_EXPIRED_MESSAGE.to_owned(),
        );
    });
}

fn retry_delay_for_current_config(
    mut runtime: RealtimeSessionRuntime,
    target_scope: &RealtimeTargetScope,
    failure_message: &str,
) -> u32 {
    let remaining_ms = runtime
        .rtc
        .config
        .peek()
        .as_ref()
        .and_then(|config| config.for_scope(target_scope))
        .map(RtcConfigLease::remaining_ms);
    if let Some(remaining_ms) = remaining_ms {
        return rtc_config_sleep_ms(remaining_ms.min(u64::from(RTC_CONFIG_RETRY_MS)));
    }

    runtime.rtc.config.set(None);
    mark_rtc_config_failed(&mut runtime.model.write(), failure_message.to_owned());
    RTC_CONFIG_RETRY_MS
}

fn rtc_config_scope_is_current(
    runtime: RealtimeSessionRuntime,
    scope: &RealtimeTargetScope,
) -> bool {
    realtime_target_scope_is_current(scope, runtime.target)
        && !realtime_target_is_suppressed(runtime.connection, runtime.target)
}

fn rtc_config_refresh_delay_ms(remaining_ms: u64) -> u32 {
    let before_expiry_ms = remaining_ms.saturating_sub(RTC_CONFIG_REFRESH_EARLY_MS);
    let half_life_ms = remaining_ms / 2;
    before_expiry_ms
        .max(half_life_ms)
        .clamp(RTC_CONFIG_REFRESH_MIN_MS, RTC_CONFIG_REFRESH_MAX_MS) as u32
}

fn rtc_config_sleep_ms(delay_ms: u64) -> u32 {
    delay_ms.clamp(1, u64::from(u32::MAX)) as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refresh_delay_is_capped_for_normal_ten_minute_credentials() {
        assert_eq!(rtc_config_refresh_delay_ms(600_000), 480_000);
    }

    #[test]
    fn refresh_delay_uses_half_life_near_expiry() {
        assert_eq!(rtc_config_refresh_delay_ms(90_000), 45_000);
        assert_eq!(rtc_config_refresh_delay_ms(40_000), 20_000);
    }

    #[test]
    fn sleep_delay_never_wraps_or_busy_loops() {
        assert_eq!(rtc_config_sleep_ms(0), 1);
        assert_eq!(rtc_config_sleep_ms(u64::MAX), u32::MAX);
    }
}
