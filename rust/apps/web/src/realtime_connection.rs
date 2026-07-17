use std::rc::Rc;

use dioxus::prelude::*;
use p2p_browser_platform::{connect_realtime, sleep_ms};

use crate::realtime_session::{RealtimeSessionRuntime, RealtimeTarget, handle_realtime_event};
use crate::{RealtimePhase, RtcPhase, friendly_error};

#[derive(Clone, Debug)]
struct SuppressedTarget {
    generation: Rc<()>,
    target: RealtimeTarget,
}

#[derive(Clone, Debug)]
pub(super) struct RealtimeConnectionState {
    generation: Rc<()>,
    backoff_attempt: u32,
    retry_token: Rc<()>,
    active_target: Option<RealtimeTarget>,
    suppressed_for_target: Option<SuppressedTarget>,
}

#[derive(Clone, Copy)]
pub(super) struct RealtimeConnectionRuntime {
    pub(super) trigger: Signal<u64>,
    pub(super) state: Signal<RealtimeConnectionState>,
}

#[derive(Clone, Debug)]
pub(super) struct RealtimeLease {
    generation: Rc<()>,
    target: RealtimeTarget,
}

#[derive(Clone, Debug)]
pub(super) struct RealtimeTargetScope {
    target: RealtimeTarget,
}

enum BeginConnection {
    Disconnected,
    Suppressed,
    Connect { lease: RealtimeLease, attempt: u32 },
}

#[derive(Clone, Debug)]
struct RetryTicket {
    generation: Rc<()>,
    retry_token: Rc<()>,
    attempt: u32,
    target: RealtimeTarget,
}

impl Default for RealtimeConnectionState {
    fn default() -> Self {
        Self {
            generation: Rc::new(()),
            backoff_attempt: 0,
            retry_token: Rc::new(()),
            active_target: None,
            suppressed_for_target: None,
        }
    }
}

impl RealtimeConnectionState {
    fn begin(&mut self, target: Option<RealtimeTarget>) -> BeginConnection {
        self.generation = Rc::new(());

        let target_changed =
            !same_optional_target_instance(self.active_target.as_ref(), target.as_ref());
        if target_changed {
            self.backoff_attempt = 0;
            self.retry_token = Rc::new(());
            self.suppressed_for_target = None;
        }
        self.active_target = target.clone();

        let Some(target) = target else {
            return BeginConnection::Disconnected;
        };
        if self.target_is_suppressed(&target) {
            return BeginConnection::Suppressed;
        }

        BeginConnection::Connect {
            lease: RealtimeLease {
                generation: self.generation.clone(),
                target,
            },
            attempt: self.backoff_attempt,
        }
    }

    fn current_lease(&self, target: &RealtimeTarget) -> Option<RealtimeLease> {
        if !self
            .active_target
            .as_ref()
            .is_some_and(|active| active.is_same_instance(target))
            || self.target_is_suppressed(target)
        {
            return None;
        }
        Some(RealtimeLease {
            generation: self.generation.clone(),
            target: target.clone(),
        })
    }

    fn lease_is_current(&self, lease: &RealtimeLease) -> bool {
        Rc::ptr_eq(&self.generation, &lease.generation)
            && self
                .active_target
                .as_ref()
                .is_some_and(|target| target.is_same_instance(&lease.target))
            && !self.target_is_suppressed(&lease.target)
    }

    fn invalidate(&mut self) {
        self.generation = Rc::new(());
    }

    fn mark_connected(&mut self, lease: &RealtimeLease) -> bool {
        if !self.lease_is_current(lease) {
            return false;
        }
        self.backoff_attempt = 0;
        self.retry_token = Rc::new(());
        true
    }

    fn retry_ticket(&self, lease: &RealtimeLease) -> Option<RetryTicket> {
        self.lease_is_current(lease).then(|| RetryTicket {
            generation: lease.generation.clone(),
            retry_token: self.retry_token.clone(),
            attempt: self.backoff_attempt,
            target: lease.target.clone(),
        })
    }

