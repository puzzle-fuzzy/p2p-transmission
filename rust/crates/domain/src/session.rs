use thiserror::Error;

use crate::{EpochMillis, SessionId};

pub const MAX_DISPLAY_NAME_CHARS: usize = 48;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DisplayName(String);

impl DisplayName {
    pub fn parse(value: impl AsRef<str>) -> Result<Self, DisplayNameError> {
        let value = value.as_ref().trim();
        let length = value.chars().count();
        if length == 0 || length > MAX_DISPLAY_NAME_CHARS {
            return Err(DisplayNameError::InvalidLength);
        }
        if value.chars().any(char::is_control) {
            return Err(DisplayNameError::ControlCharacter);
        }
        Ok(Self(value.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
pub enum DisplayNameError {
    #[error("display name must contain between 1 and 48 characters")]
    InvalidLength,
    #[error("display name must not contain control characters")]
    ControlCharacter,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SessionState {
    Active,
    Expired,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Session {
    id: SessionId,
    display_name: DisplayName,
    expires_at: EpochMillis,
    state: SessionState,
}

impl Session {
    pub fn create(
        id: SessionId,
        display_name: DisplayName,
        now: EpochMillis,
        expires_at: EpochMillis,
    ) -> Result<Self, SessionError> {
        if expires_at <= now {
            return Err(SessionError::InvalidExpiry);
        }
        Ok(Self {
            id,
            display_name,
            expires_at,
            state: SessionState::Active,
        })
    }

    pub fn restore(
        id: SessionId,
        display_name: DisplayName,
        expires_at: EpochMillis,
        state: SessionState,
    ) -> Self {
        Self {
            id,
            display_name,
            expires_at,
            state,
        }
    }

    pub fn id(&self) -> &SessionId {
        &self.id
    }

    pub fn display_name(&self) -> &DisplayName {
        &self.display_name
    }

    pub const fn expires_at(&self) -> EpochMillis {
        self.expires_at
    }

    pub const fn state(&self) -> SessionState {
        self.state
    }

    pub fn expire(&mut self, now: EpochMillis) -> Result<bool, SessionError> {
        if self.state == SessionState::Expired {
            return Ok(false);
        }
        if now < self.expires_at {
            return Err(SessionError::ExpiryNotReached);
        }
        self.state = SessionState::Expired;
        Ok(true)
    }

    pub fn ensure_active(&self, now: EpochMillis) -> Result<(), SessionError> {
        if self.state == SessionState::Expired || now >= self.expires_at {
            return Err(SessionError::Expired);
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
pub enum SessionError {
    #[error("session expiry must be in the future")]
    InvalidExpiry,
    #[error("session expiry has not been reached")]
    ExpiryNotReached,
    #[error("session has expired")]
    Expired,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session() -> Session {
        Session::create(
            SessionId::parse("session_1").expect("id"),
            DisplayName::parse(" Alice ").expect("display name"),
            EpochMillis::new(10),
            EpochMillis::new(20),
        )
        .expect("session")
    }

    #[test]
    fn session_expiry_is_idempotent_and_time_guarded() {
        let mut session = session();
        assert_eq!(
            session.expire(EpochMillis::new(19)),
            Err(SessionError::ExpiryNotReached)
        );
        assert_eq!(session.expire(EpochMillis::new(20)), Ok(true));
        assert_eq!(session.expire(EpochMillis::new(21)), Ok(false));
    }
}
