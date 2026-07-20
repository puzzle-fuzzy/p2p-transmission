use serde::{Deserialize, Serialize};

use crate::ProtocolError;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProtocolVersion {
    pub major: u16,
    pub minor: u16,
}

impl ProtocolVersion {
    pub const fn new(major: u16, minor: u16) -> Self {
        Self { major, minor }
    }

    pub fn validate(self) -> Result<(), ProtocolError> {
        if self != CURRENT_PROTOCOL {
            return Err(ProtocolError::UnsupportedVersion {
                major: self.major,
                minor: self.minor,
            });
        }
        Ok(())
    }
}

macro_rules! protocol_identity {
    ($major:literal, $minor:literal) => {
        pub const CURRENT_PROTOCOL: ProtocolVersion = ProtocolVersion::new($major, $minor);
        pub const PROTOCOL_VERSION_TEXT: &str =
            concat!(stringify!($major), ".", stringify!($minor));
        pub const SESSION_COOKIE_NAME: &str = concat!("p2p_session_v", stringify!($major));
        pub const ROOM_SESSION_STORAGE_KEY: &str =
            concat!("p2p_room_session_v", stringify!($major));
    };
}

// Keep wire, cookie and browser-storage identities derived from one declaration.
protocol_identity!(5, 1);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_exact_current_protocol_is_supported() {
        assert_eq!(CURRENT_PROTOCOL.validate(), Ok(()));
        for unsupported in [
            ProtocolVersion::new(4, 0),
            ProtocolVersion::new(5, 0),
            ProtocolVersion::new(6, 0),
        ] {
            assert_eq!(
                unsupported.validate(),
                Err(ProtocolError::UnsupportedVersion {
                    major: unsupported.major,
                    minor: unsupported.minor,
                })
            );
        }
    }

    #[test]
    fn protocol_version_rejects_unknown_fields() {
        let json = r#"{"major":5,"minor":1,"patch":1}"#;
        assert!(serde_json::from_str::<ProtocolVersion>(json).is_err());
    }

    #[test]
    fn protocol_identity_drives_persistent_client_keys() {
        assert_eq!(PROTOCOL_VERSION_TEXT, "5.1");
        assert_eq!(SESSION_COOKIE_NAME, "p2p_session_v5");
        assert_eq!(ROOM_SESSION_STORAGE_KEY, "p2p_room_session_v5");
    }
}