    fn claim_reconnect_timer(&mut self, ticket: &RetryTicket, phase: RealtimePhase) -> bool {
        if phase != RealtimePhase::Reconnecting
            || !Rc::ptr_eq(&self.generation, &ticket.generation)
            || !Rc::ptr_eq(&self.retry_token, &ticket.retry_token)
            || self.backoff_attempt != ticket.attempt
            || !self
                .active_target
                .as_ref()
                .is_some_and(|target| target.is_same_instance(&ticket.target))
            || self.target_is_suppressed(&ticket.target)
        {
            return false;
        }
        self.backoff_attempt = self.backoff_attempt.saturating_add(1);
        self.retry_token = Rc::new(());
        true
    }

    fn suppress(&mut self, lease: &RealtimeLease) -> bool {
        if !self.lease_is_current(lease) {
            return false;
        }
        self.suppressed_for_target = Some(SuppressedTarget {
            generation: lease.generation.clone(),
            target: lease.target.clone(),
        });
        true
    }

    fn suppression_is_current(&self, lease: &RealtimeLease) -> bool {
        Rc::ptr_eq(&self.generation, &lease.generation)
            && self
                .suppressed_for_target
                .as_ref()
                .is_some_and(|suppressed| {
                    Rc::ptr_eq(&suppressed.generation, &lease.generation)
                        && suppressed.target.is_same_instance(&lease.target)
                })
    }

    fn target_is_suppressed(&self, target: &RealtimeTarget) -> bool {
        self.suppressed_for_target
            .as_ref()
            .is_some_and(|suppressed| suppressed.target.is_same_instance(target))
    }
}

impl RealtimeLease {
    pub(super) fn initial_message(&self) -> p2p_protocol::ClientRealtimeMessage {
        self.target.initial_message()
    }

    pub(super) fn target_scope(&self) -> RealtimeTargetScope {
        RealtimeTargetScope {
            target: self.target.clone(),
        }
    }
}

impl RealtimeTargetScope {
    pub(super) fn new(target: RealtimeTarget) -> Self {
        Self { target }
    }

    pub(super) fn is_same_instance(&self, other: &Self) -> bool {
        self.target.is_same_instance(&other.target)
    }

    fn is_current(&self, target: Option<&RealtimeTarget>) -> bool {
        target.is_some_and(|target| self.target.is_same_instance(target))
    }
}

impl RetryTicket {
    fn delay_ms(&self) -> u32 {
        500_u32.saturating_mul(1_u32 << self.attempt.min(4))
    }
}

fn next_trigger(current: u64) -> u64 {
    current.wrapping_add(1)
}

fn same_optional_target_instance(
    left: Option<&RealtimeTarget>,
    right: Option<&RealtimeTarget>,
) -> bool {
    match (left, right) {
        (Some(left), Some(right)) => left.is_same_instance(right),
        (None, None) => true,
        _ => false,
    }
}

pub(super) fn use_realtime_connection(runtime: RealtimeSessionRuntime) {
    let target = runtime.target;
    let trigger = runtime.connection.trigger;
    let mut socket = runtime.rtc.connection;
    let mut model = runtime.model;

    use_effect(move || {
        let target = target.read().clone();
        let _trigger = *trigger.read();
        let target_scope = target.clone().map(RealtimeTargetScope::new);
        crate::browser_lifecycle::sync_lifecycle_recovery_target(
            runtime.lifecycle_state,
            target_scope.as_ref(),
        );
        let begin = begin_realtime_connection(runtime.connection, target);

        // Generation must advance before the old socket (and its callbacks) is released.
        socket.set(None);

        let (lease, attempt) = match begin {
            BeginConnection::Disconnected => {
                model.write().realtime = RealtimePhase::Disconnected;
                return;
            }
            BeginConnection::Suppressed => {
                model.write().realtime = RealtimePhase::Superseded;
                return;
            }
            BeginConnection::Connect { lease, attempt } => (lease, attempt),
        };

        model.write().realtime = if attempt == 0 {
            RealtimePhase::Connecting
        } else {
            RealtimePhase::Reconnecting
        };
        let initial = lease.initial_message();
        let event_lease = lease.clone();
        let on_event = Callback::new(move |event| {
            handle_realtime_event(runtime, event_lease.clone(), event);
        });
        match connect_realtime(initial, on_event.into_closure()) {
            Ok(active) => {
                if realtime_lease_is_current(&lease, runtime.connection, runtime.target) {
                    socket.set(Some(active));
                }
            }
            Err(error) => {
                if !realtime_lease_is_current(&lease, runtime.connection, runtime.target) {
                    return;
                }
                {
                    let mut state = model.write();
                    state.realtime = RealtimePhase::Reconnecting;
                    state.error = Some(friendly_error(&error));
                }
                schedule_reconnect(runtime, lease);
            }
        }
    });
}

