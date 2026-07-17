use std::{cell::Cell, rc::Rc};

use p2p_protocol::{CURRENT_PROTOCOL, ClientRealtimeMessage};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct RevisionCursor {
    last_revision: u64,
    applied_revision: u64,
    awaiting_snapshot: bool,
}

impl RevisionCursor {
    fn new(revision: u64) -> Self {
        Self {
            last_revision: revision,
            applied_revision: revision,
            awaiting_snapshot: false,
        }
    }

    fn observe(&mut self, revision: u64) {
        self.last_revision = self.last_revision.max(revision);
    }

    fn mark_applied(&mut self, revision: u64) {
        self.observe(revision);
        self.applied_revision = self.applied_revision.max(revision);
        self.awaiting_snapshot = false;
    }

    fn reconcile_applied(&mut self, revision: u64) {
        self.observe(revision);
        self.applied_revision = self.applied_revision.max(revision);
    }

    fn mark_snapshot_pending(&mut self, revision: u64) {
        self.observe(revision);
        self.awaiting_snapshot = true;
    }
}

#[derive(Debug)]
enum RealtimeTargetInner {
    Member {
        room_code: String,
        peer_id: String,
        revision: Cell<RevisionCursor>,
    },
    JoinWatch {
        room_code: String,
        request_id: String,
        revision: Cell<RevisionCursor>,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum RealtimeTargetKind {
    Member,
    JoinWatch,
}

#[derive(Clone, Debug)]
pub(super) struct RealtimeTarget {
    inner: Rc<RealtimeTargetInner>,
}

impl RealtimeTarget {
    fn new(inner: RealtimeTargetInner) -> Self {
        Self {
            inner: Rc::new(inner),
        }
    }

    pub(super) fn kind(&self) -> RealtimeTargetKind {
        match self.inner.as_ref() {
            RealtimeTargetInner::Member { .. } => RealtimeTargetKind::Member,
            RealtimeTargetInner::JoinWatch { .. } => RealtimeTargetKind::JoinWatch,
        }
    }

    pub(super) fn is_member(&self) -> bool {
        self.kind() == RealtimeTargetKind::Member
    }

    pub(super) fn initial_message(&self) -> ClientRealtimeMessage {
        match self.inner.as_ref() {
            RealtimeTargetInner::Member {
                room_code,
                peer_id,
                revision,
            } => ClientRealtimeMessage::AttachRoom {
                version: CURRENT_PROTOCOL,
                room_code: room_code.clone(),
                peer_id: peer_id.clone(),
                last_revision: Some(revision.get().applied_revision),
            },
            RealtimeTargetInner::JoinWatch {
                room_code,
                request_id,
                revision,
            } => ClientRealtimeMessage::WatchJoinRequest {
                version: CURRENT_PROTOCOL,
                room_code: room_code.clone(),
                request_id: request_id.clone(),
                last_revision: Some(revision.get().applied_revision),
            },
        }
    }

    pub(super) fn last_revision(&self) -> u64 {
        self.revision().last_revision
    }

    pub(super) fn awaiting_snapshot(&self) -> bool {
        self.revision().awaiting_snapshot
    }

    pub(super) fn observe_revision(&self, revision: u64) {
        self.update_revision(|cursor| cursor.observe(revision));
    }

    pub(super) fn reconcile_applied_revision(&self, revision: u64) {
        self.update_revision(|cursor| cursor.reconcile_applied(revision));
    }

    pub(super) fn mark_snapshot_pending(&self, revision: u64) {
        self.update_revision(|cursor| cursor.mark_snapshot_pending(revision));
    }

    pub(super) fn mark_revision_applied(&self, revision: u64) {
        self.update_revision(|cursor| cursor.mark_applied(revision));
    }

    pub(super) fn is_same_instance(&self, other: &Self) -> bool {
        Rc::ptr_eq(&self.inner, &other.inner)
    }

    fn revision_cell(&self) -> &Cell<RevisionCursor> {
        match self.inner.as_ref() {
            RealtimeTargetInner::Member { revision, .. }
            | RealtimeTargetInner::JoinWatch { revision, .. } => revision,
        }
    }

    fn revision(&self) -> RevisionCursor {
        self.revision_cell().get()
    }

    fn update_revision(&self, update: impl FnOnce(&mut RevisionCursor)) {
        let revision = self.revision_cell();
        let mut cursor = revision.get();
        update(&mut cursor);
        revision.set(cursor);
    }
}

#[derive(Clone, Debug)]
pub(super) struct RealtimeTargetScope {
    target: RealtimeTarget,
}

impl RealtimeTargetScope {
    pub(super) fn new(target: RealtimeTarget) -> Self {
        Self { target }
    }

    pub(super) fn is_same_instance(&self, other: &Self) -> bool {
        self.target.is_same_instance(&other.target)
    }

    pub(super) fn is_current(&self, target: Option<&RealtimeTarget>) -> bool {
        target.is_some_and(|target| self.target.is_same_instance(target))
    }
}

pub(super) fn same_optional_target_instance(
    left: Option<&RealtimeTarget>,
    right: Option<&RealtimeTarget>,
) -> bool {
    match (left, right) {
        (Some(left), Some(right)) => left.is_same_instance(right),
        (None, None) => true,
        _ => false,
    }
}

pub(super) fn member_target(
    room_code: String,
    last_revision: u64,
    peer_id: String,
) -> RealtimeTarget {
    RealtimeTarget::new(RealtimeTargetInner::Member {
        room_code,
        peer_id,
        revision: Cell::new(RevisionCursor::new(last_revision)),
    })
}

pub(super) fn join_watch_target(
    room_code: String,
    request_id: String,
    last_revision: u64,
) -> RealtimeTarget {
    RealtimeTarget::new(RealtimeTargetInner::JoinWatch {
        room_code,
        request_id,
        revision: Cell::new(RevisionCursor::new(last_revision)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn revision_cursor_never_moves_backwards_and_reconnects_from_applied_state() {
        let target = member_target("ABC234".to_owned(), 5, "peer_owner".to_owned());
        target.mark_snapshot_pending(8);
        target.reconcile_applied_revision(6);
        assert_eq!(target.last_revision(), 8);
        assert!(target.awaiting_snapshot());
        assert!(matches!(
            target.initial_message(),
            ClientRealtimeMessage::AttachRoom {
                last_revision: Some(6),
                ..
            }
        ));

        target.mark_revision_applied(8);
        target.observe_revision(6);
        assert_eq!(target.last_revision(), 8);
        assert!(!target.awaiting_snapshot());
        assert!(matches!(
            target.initial_message(),
            ClientRealtimeMessage::AttachRoom {
                last_revision: Some(8),
                ..
            }
        ));
    }

    #[test]
    fn join_watch_initial_message_keeps_all_target_fields() {
        let target = join_watch_target("ABC234".to_owned(), "request-7".to_owned(), 12);

        let ClientRealtimeMessage::WatchJoinRequest {
            version,
            room_code,
            request_id,
            last_revision,
        } = target.initial_message()
        else {
            panic!("join-watch target should create a watch message")
        };
        assert_eq!(version, CURRENT_PROTOCOL);
        assert_eq!(room_code, "ABC234");
        assert_eq!(request_id, "request-7");
        assert_eq!(last_revision, Some(12));
    }

    #[test]
    fn target_identity_tracks_the_shared_inner_allocation() {
        let target = member_target("ABC234".to_owned(), 5, "peer_owner".to_owned());
        let clone = target.clone();
        let replacement = member_target("ABC234".to_owned(), 5, "peer_owner".to_owned());

        assert!(target.is_same_instance(&clone));
        assert!(!target.is_same_instance(&replacement));
        assert!(RealtimeTargetScope::new(target).is_current(Some(&clone)));
    }
}
