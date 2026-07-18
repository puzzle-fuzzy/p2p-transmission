use p2p_browser_platform::RtcConnectionPhase;

use crate::app_state::{
    AppModel, PeerRtcError, PendingRtcWork, RoomRole, RtcConfigPhase, RtcPhase, Screen,
    TransferLinkState, TransferState,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct RtcWorkToken {
    instance_generation: u64,
    work_generation: u64,
}

impl RtcWorkToken {
    pub(super) fn instance_generation(self) -> u64 {
        self.instance_generation
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum OwnerTimeoutStep {
    Ignore,
    Retry {
        token: RtcWorkToken,
        next_attempt: u8,
        delay_ms: u32,
    },
    Failed {
        transfer_paused: bool,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum PassiveDeadlineStep {
    Ignore,
    Failed { transfer_paused: bool },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum RtcRecoveryAction {
    None,
    RestartOffer,
    ArmPassiveDeadline,
    WaitForReconnect { token: RtcWorkToken },
}

pub(super) fn begin_outgoing_recovery(model: &mut AppModel, peer_id: &str) -> Option<u64> {
    model
        .rtc_peer_states
        .get_mut(peer_id)
        .and_then(crate::app_state::PeerRtcState::begin_outgoing_recovery)
}

pub(super) fn finish_outgoing_recovery(
    model: &mut AppModel,
    peer_id: &str,
    instance_generation: u64,
) -> bool {
    model
        .rtc_peer_states
        .get_mut(peer_id)
        .is_some_and(|peer_state| peer_state.finish_outgoing_recovery(instance_generation))
}

pub(super) fn begin_owner_offer(
    model: &mut AppModel,
    peer_id: &str,
    instance_generation: u64,
    attempt: u8,
) -> Option<RtcWorkToken> {
    let peer_state = model.rtc_peer_states.get_mut(peer_id)?;
    if peer_state.instance_generation != instance_generation {
        return None;
    }
    let token = arm_work(peer_state, PendingRtcWork::OwnerOfferTimeout { attempt });
    peer_state.phase = RtcPhase::Connecting;
    clear_peer_rtc_error(model, peer_id);
    set_peer_transfer_link_state(model, peer_id, TransferLinkState::Waiting);
    refresh_aggregate_rtc(model);
    Some(token)
}

pub(super) fn advance_owner_timeout(
    model: &mut AppModel,
    peer_id: &str,
    token: RtcWorkToken,
    attempt: u8,
    retry_delay_ms: Option<u32>,
) -> OwnerTimeoutStep {
    let Some(peer_state) = model.rtc_peer_states.get_mut(peer_id) else {
        return OwnerTimeoutStep::Ignore;
    };
    if !work_is_current(
        peer_state,
        token,
        PendingRtcWork::OwnerOfferTimeout { attempt },
    ) {
        return OwnerTimeoutStep::Ignore;
    }

    let Some(delay_ms) = retry_delay_ms else {
        invalidate_work(peer_state);
        peer_state.phase = RtcPhase::Failed;
        let transfer_paused =
            set_peer_transfer_link_state(model, peer_id, TransferLinkState::Paused);
        refresh_aggregate_rtc(model);
        return OwnerTimeoutStep::Failed { transfer_paused };
    };

    let next_attempt = attempt.saturating_add(1);
    let token = arm_work(peer_state, PendingRtcWork::OwnerRetryDelay { next_attempt });
    OwnerTimeoutStep::Retry {
        token,
        next_attempt,
        delay_ms,
    }
}

pub(super) fn claim_owner_retry(
    model: &mut AppModel,
    peer_id: &str,
    token: RtcWorkToken,
    next_attempt: u8,
) -> bool {
    let Some(peer_state) = model.rtc_peer_states.get_mut(peer_id) else {
        return false;
    };
    if !work_is_current(
        peer_state,
        token,
        PendingRtcWork::OwnerRetryDelay { next_attempt },
    ) {
        return false;
    }
    peer_state.pending_work = None;
    true
}

pub(super) fn mark_peer_start_failed(
    model: &mut AppModel,
    peer_id: &str,
    instance_generation: u64,
) -> Option<bool> {
    let peer_state = model.rtc_peer_states.get_mut(peer_id)?;
    if peer_state.instance_generation != instance_generation {
        return None;
    }
    invalidate_work(peer_state);
    peer_state.phase = RtcPhase::Failed;
    let transfer_paused = set_peer_transfer_link_state(model, peer_id, TransferLinkState::Paused);
    refresh_aggregate_rtc(model);
    Some(transfer_paused)
}

pub(super) fn begin_passive_deadline(model: &mut AppModel, peer_id: &str) -> Option<RtcWorkToken> {
    let peer_state = model.rtc_peer_states.get_mut(peer_id)?;
    let token = arm_work(peer_state, PendingRtcWork::PassiveDeadline);
    peer_state.phase = RtcPhase::Connecting;
    clear_peer_rtc_error(model, peer_id);
    refresh_aggregate_rtc(model);
    Some(token)
}

pub(super) fn claim_disconnected_deadline(
    model: &mut AppModel,
    peer_id: &str,
    token: RtcWorkToken,
) -> bool {
    let Some(peer_state) = model.rtc_peer_states.get_mut(peer_id) else {
        return false;
    };
    if !work_is_current(peer_state, token, PendingRtcWork::DisconnectedDeadline) {
        return false;
    }
    invalidate_work(peer_state);
    true
}

pub(super) fn claim_passive_deadline(
    model: &mut AppModel,
    peer_id: &str,
    token: RtcWorkToken,
) -> PassiveDeadlineStep {
    let Some(peer_state) = model.rtc_peer_states.get_mut(peer_id) else {
        return PassiveDeadlineStep::Ignore;
    };
    if !work_is_current(peer_state, token, PendingRtcWork::PassiveDeadline) {
        return PassiveDeadlineStep::Ignore;
    }
    invalidate_work(peer_state);
    peer_state.phase = RtcPhase::Failed;
    let transfer_paused = set_peer_transfer_link_state(model, peer_id, TransferLinkState::Paused);
    refresh_aggregate_rtc(model);
    PassiveDeadlineStep::Failed { transfer_paused }
}

pub(super) fn mark_data_channel_ready(model: &mut AppModel, peer_id: &str) -> bool {
    let recovered_stream = matches!(
        model.transfers_by_peer.get(peer_id),
        Some(TransferState::Active {
            streamed: true,
            link_state: TransferLinkState::Waiting | TransferLinkState::Paused,
            storage_pause: None,
            ..
        })
    );
    let Some(peer_state) = model.rtc_peer_states.get_mut(peer_id) else {
        return false;
    };
    invalidate_work(peer_state);
    peer_state.phase = RtcPhase::Ready;
    clear_peer_rtc_error(model, peer_id);
    refresh_aggregate_rtc(model);
    recovered_stream
}

pub(super) fn reset_peer_waiting(model: &mut AppModel, peer_id: &str) -> bool {
    let Some(peer_state) = model.rtc_peer_states.get_mut(peer_id) else {
        return false;
    };
    invalidate_work(peer_state);
    peer_state.phase = RtcPhase::WaitingPeer;
    clear_peer_rtc_error(model, peer_id);
    refresh_aggregate_rtc(model);
    true
}

pub(super) fn reduce_connection_state(
    model: &mut AppModel,
    peer_id: &str,
    role: RoomRole,
    connection_phase: RtcConnectionPhase,
) -> RtcRecoveryAction {
    let Some(peer_state) = model.rtc_peer_states.get_mut(peer_id) else {
        return RtcRecoveryAction::None;
    };
    if role == RoomRole::Receiver && peer_state.phase == RtcPhase::Failed {
        return RtcRecoveryAction::None;
    }

    let (action, terminal) = match connection_phase {
        RtcConnectionPhase::Failed | RtcConnectionPhase::Closed => {
            invalidate_work(peer_state);
            peer_state.phase = RtcPhase::Disconnected;
            let action = if role == RoomRole::Owner {
                RtcRecoveryAction::RestartOffer
            } else {
                RtcRecoveryAction::ArmPassiveDeadline
            };
            (action, true)
        }
        RtcConnectionPhase::Disconnected => {
            peer_state.phase = RtcPhase::Disconnected;
            let action = if peer_state.pending_work.is_none() {
                RtcRecoveryAction::WaitForReconnect {
                    token: arm_work(peer_state, PendingRtcWork::DisconnectedDeadline),
                }
            } else {
                RtcRecoveryAction::None
            };
            (action, false)
        }
        connection_phase => {
            peer_state.phase = match connection_phase {
                RtcConnectionPhase::New
                | RtcConnectionPhase::Connecting
                | RtcConnectionPhase::Connected
                    if peer_state.phase == RtcPhase::Ready =>
                {
                    RtcPhase::Ready
                }
                RtcConnectionPhase::New
                | RtcConnectionPhase::Connecting
                | RtcConnectionPhase::Connected => RtcPhase::Connecting,
                RtcConnectionPhase::Disconnected
                | RtcConnectionPhase::Failed
                | RtcConnectionPhase::Closed => unreachable!(),
            };
            (RtcRecoveryAction::None, false)
        }
    };
    if terminal {
        set_peer_transfer_link_state(model, peer_id, TransferLinkState::Waiting);
    }
    refresh_aggregate_rtc(model);
    action
}

pub(super) fn set_peer_rtc_error(model: &mut AppModel, peer_id: &str, message: String) {
    model.error = Some(message.clone());
    model.rtc_error = Some(PeerRtcError {
        peer_id: peer_id.to_owned(),
        message,
    });
}

pub(super) fn clear_peer_rtc_error(model: &mut AppModel, peer_id: &str) {
    let Some(rtc_error) = model
        .rtc_error
        .as_ref()
        .filter(|rtc_error| rtc_error.peer_id == peer_id)
        .cloned()
    else {
        return;
    };
    model.rtc_error = None;
    if model.error.as_deref() == Some(rtc_error.message.as_str()) {
        model.error = None;
    }
}

pub(super) fn begin_rtc_config_loading(model: &mut AppModel) {
    clear_rtc_config_error(model);
    model.rtc_config_phase = RtcConfigPhase::Loading;
}

pub(super) fn mark_rtc_config_ready(model: &mut AppModel) {
    clear_rtc_config_error(model);
    model.rtc_config_phase = RtcConfigPhase::Ready;
}

pub(super) fn mark_rtc_config_failed(model: &mut AppModel, message: String) {
    model.rtc_config_phase = RtcConfigPhase::Failed;
    model.error = Some(message.clone());
    model.rtc_config_error = Some(message);
}

pub(super) fn deactivate_rtc_config(model: &mut AppModel) {
    clear_rtc_config_error(model);
    model.rtc_config_phase = RtcConfigPhase::Inactive;
}

fn clear_rtc_config_error(model: &mut AppModel) {
    let Some(message) = model.rtc_config_error.take() else {
        return;
    };
    if model.error.as_deref() == Some(message.as_str()) {
        model.error = None;
    }
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
    model.rtc_aggregate_phase = if model.rtc_peer_states.is_empty() {
        if matches!(model.screen, Screen::Room { .. }) {
            RtcPhase::WaitingPeer
        } else {
            RtcPhase::Inactive
        }
    } else if model
        .rtc_peer_states
        .values()
        .any(|peer_state| peer_state.phase == RtcPhase::Ready)
    {
        RtcPhase::Ready
    } else if model
        .rtc_peer_states
        .values()
        .any(|peer_state| peer_state.phase == RtcPhase::Connecting)
    {
        RtcPhase::Connecting
    } else if model
        .rtc_peer_states
        .values()
        .any(|peer_state| peer_state.phase == RtcPhase::Disconnected)
    {
        RtcPhase::Disconnected
    } else if model
        .rtc_peer_states
        .values()
        .any(|peer_state| peer_state.phase == RtcPhase::Failed)
    {
        RtcPhase::Failed
    } else {
        RtcPhase::WaitingPeer
    };
}

fn arm_work(
    peer_state: &mut crate::app_state::PeerRtcState,
    pending_work: PendingRtcWork,
) -> RtcWorkToken {
    peer_state.work_generation = peer_state.work_generation.wrapping_add(1);
    peer_state.pending_work = Some(pending_work);
    RtcWorkToken {
        instance_generation: peer_state.instance_generation,
        work_generation: peer_state.work_generation,
    }
}

fn invalidate_work(peer_state: &mut crate::app_state::PeerRtcState) {
    peer_state.work_generation = peer_state.work_generation.wrapping_add(1);
    peer_state.pending_work = None;
}

fn work_is_current(
    peer_state: &crate::app_state::PeerRtcState,
    token: RtcWorkToken,
    expected: PendingRtcWork,
) -> bool {
    peer_state.instance_generation == token.instance_generation
        && peer_state.work_generation == token.work_generation
        && peer_state.pending_work == Some(expected)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_failure_and_peer_aggregate_remain_independent() {
        let mut model = AppModel {
            rtc_aggregate_phase: RtcPhase::Ready,
            ..AppModel::default()
        };

        mark_rtc_config_failed(&mut model, "config failed".to_owned());
        assert_eq!(model.rtc_config_phase, RtcConfigPhase::Failed);
        assert_eq!(model.rtc_aggregate_phase, RtcPhase::Ready);

        refresh_aggregate_rtc(&mut model);
        assert_eq!(model.rtc_config_phase, RtcConfigPhase::Failed);
        assert_eq!(model.rtc_aggregate_phase, RtcPhase::Inactive);
    }

    #[test]
    fn clearing_config_error_preserves_a_newer_error_source() {
        let mut model = AppModel::default();
        mark_rtc_config_failed(&mut model, "config failed".to_owned());
        model.error = Some("transfer failed".to_owned());

        mark_rtc_config_ready(&mut model);

        assert_eq!(model.rtc_config_phase, RtcConfigPhase::Ready);
        assert_eq!(model.error.as_deref(), Some("transfer failed"));
        assert!(model.rtc_config_error.is_none());
    }
}