fn begin_realtime_connection(
    mut runtime: RealtimeConnectionRuntime,
    target: Option<RealtimeTarget>,
) -> BeginConnection {
    runtime.state.write().begin(target)
}

pub(super) fn invalidate_realtime_lease(mut runtime: RealtimeConnectionRuntime) {
    runtime.state.write().invalidate();
}

pub(super) fn current_realtime_lease(
    runtime: RealtimeConnectionRuntime,
    target: Signal<Option<RealtimeTarget>>,
) -> Option<RealtimeLease> {
    let target = target.peek();
    let target = target.as_ref()?;
    runtime.state.peek().current_lease(target)
}

pub(super) fn current_realtime_target_scope(
    target: Signal<Option<RealtimeTarget>>,
) -> Option<RealtimeTargetScope> {
    target.peek().clone().map(RealtimeTargetScope::new)
}

pub(super) fn realtime_target_scope_is_current(
    scope: &RealtimeTargetScope,
    target: Signal<Option<RealtimeTarget>>,
) -> bool {
    scope.is_current(target.peek().as_ref())
}

pub(super) fn realtime_target_is_suppressed(
    runtime: RealtimeConnectionRuntime,
    target: Signal<Option<RealtimeTarget>>,
) -> bool {
    target
        .peek()
        .as_ref()
        .is_some_and(|target| runtime.state.peek().target_is_suppressed(target))
}

pub(super) fn realtime_lease_is_current(
    lease: &RealtimeLease,
    runtime: RealtimeConnectionRuntime,
    target: Signal<Option<RealtimeTarget>>,
) -> bool {
    target
        .peek()
        .as_ref()
        .is_some_and(|target| target.is_same_instance(&lease.target))
        && runtime.state.peek().lease_is_current(lease)
}

pub(super) fn mark_realtime_connected(
    mut runtime: RealtimeConnectionRuntime,
    lease: &RealtimeLease,
) -> bool {
    runtime.state.write().mark_connected(lease)
}

pub(super) fn schedule_reconnect(mut runtime: RealtimeSessionRuntime, lease: RealtimeLease) {
    let Some(ticket) = runtime.connection.state.peek().retry_ticket(&lease) else {
        return;
    };
    spawn(async move {
        sleep_ms(ticket.delay_ms()).await;
        if !runtime
            .target
            .peek()
            .as_ref()
            .is_some_and(|target| target.is_same_instance(&ticket.target))
        {
            return;
        }
        let phase = runtime.model.peek().realtime;
        if !runtime
            .connection
            .state
            .write()
            .claim_reconnect_timer(&ticket, phase)
        {
            return;
        }

        let current = *runtime.connection.trigger.peek();
        runtime.connection.trigger.set(next_trigger(current));
    });
}

pub(super) fn defer_realtime_socket_clear(
    mut runtime: RealtimeSessionRuntime,
    lease: RealtimeLease,
) {
    spawn(async move {
        sleep_ms(0).await;
        if realtime_lease_is_current(&lease, runtime.connection, runtime.target) {
            runtime.rtc.connection.set(None);
        }
    });
}

pub(super) fn suppress_realtime_connection(
    mut runtime: RealtimeSessionRuntime,
    lease: RealtimeLease,
) {
    if !runtime.connection.state.write().suppress(&lease) {
        return;
    }
    crate::rtc_session::reset_all_rtc_peers(runtime.rtc.peers);
    runtime.rtc.config.set(None);
    {
        let mut model = runtime.model.write();
        model.realtime = RealtimePhase::Superseded;
        model.rtc = RtcPhase::Inactive;
        model.notice = Some("此房间已在另一个标签页中打开，本页面已停止重连".to_owned());
        model.error = None;
    }

    // Dropping the connection synchronously from its own callback would also drop
    // the Closure currently executing. Defer disposal until the callback unwinds.
    spawn(async move {
        sleep_ms(0).await;
        if runtime
            .connection
            .state
            .peek()
            .suppression_is_current(&lease)
        {
            runtime.rtc.connection.set(None);
        }
    });
}

