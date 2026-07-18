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

pub const CURRENT_PROTOCOL: ProtocolVersion = ProtocolVersion::new(5, 0);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_exact_current_protocol_is_supported() {
        assert_eq!(CURRENT_PROTOCOL.validate(), Ok(()));
        for unsupported in [
            ProtocolVersion::new(4, 0),
            ProtocolVersion::new(5, 1),
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
        let json = r#"{"major":5,"minor":0,"patch":1}"#;
        assert!(serde_json::from_str::<ProtocolVersion>(json).is_err());
    }
}
