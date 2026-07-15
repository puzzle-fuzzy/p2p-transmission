use serde::{Deserialize, Serialize};

use crate::ProtocolError;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProtocolVersion {
    pub major: u16,
    pub minor: u16,
}

impl ProtocolVersion {
    pub const fn new(major: u16, minor: u16) -> Self {
        Self { major, minor }
    }

    pub fn validate(self) -> Result<(), ProtocolError> {
        if self.major != CURRENT_PROTOCOL.major || self.minor > CURRENT_PROTOCOL.minor {
            return Err(ProtocolError::UnsupportedVersion {
                major: self.major,
                minor: self.minor,
            });
        }
        Ok(())
    }
}

pub const CURRENT_PROTOCOL: ProtocolVersion = ProtocolVersion::new(2, 0);