#[cfg(test)]
mod tests {
    use std::{cell::Cell, rc::Rc};

    use super::*;
    use crate::realtime_session::RevisionCursor;

    fn target(room: &str) -> RealtimeTarget {
        RealtimeTarget::Member {
            room_code: room.to_owned(),
            peer_id: format!("peer-{room}"),
            revision: Rc::new(Cell::new(RevisionCursor::new(0))),
        }
    }

    fn connect(state: &mut RealtimeConnectionState, target: RealtimeTarget) -> RealtimeLease {
        let BeginConnection::Connect { lease, .. } = state.begin(Some(target)) else {
            panic!("target should connect")
        };
        lease
    }

    #[test]
    fn same_target_keeps_backoff_across_generations() {
        let target = target("same");
        let mut state = RealtimeConnectionState::default();
        let first = connect(&mut state, target.clone());
        let first_retry = state.retry_ticket(&first).unwrap();
        assert!(state.claim_reconnect_timer(&first_retry, RealtimePhase::Reconnecting));

        let second = connect(&mut state, target);
        assert_eq!(state.backoff_attempt, 1);
        assert!(!Rc::ptr_eq(&second.generation, &first.generation));
    }

    #[test]
    fn connected_resets_backoff_without_requesting_another_generation() {
        let target = target("connected");
        let mut state = RealtimeConnectionState::default();
        let first = connect(&mut state, target.clone());
        let first_retry = state.retry_ticket(&first).unwrap();
        assert!(state.claim_reconnect_timer(&first_retry, RealtimePhase::Reconnecting));
        let connected = connect(&mut state, target);
        let generation = state.generation.clone();

        assert!(state.mark_connected(&connected));
        assert_eq!(state.backoff_attempt, 0);
        assert!(Rc::ptr_eq(&state.generation, &generation));
        assert_eq!(state.retry_ticket(&connected).unwrap().attempt, 0);
    }

    #[test]
    fn new_target_clears_backoff() {
        let mut state = RealtimeConnectionState::default();
        let first = connect(&mut state, target("old"));
        let first_retry = state.retry_ticket(&first).unwrap();
        assert!(state.claim_reconnect_timer(&first_retry, RealtimePhase::Reconnecting));

        let _next = connect(&mut state, target("new"));
        assert_eq!(state.backoff_attempt, 0);
    }

    #[test]
    fn only_first_matching_reconnect_timer_can_advance() {
        let mut state = RealtimeConnectionState::default();
        let lease = connect(&mut state, target("timer"));
        let ticket = state.retry_ticket(&lease).unwrap();

        assert!(state.claim_reconnect_timer(&ticket, RealtimePhase::Reconnecting));
        assert!(!state.claim_reconnect_timer(&ticket, RealtimePhase::Reconnecting));
        assert_eq!(state.backoff_attempt, 1);
    }

    #[test]
    fn saturated_backoff_still_consumes_each_retry_ticket_once() {
        let mut state = RealtimeConnectionState::default();
        let lease = connect(&mut state, target("saturated"));
        state.backoff_attempt = u32::MAX;
        let ticket = state.retry_ticket(&lease).unwrap();

        assert!(state.claim_reconnect_timer(&ticket, RealtimePhase::Reconnecting));
        assert!(!state.claim_reconnect_timer(&ticket, RealtimePhase::Reconnecting));
        assert_eq!(state.backoff_attempt, u32::MAX);
    }

    #[test]
    fn suppression_persists_for_same_target_and_clears_for_new_instance() {
        let suppressed_target = target("suppressed");
        let mut state = RealtimeConnectionState::default();
        let lease = connect(&mut state, suppressed_target.clone());
        assert!(state.suppress(&lease));
        assert!(!state.suppress(&lease));
        assert!(state.current_lease(&suppressed_target).is_none());
        assert!(matches!(
            state.begin(Some(suppressed_target)),
            BeginConnection::Suppressed
        ));

        let replacement = target("suppressed");
        let BeginConnection::Connect { lease: _, attempt } = state.begin(Some(replacement)) else {
            panic!("new target instance should clear suppression")
        };
        assert_eq!(attempt, 0);
        assert!(state.suppressed_for_target.is_none());
    }

    #[test]
    fn reconnect_trigger_wraps_without_panicking() {
        assert_eq!(next_trigger(u64::MAX), 0);
    }
}
