use std::collections::BTreeMap;

use thiserror::Error;

use crate::{EpochMillis, PeerId, RequestId, Revision, RoomCode, RoomId, SessionId};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RoomState {
    Active,
    Expired,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MembershipRole {
    Owner,
    Receiver,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MembershipState {
    Offline,
    Online { peer_id: PeerId },
    Left,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct Membership {
    role: MembershipRole,
    state: MembershipState,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum JoinRequestState {
    Pending,
    Approved,
    Rejected,
    Cancelled,
    Expired,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct JoinRequest {
    session_id: SessionId,
    expires_at: EpochMillis,
    state: JoinRequestState,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RoomMembershipSnapshot {
    pub session_id: SessionId,
    pub role: MembershipRole,
    pub state: MembershipState,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RoomJoinRequestSnapshot {
    pub request_id: RequestId,
    pub session_id: SessionId,
    pub expires_at: EpochMillis,
    pub state: JoinRequestState,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum JoinDecision {
    Approve,
    Reject,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RoomExpiryReason {
    Deadline,
    OwnerLeft,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RoomCommand {
    RequestJoin {
        request_id: RequestId,
        session_id: SessionId,
        now: EpochMillis,
        expires_at: EpochMillis,
    },
    DecideJoin {
        actor: SessionId,
        request_id: RequestId,
        decision: JoinDecision,
        now: EpochMillis,
    },
    ExpireJoinRequest {
        request_id: RequestId,
        now: EpochMillis,
    },
    Attach {
        session_id: SessionId,
        peer_id: PeerId,
        now: EpochMillis,
    },
    Detach {
        session_id: SessionId,
        peer_id: PeerId,
    },
    Leave {
        session_id: SessionId,
    },
    Expire {
        now: EpochMillis,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RoomEvent {
    RoomCreated {
        room_id: RoomId,
        owner: SessionId,
    },
    JoinRequested {
        request_id: RequestId,
        session_id: SessionId,
    },
    JoinApproved {
        request_id: RequestId,
        session_id: SessionId,
    },
    JoinRejected {
        request_id: RequestId,
        session_id: SessionId,
    },
    JoinCancelled {
        request_id: RequestId,
        session_id: SessionId,
    },
    JoinExpired {
        request_id: RequestId,
        session_id: SessionId,
    },
    PeerOnline {
        session_id: SessionId,
        peer_id: PeerId,
    },
    PeerOffline {
        session_id: SessionId,
        peer_id: PeerId,
    },
    MemberLeft {
        session_id: SessionId,
    },
    RoomExpired {
        reason: RoomExpiryReason,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RoomCommandOutcome {
    pub revision: Revision,
    pub events: Vec<RoomEvent>,
}

impl RoomCommandOutcome {
    pub fn changed(&self) -> bool {
        !self.events.is_empty()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Room {
    id: RoomId,
    code: RoomCode,
    owner: SessionId,
    expires_at: EpochMillis,
    state: RoomState,
    revision: Revision,
    memberships: BTreeMap<SessionId, Membership>,
    join_requests: BTreeMap<RequestId, JoinRequest>,
}

impl Room {
    pub fn create(
        id: RoomId,
        code: RoomCode,
        owner: SessionId,
        now: EpochMillis,
        expires_at: EpochMillis,
    ) -> Result<(Self, RoomCommandOutcome), RoomError> {
        if expires_at <= now {
            return Err(RoomError::InvalidExpiry);
        }
        let memberships = BTreeMap::from([(
            owner.clone(),
            Membership {
                role: MembershipRole::Owner,
                state: MembershipState::Offline,
            },
        )]);
        let room = Self {
            id: id.clone(),
            code,
            owner: owner.clone(),
            expires_at,
            state: RoomState::Active,
            revision: Revision::new(1),
            memberships,
            join_requests: BTreeMap::new(),
        };
        let outcome = RoomCommandOutcome {
            revision: room.revision,
            events: vec![RoomEvent::RoomCreated { room_id: id, owner }],
        };
        Ok((room, outcome))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn restore(
        id: RoomId,
        code: RoomCode,
        owner: SessionId,
        expires_at: EpochMillis,
        state: RoomState,
        revision: Revision,
        memberships: impl IntoIterator<Item = RoomMembershipSnapshot>,
        join_requests: impl IntoIterator<Item = RoomJoinRequestSnapshot>,
    ) -> Result<Self, RoomRestoreError> {
        let mut restored_memberships = BTreeMap::new();
        for membership in memberships {
            let session_id = membership.session_id;
            if restored_memberships
                .insert(
                    session_id.clone(),
                    Membership {
                        role: membership.role,
                        state: membership.state,
                    },
                )
                .is_some()
            {
                return Err(RoomRestoreError::DuplicateMembership(session_id));
            }
        }

        let mut restored_requests = BTreeMap::new();
        for request in join_requests {
            if request.expires_at > expires_at {
                return Err(RoomRestoreError::RequestOutlivesRoom(request.request_id));
            }
            let request_id = request.request_id;
            if restored_requests
                .insert(
                    request_id.clone(),
                    JoinRequest {
                        session_id: request.session_id,
                        expires_at: request.expires_at,
                        state: request.state,
                    },
                )
                .is_some()
            {
                return Err(RoomRestoreError::DuplicateJoinRequest(request_id));
            }
        }

        let room = Self {
            id,
            code,
            owner,
            expires_at,
            state,
            revision,
            memberships: restored_memberships,
            join_requests: restored_requests,
        };
        room.verify_invariants()?;
        Ok(room)
    }

    pub fn id(&self) -> &RoomId {
        &self.id
    }

    pub fn code(&self) -> &RoomCode {
        &self.code
    }

    pub fn owner(&self) -> &SessionId {
        &self.owner
    }

    pub const fn expires_at(&self) -> EpochMillis {
        self.expires_at
    }

    pub const fn state(&self) -> RoomState {
        self.state
    }

    pub const fn revision(&self) -> Revision {
        self.revision
    }

    pub fn membership_state(&self, session_id: &SessionId) -> Option<&MembershipState> {
        self.memberships
            .get(session_id)
            .map(|membership| &membership.state)
    }

    pub fn membership_role(&self, session_id: &SessionId) -> Option<MembershipRole> {
        self.memberships
            .get(session_id)
            .map(|membership| membership.role)
    }

    pub fn join_request_state(&self, request_id: &RequestId) -> Option<JoinRequestState> {
        self.join_requests
            .get(request_id)
            .map(|request| request.state)
    }

    pub fn membership_snapshots(&self) -> Vec<RoomMembershipSnapshot> {
        self.memberships
            .iter()
            .map(|(session_id, membership)| RoomMembershipSnapshot {
                session_id: session_id.clone(),
                role: membership.role,
                state: membership.state.clone(),
            })
            .collect()
    }

    pub fn join_request_snapshots(&self) -> Vec<RoomJoinRequestSnapshot> {
        self.join_requests
            .iter()
            .map(|(request_id, request)| RoomJoinRequestSnapshot {
                request_id: request_id.clone(),
                session_id: request.session_id.clone(),
                expires_at: request.expires_at,
                state: request.state,
            })
            .collect()
    }

    pub fn handle(&mut self, command: RoomCommand) -> Result<RoomCommandOutcome, RoomError> {
        match command {
            RoomCommand::RequestJoin {
                request_id,
                session_id,
                now,
                expires_at,
            } => self.request_join(request_id, session_id, now, expires_at),
            RoomCommand::DecideJoin {
                actor,
                request_id,
                decision,
                now,
            } => self.decide_join(actor, request_id, decision, now),
            RoomCommand::ExpireJoinRequest { request_id, now } => {
                self.expire_join_request(request_id, now)
            }
            RoomCommand::Attach {
                session_id,
                peer_id,
                now,
            } => self.attach(session_id, peer_id, now),
            RoomCommand::Detach {
                session_id,
                peer_id,
            } => self.detach(session_id, peer_id),
            RoomCommand::Leave { session_id } => self.leave(session_id),
            RoomCommand::Expire { now } => self.expire(now),
        }
    }

    pub fn verify_invariants(&self) -> Result<(), RoomInvariantError> {
        if self.revision.value() == 0 {
            return Err(RoomInvariantError::ZeroRevision);
        }
        let owner = self
            .memberships
            .get(&self.owner)
            .ok_or(RoomInvariantError::MissingOwner)?;
        if owner.role != MembershipRole::Owner || owner.state == MembershipState::Left {
            return Err(RoomInvariantError::InvalidOwner);
        }
        for (session_id, membership) in &self.memberships {
            if session_id != &self.owner && membership.role != MembershipRole::Receiver {
                return Err(RoomInvariantError::InvalidReceiverRole);
            }
        }
        for request in self.join_requests.values() {
            if request.state == JoinRequestState::Approved {
                let membership = self
                    .memberships
                    .get(&request.session_id)
                    .ok_or(RoomInvariantError::ApprovedRequestWithoutMembership)?;
                if membership.role != MembershipRole::Receiver {
                    return Err(RoomInvariantError::ApprovedRequestWithoutMembership);
                }
            }
        }
        Ok(())
    }

    fn ensure_active(&self, now: EpochMillis) -> Result<(), RoomError> {
        if self.state != RoomState::Active || now >= self.expires_at {
            return Err(RoomError::Inactive);
        }
        Ok(())
    }

    fn unchanged(&self) -> RoomCommandOutcome {
        RoomCommandOutcome {
            revision: self.revision,
            events: Vec::new(),
        }
    }

    fn commit(&mut self, events: Vec<RoomEvent>) -> Result<RoomCommandOutcome, RoomError> {
        if events.is_empty() {
            return Ok(self.unchanged());
        }
        self.revision = self
            .revision
            .next()
            .map_err(|_| RoomError::RevisionOverflow)?;
        Ok(RoomCommandOutcome {
            revision: self.revision,
            events,
        })
    }

    fn request_join(
        &mut self,
        request_id: RequestId,
        session_id: SessionId,
        now: EpochMillis,
        expires_at: EpochMillis,
    ) -> Result<RoomCommandOutcome, RoomError> {
        self.ensure_active(now)?;
        if expires_at <= now || expires_at > self.expires_at {
            return Err(RoomError::InvalidRequestExpiry);
        }
        if let Some(existing) = self.join_requests.get(&request_id) {
            if existing.session_id == session_id && existing.expires_at == expires_at {
                return Ok(self.unchanged());
            }
            return Err(RoomError::IdempotencyConflict);
        }
        if self
            .memberships
            .get(&session_id)
            .is_some_and(|membership| membership.state != MembershipState::Left)
        {
            return Err(RoomError::AlreadyMember);
        }
        if self.join_requests.values().any(|request| {
            request.session_id == session_id && request.state == JoinRequestState::Pending
        }) {
            return Err(RoomError::PendingRequestExists);
        }

        self.join_requests.insert(
            request_id.clone(),
            JoinRequest {
                session_id: session_id.clone(),
                expires_at,
                state: JoinRequestState::Pending,
            },
        );
        self.commit(vec![RoomEvent::JoinRequested {
            request_id,
            session_id,
        }])
    }

    fn decide_join(
        &mut self,
        actor: SessionId,
        request_id: RequestId,
        decision: JoinDecision,
        now: EpochMillis,
    ) -> Result<RoomCommandOutcome, RoomError> {
        self.ensure_active(now)?;
        if actor != self.owner {
            return Err(RoomError::Unauthorized);
        }

        let (session_id, event) = {
            let request = self
                .join_requests
                .get_mut(&request_id)
                .ok_or(RoomError::RequestNotFound)?;
            if now >= request.expires_at {
                return Err(RoomError::RequestExpired);
            }
            match (request.state, decision) {
                (JoinRequestState::Pending, JoinDecision::Approve) => {
                    request.state = JoinRequestState::Approved;
                    let session_id = request.session_id.clone();
                    let event = RoomEvent::JoinApproved {
                        request_id: request_id.clone(),
                        session_id: session_id.clone(),
                    };
                    (session_id, event)
                }
                (JoinRequestState::Pending, JoinDecision::Reject) => {
                    request.state = JoinRequestState::Rejected;
                    let session_id = request.session_id.clone();
                    let event = RoomEvent::JoinRejected {
                        request_id: request_id.clone(),
                        session_id: session_id.clone(),
                    };
                    (session_id, event)
                }
                (JoinRequestState::Approved, JoinDecision::Approve)
                | (JoinRequestState::Rejected, JoinDecision::Reject) => {
                    return Ok(self.unchanged());
                }
                _ => return Err(RoomError::TerminalRequest),
            }
        };

        if decision == JoinDecision::Approve {
            self.memberships.insert(
                session_id,
                Membership {
                    role: MembershipRole::Receiver,
                    state: MembershipState::Offline,
                },
            );
        }
        self.commit(vec![event])
    }

    fn expire_join_request(
        &mut self,
        request_id: RequestId,
        now: EpochMillis,
    ) -> Result<RoomCommandOutcome, RoomError> {
        self.ensure_active(now)?;
        let session_id = {
            let request = self
                .join_requests
                .get_mut(&request_id)
                .ok_or(RoomError::RequestNotFound)?;
            if request.state != JoinRequestState::Pending {
                return Ok(self.unchanged());
            }
            if now < request.expires_at {
                return Err(RoomError::RequestExpiryNotReached);
            }
            request.state = JoinRequestState::Expired;
            request.session_id.clone()
        };
        self.commit(vec![RoomEvent::JoinExpired {
            request_id,
            session_id,
        }])
    }

    fn attach(
        &mut self,
        session_id: SessionId,
        peer_id: PeerId,
        now: EpochMillis,
    ) -> Result<RoomCommandOutcome, RoomError> {
        self.ensure_active(now)?;
        let membership = self
            .memberships
            .get_mut(&session_id)
            .ok_or(RoomError::MembershipNotFound)?;
        match &membership.state {
            MembershipState::Online { peer_id: current } if current == &peer_id => {
                return Ok(self.unchanged());
            }
            MembershipState::Left => return Err(RoomError::MembershipLeft),
            MembershipState::Offline | MembershipState::Online { .. } => {}
        }
        membership.state = MembershipState::Online {
            peer_id: peer_id.clone(),
        };
        self.commit(vec![RoomEvent::PeerOnline {
            session_id,
            peer_id,
        }])
    }

    fn detach(
        &mut self,
        session_id: SessionId,
        peer_id: PeerId,
    ) -> Result<RoomCommandOutcome, RoomError> {
        let membership = self
            .memberships
            .get_mut(&session_id)
            .ok_or(RoomError::MembershipNotFound)?;
        match &membership.state {
            MembershipState::Online { peer_id: current } if current == &peer_id => {
                membership.state = MembershipState::Offline;
            }
            MembershipState::Online { .. } | MembershipState::Offline => {
                return Ok(self.unchanged());
            }
            MembershipState::Left => return Err(RoomError::MembershipLeft),
        }
        self.commit(vec![RoomEvent::PeerOffline {
            session_id,
            peer_id,
        }])
    }

    fn leave(&mut self, session_id: SessionId) -> Result<RoomCommandOutcome, RoomError> {
        if session_id == self.owner {
            if self.state == RoomState::Expired {
                return Ok(self.unchanged());
            }
            self.state = RoomState::Expired;
            return self.commit(vec![RoomEvent::RoomExpired {
                reason: RoomExpiryReason::OwnerLeft,
            }]);
        }

        if let Some(membership) = self.memberships.get_mut(&session_id) {
            if membership.state == MembershipState::Left {
                return Ok(self.unchanged());
            }
            membership.state = MembershipState::Left;
            return self.commit(vec![RoomEvent::MemberLeft { session_id }]);
        }

        let pending = self.join_requests.iter_mut().find(|(_, request)| {
            request.session_id == session_id && request.state == JoinRequestState::Pending
        });
        if let Some((request_id, request)) = pending {
            request.state = JoinRequestState::Cancelled;
            let request_id = request_id.clone();
            return self.commit(vec![RoomEvent::JoinCancelled {
                request_id,
                session_id,
            }]);
        }
        Err(RoomError::MembershipNotFound)
    }

    fn expire(&mut self, now: EpochMillis) -> Result<RoomCommandOutcome, RoomError> {
        if self.state == RoomState::Expired {
            return Ok(self.unchanged());
        }
        if now < self.expires_at {
            return Err(RoomError::ExpiryNotReached);
        }
        self.state = RoomState::Expired;
        for request in self.join_requests.values_mut() {
            if request.state == JoinRequestState::Pending {
                request.state = JoinRequestState::Expired;
            }
        }
        self.commit(vec![RoomEvent::RoomExpired {
            reason: RoomExpiryReason::Deadline,
        }])
    }
}

#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
pub enum RoomError {
    #[error("room expiry must be in the future")]
    InvalidExpiry,
    #[error("room is inactive or past its deadline")]
    Inactive,
    #[error("join request expiry must be within the active room window")]
    InvalidRequestExpiry,
    #[error("request id was replayed with different arguments")]
    IdempotencyConflict,
    #[error("session is already a room member")]
    AlreadyMember,
    #[error("session already has a pending join request")]
    PendingRequestExists,
    #[error("only the room owner may decide a join request")]
    Unauthorized,
    #[error("join request does not exist")]
    RequestNotFound,
    #[error("join request has expired")]
    RequestExpired,
    #[error("join request expiry deadline has not been reached")]
    RequestExpiryNotReached,
    #[error("join request is terminal and cannot change decision")]
    TerminalRequest,
    #[error("room membership does not exist")]
    MembershipNotFound,
    #[error("room member has already left")]
    MembershipLeft,
    #[error("room expiry deadline has not been reached")]
    ExpiryNotReached,
    #[error("room revision overflow")]
    RevisionOverflow,
}

#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
pub enum RoomInvariantError {
    #[error("room revision must be positive")]
    ZeroRevision,
    #[error("owner membership is missing")]
    MissingOwner,
    #[error("owner membership is invalid")]
    InvalidOwner,
    #[error("non-owner membership has an invalid role")]
    InvalidReceiverRole,
    #[error("approved join request has no active receiver membership")]
    ApprovedRequestWithoutMembership,
}

#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum RoomRestoreError {
    #[error("stored room contains duplicate membership for {0}")]
    DuplicateMembership(SessionId),
    #[error("stored room contains duplicate join request {0}")]
    DuplicateJoinRequest(RequestId),
    #[error("stored join request {0} outlives its room")]
    RequestOutlivesRoom(RequestId),
    #[error("stored room violates domain invariants: {0}")]
    Invariant(#[from] RoomInvariantError),
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id<T>(value: &str) -> T
    where
        T: std::str::FromStr,
        T::Err: std::fmt::Debug,
    {
        value.parse().expect("valid id")
    }

    fn room() -> Room {
        Room::create(
            id("room_1"),
            id("ABC123"),
            id("owner_1"),
            EpochMillis::new(0),
            EpochMillis::new(1_000),
        )
        .expect("room")
        .0
    }

    fn request(receiver: &str, request: &str) -> RoomCommand {
        RoomCommand::RequestJoin {
            request_id: id(request),
            session_id: id(receiver),
            now: EpochMillis::new(10),
            expires_at: EpochMillis::new(900),
        }
    }

    fn approve(request: &str) -> RoomCommand {
        RoomCommand::DecideJoin {
            actor: id("owner_1"),
            request_id: id(request),
            decision: JoinDecision::Approve,
            now: EpochMillis::new(20),
        }
    }

    #[test]
    fn join_presence_and_stale_detach_follow_revision_rules() {
        let mut room = room();
        assert_eq!(room.revision().value(), 1);
        assert!(
            room.handle(request("receiver_1", "request_1"))
                .expect("request")
                .changed()
        );
        assert!(
            room.handle(approve("request_1"))
                .expect("approve")
                .changed()
        );
        assert!(
            room.handle(RoomCommand::Attach {
                session_id: id("receiver_1"),
                peer_id: id("peer_old"),
                now: EpochMillis::new(30),
            })
            .expect("attach old")
            .changed()
        );
        assert!(
            room.handle(RoomCommand::Attach {
                session_id: id("receiver_1"),
                peer_id: id("peer_new"),
                now: EpochMillis::new(31),
            })
            .expect("attach new")
            .changed()
        );

        let stale = room
            .handle(RoomCommand::Detach {
                session_id: id("receiver_1"),
                peer_id: id("peer_old"),
            })
            .expect("stale detach is ignored");
        assert!(!stale.changed());
        assert_eq!(
            room.membership_state(&id("receiver_1")),
            Some(&MembershipState::Online {
                peer_id: id("peer_new")
            })
        );
        assert_eq!(room.revision().value(), 5);
        room.verify_invariants().expect("room invariants");
    }

    #[test]
    fn persisted_snapshots_restore_the_same_room() {
        let mut original = room();
        original
            .handle(request("receiver_1", "request_1"))
            .expect("request");
        original.handle(approve("request_1")).expect("approve");
        original
            .handle(RoomCommand::Attach {
                session_id: id("receiver_1"),
                peer_id: id("peer_1"),
                now: EpochMillis::new(30),
            })
            .expect("attach");

        let restored = Room::restore(
            original.id().clone(),
            original.code().clone(),
            original.owner().clone(),
            original.expires_at(),
            original.state(),
            original.revision(),
            original.membership_snapshots(),
            original.join_request_snapshots(),
        )
        .expect("restore valid room");

        assert_eq!(restored, original);
        assert_eq!(restored.verify_invariants(), Ok(()));
    }

    #[test]
    fn request_and_matching_decision_replays_are_idempotent() {
        let mut room = room();
        let first = room
            .handle(request("receiver_1", "request_1"))
            .expect("request");
        let replay = room
            .handle(request("receiver_1", "request_1"))
            .expect("replay");
        assert!(first.changed());
        assert!(!replay.changed());
        let approved = room.handle(approve("request_1")).expect("approve");
        let approved_replay = room.handle(approve("request_1")).expect("approve replay");
        assert!(approved.changed());
        assert!(!approved_replay.changed());
    }

    #[test]
    fn terminal_join_decisions_cannot_be_reversed() {
        let mut room = room();
        room.handle(request("receiver_1", "request_1"))
            .expect("request");
        room.handle(approve("request_1")).expect("approve");
        assert_eq!(
            room.handle(RoomCommand::DecideJoin {
                actor: id("owner_1"),
                request_id: id("request_1"),
                decision: JoinDecision::Reject,
                now: EpochMillis::new(30),
            }),
            Err(RoomError::TerminalRequest)
        );
    }

    #[test]
    fn expiry_is_guarded_and_idempotent() {
        let mut room = room();
        assert_eq!(
            room.handle(RoomCommand::Expire {
                now: EpochMillis::new(999)
            }),
            Err(RoomError::ExpiryNotReached)
        );
        assert!(
            room.handle(RoomCommand::Expire {
                now: EpochMillis::new(1_000)
            })
            .expect("expire")
            .changed()
        );
        assert!(
            !room
                .handle(RoomCommand::Expire {
                    now: EpochMillis::new(2_000)
                })
                .expect("expiry replay")
                .changed()
        );
    }

    #[test]
    fn due_join_requests_expire_once_and_advance_room_revision() {
        let mut room = room();
        room.handle(request("receiver_1", "request_1"))
            .expect("request");
        assert_eq!(
            room.handle(RoomCommand::ExpireJoinRequest {
                request_id: id("request_1"),
                now: EpochMillis::new(899),
            }),
            Err(RoomError::RequestExpiryNotReached)
        );
        let expired = room
            .handle(RoomCommand::ExpireJoinRequest {
                request_id: id("request_1"),
                now: EpochMillis::new(900),
            })
            .expect("expire request");
        assert!(expired.changed());
        assert_eq!(expired.revision.value(), 3);
        let replay = room
            .handle(RoomCommand::ExpireJoinRequest {
                request_id: id("request_1"),
                now: EpochMillis::new(901),
            })
            .expect("expire replay");
        assert!(!replay.changed());
        assert_eq!(
            room.join_request_state(&id("request_1")),
            Some(JoinRequestState::Expired)
        );
    }

    #[test]
    fn generated_command_sequences_preserve_room_invariants() {
        for seed in 1_u64..=128 {
            let mut room = room();
            let mut value = seed;
            for step in 0..96_u64 {
                value = value
                    .wrapping_mul(6_364_136_223_846_793_005)
                    .wrapping_add(1);
                let receiver = format!("receiver_{}", value % 4);
                let request_id = format!("request_{}", value % 4);
                let peer_id = format!("peer_{}", (value >> 8) % 8);
                let command = match value % 6 {
                    0 => request(&receiver, &request_id),
                    1 => RoomCommand::DecideJoin {
                        actor: id("owner_1"),
                        request_id: id(&request_id),
                        decision: if value & 1 == 0 {
                            JoinDecision::Approve
                        } else {
                            JoinDecision::Reject
                        },
                        now: EpochMillis::new(20 + step),
                    },
                    2 => RoomCommand::Attach {
                        session_id: id(&receiver),
                        peer_id: id(&peer_id),
                        now: EpochMillis::new(20 + step),
                    },
                    3 => RoomCommand::Detach {
                        session_id: id(&receiver),
                        peer_id: id(&peer_id),
                    },
                    4 => RoomCommand::Leave {
                        session_id: id(&receiver),
                    },
                    _ => RoomCommand::Expire {
                        now: EpochMillis::new(20 + step),
                    },
                };
                let _ = room.handle(command);
                room.verify_invariants()
                    .expect("generated sequence invariant");
            }
        }
    }
}
