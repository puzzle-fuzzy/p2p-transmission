#![forbid(unsafe_code)]

pub mod ids;
pub mod room;
pub mod session;
pub mod time;

pub const PRODUCT_NAME: &str = "P2P Transmission";

pub use ids::{PeerId, RequestId, RoomCode, RoomId, SessionId};
pub use room::{
    JoinDecision, JoinRequestState, MembershipRole, MembershipState, Room, RoomCommand,
    RoomCommandOutcome, RoomError, RoomInvariantError, RoomJoinRequestSnapshot,
    RoomMembershipSnapshot, RoomRestoreError, RoomState,
};
pub use session::{DisplayName, Session, SessionError, SessionState};
pub use time::{DurationMillis, EpochMillis, Revision};
