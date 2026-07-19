use thiserror::Error;

pub const MAX_JSON_FRAME_BYTES: usize = 64 * 1024;
pub const MAX_CONTROL_FRAME_BYTES: usize = 64 * 1024;
pub const MAX_HTTP_BODY_BYTES: usize = 64 * 1024;
pub const MAX_SIGNAL_BYTES: usize = 32 * 1024;
pub const MAX_FILES_PER_MANIFEST: usize = 10;
pub const MAX_BUFFERED_TRANSFER_BYTES: u64 = 100 * 1024 * 1024;
pub const MAX_TRANSFER_BYTES: u64 = 5 * 1024 * 1024 * 1024;
pub const MIN_STREAM_SEGMENT_BYTES: u32 = 1024 * 1024;
pub const MAX_STREAM_SEGMENT_BYTES: u32 = 16 * 1024 * 1024;
pub const MAX_STREAM_ACK_WINDOW_BYTES: u64 = 64 * 1024 * 1024;
pub const MAX_CHUNK_BYTES: u32 = 64 * 1024;
pub const MAX_DISPLAY_NAME_CHARS: usize = 48;
pub const MAX_TEXT_TRANSFER_CHARS: usize = 500;
pub const MAX_TEXT_TRANSFER_BYTES: usize = 4 * 1024;
pub(crate) const MAX_ID_BYTES: usize = 64;
pub(crate) const MAX_FILE_NAME_BYTES: usize = 1024;
pub(crate) const MAX_MIME_BYTES: usize = 128;
pub(crate) const MAX_ERROR_MESSAGE_BYTES: usize = 512;

pub trait Validate {
    fn validate(&self) -> Result<(), ProtocolError>;
}

pub(crate) fn validate_token(value: &str, field: &'static str) -> Result<(), ProtocolError> {
    validate_text(value, field, MAX_ID_BYTES)?;
    if value
        .chars()
        .any(|character| !character.is_ascii_alphanumeric() && !matches!(character, '_' | '-'))
    {
        return Err(ProtocolError::InvalidField { field });
    }
    Ok(())
}

pub(crate) fn validate_room_code(value: &str) -> Result<(), ProtocolError> {
    if value.len() != 6
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric())
    {
        return Err(ProtocolError::InvalidField { field: "room_code" });
    }
    Ok(())
}

pub(crate) fn validate_display_name(value: &str) -> Result<(), ProtocolError> {
    let value = value.trim();
    if value.is_empty() {
        return Err(ProtocolError::EmptyField {
            field: "display_name",
        });
    }
    if value.chars().count() > MAX_DISPLAY_NAME_CHARS {
        return Err(ProtocolError::InvalidField {
            field: "display_name",
        });
    }
    if value.chars().any(char::is_control) {
        return Err(ProtocolError::InvalidField {
            field: "display_name",
        });
    }
    Ok(())
}

pub(crate) fn validate_text(
    value: &str,
    field: &'static str,
    max_bytes: usize,
) -> Result<(), ProtocolError> {
    if value.is_empty() {
        return Err(ProtocolError::EmptyField { field });
    }
    if value.len() > max_bytes {
        return Err(ProtocolError::FieldTooLong {
            field,
            actual: value.len(),
            max: max_bytes,
        });
    }
    if value.chars().any(char::is_control) {
        return Err(ProtocolError::InvalidField { field });
    }
    Ok(())
}

pub(crate) fn validate_multiline_text(
    value: &str,
    field: &'static str,
    max_bytes: usize,
) -> Result<(), ProtocolError> {
    if value.is_empty() {
        return Err(ProtocolError::EmptyField { field });
    }
    if value.len() > max_bytes {
        return Err(ProtocolError::FieldTooLong {
            field,
            actual: value.len(),
            max: max_bytes,
        });
    }
    if value
        .chars()
        .any(|character| character.is_control() && !matches!(character, '\r' | '\n' | '\t'))
    {
        return Err(ProtocolError::InvalidField { field });
    }
    Ok(())
}

#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum ProtocolError {
    #[error("frame contains {actual} bytes, maximum is {max}")]
    FrameTooLarge { actual: usize, max: usize },
    #[error("protocol version {major}.{minor} is unsupported")]
    UnsupportedVersion { major: u16, minor: u16 },
    #[error("field {field} must not be empty")]
    EmptyField { field: &'static str },
    #[error("field {field} contains {actual} bytes, maximum is {max}")]
    FieldTooLong {
        field: &'static str,
        actual: usize,
        max: usize,
    },
    #[error("field {field} has an invalid value")]
    InvalidField { field: &'static str },
    #[error("JSON frame is invalid: {0}")]
    InvalidJson(String),
    #[error("manifest file count is outside the supported range")]
    InvalidFileCount,
    #[error("manifest contains duplicate file ids")]
    DuplicateFileId,
    #[error("manifest total exceeds the transfer byte limit")]
    TransferTooLarge,
    #[error("binary frame is shorter than the fixed header")]
    BinaryFrameTooShort,
    #[error("binary frame magic is invalid")]
    InvalidMagic,
    #[error("binary frame type {0} is unsupported")]
    UnsupportedFrameType(u8),
    #[error("chunk payload exceeds the message limit")]
    ChunkTooLarge,
    #[error("binary frame length does not match its header")]
    BinaryLengthMismatch,
    #[error("chunk offset plus payload length overflows")]
    OffsetOverflow,
}
