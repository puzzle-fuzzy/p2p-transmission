use std::{fmt, str::FromStr};

use thiserror::Error;

const MAX_ID_BYTES: usize = 64;

#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
pub enum IdError {
    #[error("{kind} must not be empty")]
    Empty { kind: &'static str },
    #[error("{kind} must not exceed {MAX_ID_BYTES} bytes")]
    TooLong { kind: &'static str },
    #[error("{kind} contains unsupported character {character:?}")]
    InvalidCharacter { kind: &'static str, character: char },
}

fn validate_id(value: &str, kind: &'static str) -> Result<(), IdError> {
    if value.is_empty() {
        return Err(IdError::Empty { kind });
    }
    if value.len() > MAX_ID_BYTES {
        return Err(IdError::TooLong { kind });
    }
    if let Some(character) = value
        .chars()
        .find(|character| !character.is_ascii_alphanumeric() && !matches!(character, '_' | '-'))
    {
        return Err(IdError::InvalidCharacter { kind, character });
    }
    Ok(())
}

macro_rules! id_type {
    ($name:ident, $kind:literal) => {
        #[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
        pub struct $name(String);

        impl $name {
            pub fn parse(value: impl Into<String>) -> Result<Self, IdError> {
                let value = value.into();
                validate_id(&value, $kind)?;
                Ok(Self(value))
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str(&self.0)
            }
        }

        impl FromStr for $name {
            type Err = IdError;

            fn from_str(value: &str) -> Result<Self, Self::Err> {
                Self::parse(value)
            }
        }
    };
}

id_type!(SessionId, "session id");
id_type!(RoomId, "room id");
id_type!(PeerId, "peer id");
id_type!(RequestId, "request id");
id_type!(TransferId, "transfer id");
id_type!(FileId, "file id");

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct RoomCode(String);

impl RoomCode {
    pub const LENGTH: usize = 6;

    pub fn parse(value: impl AsRef<str>) -> Result<Self, RoomCodeError> {
        let value = value.as_ref().trim().to_ascii_uppercase();
        if value.len() != Self::LENGTH {
            return Err(RoomCodeError::InvalidLength);
        }
        if let Some(character) = value
            .chars()
            .find(|character| !character.is_ascii_alphanumeric())
        {
            return Err(RoomCodeError::InvalidCharacter(character));
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for RoomCode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl FromStr for RoomCode {
    type Err = RoomCodeError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::parse(value)
    }
}

#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
pub enum RoomCodeError {
    #[error("room code must contain exactly 6 ASCII characters")]
    InvalidLength,
    #[error("room code contains unsupported character {0:?}")]
    InvalidCharacter(char),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifiers_reject_whitespace_and_path_characters() {
        assert!(SessionId::parse("session 1").is_err());
        assert!(FileId::parse("../file").is_err());
        assert!(PeerId::parse("peer_1").is_ok());
    }

    #[test]
    fn room_codes_are_normalized_to_uppercase() {
        let code = RoomCode::parse(" ab12cd ").expect("valid room code");
        assert_eq!(code.as_str(), "AB12CD");
    }
}
