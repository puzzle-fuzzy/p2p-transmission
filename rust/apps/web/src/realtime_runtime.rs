use std::rc::Rc;

use dioxus::prelude::Signal;
use p2p_browser_platform::{RealtimeConnection, RtcConfigLease, RtcPeerRegistry};

use crate::app_state::AppModel;
use crate::realtime_target::{RealtimeTarget, RealtimeTargetScope};

#[derive(Clone, Debug)]
pub(super) struct ScopedRtcConfig {
    target_scope: RealtimeTargetScope,
    lease: RtcConfigLease,
}

impl ScopedRtcConfig {
    pub(super) fn new(target_scope: RealtimeTargetScope, lease: RtcConfigLease) -> Self {
        Self {
            target_scope,
            lease,
        }
    }

    pub(super) fn for_scope(&self, target_scope: &RealtimeTargetScope) -> Option<&RtcConfigLease> {
        self.target_scope
            .is_same_instance(target_scope)
            .then_some(&self.lease)
            .filter(|lease| lease.is_valid())
    }

    pub(super) fn matches(
        &self,
        target_scope: &RealtimeTargetScope,
        lease: &RtcConfigLease,
    ) -> bool {
        self.target_scope.is_same_instance(target_scope) && self.lease.ptr_eq(lease)
    }
}

#[derive(Clone, Debug)]
pub(super) struct SuppressedTarget {
    pub(super) generation: Rc<()>,
    pub(super) target: RealtimeTarget,
}

#[derive(Clone, Debug)]
pub(super) struct RealtimeConnectionState {
    pub(super) generation: Rc<()>,
    pub(super) backoff_attempt: u32,
    pub(super) retry_token: Rc<()>,
    pub(super) active_target: Option<RealtimeTarget>,
    pub(super) suppressed_for_target: Option<SuppressedTarget>,
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

#[derive(Clone, Copy)]
pub(super) struct RealtimeConnectionRuntime {
    pub(super) trigger: Signal<u64>,
    pub(super) state: Signal<RealtimeConnectionState>,
}

#[derive(Clone, Copy)]
pub(super) struct RtcRuntime {
    pub(super) connection: Signal<Option<RealtimeConnection>>,
    pub(super) peers: Signal<RtcPeerRegistry>,
    pub(super) config: Signal<Option<ScopedRtcConfig>>,
}

#[derive(Clone, Debug)]
pub(super) struct LifecycleRecovery {
    pub(super) target: RealtimeTargetScope,
    pub(super) rebuild_resumable_peers_after_attach: bool,
}

#[derive(Clone, Debug, Default)]
pub(super) struct LifecycleState {
    pub(super) hidden: bool,
    pub(super) network_recovery_pending: bool,
    pub(super) recovery: Option<LifecycleRecovery>,
}

#[derive(Clone, Copy)]
pub(super) struct RealtimeSessionRuntime {
    pub(super) model: Signal<AppModel>,
    pub(super) target: Signal<Option<RealtimeTarget>>,
    pub(super) connection: RealtimeConnectionRuntime,
    pub(super) rtc: RtcRuntime,
    pub(super) lifecycle_state: Signal<LifecycleState>,
}
