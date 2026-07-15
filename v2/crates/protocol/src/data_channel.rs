use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::{
    MAX_BUFFERED_TRANSFER_BYTES, MAX_CHUNK_BYTES, MAX_CONTROL_FRAME_BYTES, MAX_FILES_PER_MANIFEST,
    MAX_STREAM_ACK_WINDOW_BYTES, MAX_STREAM_SEGMENT_BYTES, MAX_TRANSFER_BYTES,
    MIN_STREAM_SEGMENT_BYTES, ProtocolError, ProtocolVersion, Validate,
    limits::{
        MAX_ERROR_MESSAGE_BYTES, MAX_FILE_NAME_BYTES, MAX_MIME_BYTES, validate_text, validate_token,
    },
};

pub const CHUNK_MAGIC: [u8; 4] = *b"P2P2";
pub const CHUNK_HEADER_LEN: usize = 53;
const DATA_FRAME_TYPE: u8 = 1;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct FileManifest {
    pub file_id: String,
    pub name: String,
    pub mime: Option<String>,
    pub size_bytes: u64,
}

impl Validate for FileManifest {
    fn validate(&self) -> Result<(), ProtocolError> {
        validate_token(&self.file_id, "file_id")?;
        validate_text(&self.name, "file_name", MAX_FILE_NAME_BYTES)?;
        if self
            .name
            .chars()
            .any(|character| matches!(character, '/' | '\\'))
        {
            return Err(ProtocolError::InvalidField { field: "file_name" });
        }
        if let Some(mime) = &self.mime {
            validate_text(mime, "mime", MAX_MIME_BYTES)?;
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TransferMode {
    Buffered,
    Streamed { segment_bytes: u32 },
}

impl TransferMode {
    const fn max_transfer_bytes(self) -> u64 {
        match self {
            Self::Buffered => MAX_BUFFERED_TRANSFER_BYTES,
            Self::Streamed { .. } => MAX_TRANSFER_BYTES,
        }
    }
}

impl Validate for TransferMode {
    fn validate(&self) -> Result<(), ProtocolError> {
        let Self::Streamed { segment_bytes } = self else {
            return Ok(());
        };
        if !(MIN_STREAM_SEGMENT_BYTES..=MAX_STREAM_SEGMENT_BYTES).contains(segment_bytes)
            || segment_bytes % MAX_CHUNK_BYTES != 0
        {
            return Err(ProtocolError::InvalidField {
                field: "segment_bytes",
            });
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ResumeCursor {
    pub file_id: String,
    pub committed_bytes: u64,
    pub last_segment_blake3: Option<String>,
}

impl Validate for ResumeCursor {
    fn validate(&self) -> Result<(), ProtocolError> {
        validate_token(&self.file_id, "file_id")?;
        if self.committed_bytes > MAX_TRANSFER_BYTES {
            return Err(ProtocolError::TransferTooLarge);
        }
        match (self.committed_bytes, &self.last_segment_blake3) {
            (0, None) => Ok(()),
            (0, Some(_)) | (_, None) => Err(ProtocolError::InvalidField {
                field: "last_segment_blake3",
            }),
            (_, Some(blake3)) => validate_blake3(blake3, "last_segment_blake3"),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct FileDigest {
    pub file_id: String,
    pub size_bytes: u64,
    pub blake3: String,
}

impl Validate for FileDigest {
    fn validate(&self) -> Result<(), ProtocolError> {
        validate_token(&self.file_id, "file_id")?;
        if self.size_bytes > MAX_TRANSFER_BYTES {
            return Err(ProtocolError::TransferTooLarge);
        }
        validate_blake3(&self.blake3, "blake3")
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CancelReason {
    SenderCancelled,
    ReceiverCancelled,
    Timeout,
    PeerClosed,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StreamPauseReason {
    DestinationQuotaExceeded,
    DestinationPermissionDenied,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ControlMessage {
    Manifest {
        version: ProtocolVersion,
        transfer_id: String,
        mode: TransferMode,
        files: Vec<FileManifest>,
    },
    Decision {
        version: ProtocolVersion,
        transfer_id: String,
        accepted: bool,
    },
    Start {
        version: ProtocolVersion,
        transfer_id: String,
    },
    StreamReady {
        version: ProtocolVersion,
        transfer_id: String,
        max_chunk_bytes: u32,
        ack_window_bytes: u64,
        resume: Vec<ResumeCursor>,
    },
    SegmentCommit {
        version: ProtocolVersion,
        transfer_id: String,
        file_id: String,
        segment_index: u64,
        offset: u64,
        bytes: u32,
        blake3: String,
    },
    SegmentAck {
        version: ProtocolVersion,
        transfer_id: String,
        file_id: String,
        segment_index: u64,
        committed_bytes: u64,
        blake3: String,
    },
    StreamPaused {
        version: ProtocolVersion,
        transfer_id: String,
        reason: StreamPauseReason,
    },
    Cancel {
        version: ProtocolVersion,
        transfer_id: String,
        reason: CancelReason,
    },
    Complete {
        version: ProtocolVersion,
        transfer_id: String,
        bytes: u64,
        blake3: String,
    },
    StreamComplete {
        version: ProtocolVersion,
        transfer_id: String,
        total_bytes: u64,
        files: Vec<FileDigest>,
    },
    Error {
        version: ProtocolVersion,
        transfer_id: String,
        code: String,
        message: String,
    },
}

impl ControlMessage {
    fn version(&self) -> ProtocolVersion {
        match self {
            Self::Manifest { version, .. }
            | Self::Decision { version, .. }
            | Self::Start { version, .. }
            | Self::StreamReady { version, .. }
            | Self::SegmentCommit { version, .. }
            | Self::SegmentAck { version, .. }
            | Self::StreamPaused { version, .. }
            | Self::Cancel { version, .. }
            | Self::Complete { version, .. }
            | Self::StreamComplete { version, .. }
            | Self::Error { version, .. } => *version,
        }
    }

    fn transfer_id(&self) -> &str {
        match self {
            Self::Manifest { transfer_id, .. }
            | Self::Decision { transfer_id, .. }
            | Self::Start { transfer_id, .. }
            | Self::StreamReady { transfer_id, .. }
            | Self::SegmentCommit { transfer_id, .. }
            | Self::SegmentAck { transfer_id, .. }
            | Self::StreamPaused { transfer_id, .. }
            | Self::Cancel { transfer_id, .. }
            | Self::Complete { transfer_id, .. }
            | Self::StreamComplete { transfer_id, .. }
            | Self::Error { transfer_id, .. } => transfer_id,
        }
    }
}

impl Validate for ControlMessage {
    fn validate(&self) -> Result<(), ProtocolError> {
        self.version().validate()?;
        validate_token(self.transfer_id(), "transfer_id")?;

        match self {
            Self::Manifest { mode, files, .. } => {
                mode.validate()?;
                if files.is_empty() || files.len() > MAX_FILES_PER_MANIFEST {
                    return Err(ProtocolError::InvalidFileCount);
                }
                let mut ids = BTreeSet::new();
                let mut total = 0_u64;
                for file in files {
                    file.validate()?;
                    if !ids.insert(&file.file_id) {
                        return Err(ProtocolError::DuplicateFileId);
                    }
                    total = total
                        .checked_add(file.size_bytes)
                        .ok_or(ProtocolError::TransferTooLarge)?;
                }
                if total > mode.max_transfer_bytes() {
                    return Err(ProtocolError::TransferTooLarge);
                }
                Ok(())
            }
            Self::Complete { bytes, blake3, .. } => {
                if *bytes > MAX_BUFFERED_TRANSFER_BYTES {
                    return Err(ProtocolError::TransferTooLarge);
                }
                validate_blake3(blake3, "blake3")
            }
            Self::StreamReady {
                max_chunk_bytes,
                ack_window_bytes,
                resume,
                ..
            } => {
                if *max_chunk_bytes == 0 || *max_chunk_bytes > MAX_CHUNK_BYTES {
                    return Err(ProtocolError::InvalidField {
                        field: "max_chunk_bytes",
                    });
                }
                if *ack_window_bytes < u64::from(*max_chunk_bytes)
                    || *ack_window_bytes > MAX_STREAM_ACK_WINDOW_BYTES
                {
                    return Err(ProtocolError::InvalidField {
                        field: "ack_window_bytes",
                    });
                }
                validate_unique_files(resume, |cursor| &cursor.file_id, Validate::validate)
                    .map(|_| ())
            }
            Self::SegmentCommit {
                file_id,
                offset,
                bytes,
                blake3,
                ..
            } => {
                validate_token(file_id, "file_id")?;
                if *bytes == 0 || *bytes > MAX_STREAM_SEGMENT_BYTES {
                    return Err(ProtocolError::InvalidField {
                        field: "segment_bytes",
                    });
                }
                let end = offset
                    .checked_add(u64::from(*bytes))
                    .ok_or(ProtocolError::OffsetOverflow)?;
                if end > MAX_TRANSFER_BYTES {
                    return Err(ProtocolError::TransferTooLarge);
                }
                validate_blake3(blake3, "blake3")
            }
            Self::SegmentAck {
                file_id,
                committed_bytes,
                blake3,
                ..
            } => {
                validate_token(file_id, "file_id")?;
                if *committed_bytes == 0 || *committed_bytes > MAX_TRANSFER_BYTES {
                    return Err(ProtocolError::InvalidField {
                        field: "committed_bytes",
                    });
                }
                validate_blake3(blake3, "blake3")
            }
            Self::StreamComplete {
                total_bytes, files, ..
            } => {
                if files.is_empty() {
                    return Err(ProtocolError::InvalidFileCount);
                }
                let actual_total =
                    validate_unique_files(files, |digest| &digest.file_id, FileDigest::validate)?;
                if actual_total != *total_bytes || *total_bytes > MAX_TRANSFER_BYTES {
                    return Err(ProtocolError::InvalidField {
                        field: "total_bytes",
                    });
                }
                Ok(())
            }
            Self::Error { code, message, .. } => {
                validate_token(code, "error_code")?;
                validate_text(message, "error_message", MAX_ERROR_MESSAGE_BYTES)
            }
            Self::Decision { .. }
            | Self::Start { .. }
            | Self::StreamPaused { .. }
            | Self::Cancel { .. } => Ok(()),
        }
    }
}

fn validate_blake3(value: &str, field: &'static str) -> Result<(), ProtocolError> {
    if value.len() != 64 || !value.chars().all(|character| character.is_ascii_hexdigit()) {
        return Err(ProtocolError::InvalidField { field });
    }
    Ok(())
}

fn validate_unique_files<T>(
    files: &[T],
    file_id: impl Fn(&T) -> &String,
    validate: impl Fn(&T) -> Result<(), ProtocolError>,
) -> Result<u64, ProtocolError>
where
    T: FileSize,
{
    if files.len() > MAX_FILES_PER_MANIFEST {
        return Err(ProtocolError::InvalidFileCount);
    }
    let mut ids = BTreeSet::new();
    let mut total = 0_u64;
    for file in files {
        validate(file)?;
        if !ids.insert(file_id(file)) {
            return Err(ProtocolError::DuplicateFileId);
        }
        total = total
            .checked_add(file.file_size())
            .ok_or(ProtocolError::TransferTooLarge)?;
    }
    Ok(total)
}

trait FileSize {
    fn file_size(&self) -> u64;
}

impl FileSize for ResumeCursor {
    fn file_size(&self) -> u64 {
        0
    }
}

impl FileSize for FileDigest {
    fn file_size(&self) -> u64 {
        self.size_bytes
    }
}

pub fn parse_control_message(input: &str) -> Result<ControlMessage, ProtocolError> {
    if input.len() > MAX_CONTROL_FRAME_BYTES {
        return Err(ProtocolError::FrameTooLarge {
            actual: input.len(),
            max: MAX_CONTROL_FRAME_BYTES,
        });
    }
    let message = serde_json::from_str::<ControlMessage>(input)
        .map_err(|error| ProtocolError::InvalidJson(error.to_string()))?;
    message.validate()?;
    Ok(message)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BinaryChunkHeader {
    pub version: ProtocolVersion,
    pub transfer_id: [u8; 16],
    pub file_id: [u8; 16],
    pub offset: u64,
    pub payload_len: u32,
}

impl BinaryChunkHeader {
    pub fn encode(self) -> [u8; CHUNK_HEADER_LEN] {
        let mut bytes = [0_u8; CHUNK_HEADER_LEN];
        bytes[0..4].copy_from_slice(&CHUNK_MAGIC);
        bytes[4..6].copy_from_slice(&self.version.major.to_be_bytes());
        bytes[6..8].copy_from_slice(&self.version.minor.to_be_bytes());
        bytes[8] = DATA_FRAME_TYPE;
        bytes[9..25].copy_from_slice(&self.transfer_id);
        bytes[25..41].copy_from_slice(&self.file_id);
        bytes[41..49].copy_from_slice(&self.offset.to_be_bytes());
        bytes[49..53].copy_from_slice(&self.payload_len.to_be_bytes());
        bytes
    }
}

pub fn decode_binary_frame(frame: &[u8]) -> Result<(BinaryChunkHeader, &[u8]), ProtocolError> {
    if frame.len() < CHUNK_HEADER_LEN {
        return Err(ProtocolError::BinaryFrameTooShort);
    }
    if frame[0..4] != CHUNK_MAGIC {
        return Err(ProtocolError::InvalidMagic);
    }
    let major = u16::from_be_bytes([frame[4], frame[5]]);
    let minor = u16::from_be_bytes([frame[6], frame[7]]);
    let version = ProtocolVersion::new(major, minor);
    version.validate()?;
    if frame[8] != DATA_FRAME_TYPE {
        return Err(ProtocolError::UnsupportedFrameType(frame[8]));
    }

    let mut transfer_id = [0_u8; 16];
    transfer_id.copy_from_slice(&frame[9..25]);
    let mut file_id = [0_u8; 16];
    file_id.copy_from_slice(&frame[25..41]);
    let offset = u64::from_be_bytes(
        frame[41..49]
            .try_into()
            .map_err(|_| ProtocolError::BinaryFrameTooShort)?,
    );
    let payload_len = u32::from_be_bytes(
        frame[49..53]
            .try_into()
            .map_err(|_| ProtocolError::BinaryFrameTooShort)?,
    );
    if payload_len > MAX_CHUNK_BYTES {
        return Err(ProtocolError::ChunkTooLarge);
    }
    offset
        .checked_add(u64::from(payload_len))
        .ok_or(ProtocolError::OffsetOverflow)?;
    let expected = CHUNK_HEADER_LEN
        .checked_add(payload_len as usize)
        .ok_or(ProtocolError::BinaryLengthMismatch)?;
    if frame.len() != expected {
        return Err(ProtocolError::BinaryLengthMismatch);
    }

    Ok((
        BinaryChunkHeader {
            version,
            transfer_id,
            file_id,
            offset,
            payload_len,
        },
        &frame[CHUNK_HEADER_LEN..],
    ))
}

#[cfg(test)]
mod tests {
    use crate::CURRENT_PROTOCOL;

    use super::*;

    const VALID_BLAKE3: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn manifest_file(file_id: &str, size_bytes: u64) -> FileManifest {
        FileManifest {
            file_id: file_id.to_owned(),
            name: format!("{file_id}.bin"),
            mime: Some("application/octet-stream".to_owned()),
            size_bytes,
        }
    }

    #[test]
    fn manifest_control_frame_has_a_golden_fixture() {
        let message = ControlMessage::Manifest {
            version: CURRENT_PROTOCOL,
            transfer_id: "transfer_1".to_owned(),
            mode: TransferMode::Buffered,
            files: vec![FileManifest {
                file_id: "file_1".to_owned(),
                name: "hello.txt".to_owned(),
                mime: Some("text/plain".to_owned()),
                size_bytes: 5,
            }],
        };
        let json = serde_json::to_string(&message).expect("serialize manifest");
        assert_eq!(
            json,
            include_str!("../tests/fixtures/manifest-v2.json").trim()
        );
        assert_eq!(parse_control_message(&json), Ok(message));
    }

    #[test]
    fn binary_chunk_round_trips_and_checks_exact_payload_length() {
        let header = BinaryChunkHeader {
            version: CURRENT_PROTOCOL,
            transfer_id: [1; 16],
            file_id: [2; 16],
            offset: 64,
            payload_len: 3,
        };
        let mut frame = header.encode().to_vec();
        frame.extend_from_slice(b"abc");
        let (decoded, payload) = decode_binary_frame(&frame).expect("decode binary frame");
        assert_eq!(decoded, header);
        assert_eq!(payload, b"abc");
        frame.push(0);
        assert_eq!(
            decode_binary_frame(&frame),
            Err(ProtocolError::BinaryLengthMismatch)
        );
    }

    #[test]
    fn manifest_limits_are_enforced() {
        let duplicate = ControlMessage::Manifest {
            version: CURRENT_PROTOCOL,
            transfer_id: "transfer_1".to_owned(),
            mode: TransferMode::Buffered,
            files: vec![
                FileManifest {
                    file_id: "file_1".to_owned(),
                    name: "a.txt".to_owned(),
                    mime: None,
                    size_bytes: 1,
                },
                FileManifest {
                    file_id: "file_1".to_owned(),
                    name: "b.txt".to_owned(),
                    mime: None,
                    size_bytes: 1,
                },
            ],
        };
        assert_eq!(duplicate.validate(), Err(ProtocolError::DuplicateFileId));
    }

    #[test]
    fn streamed_batch_accepts_ten_files_and_rejects_an_eleventh() {
        let files = (0..MAX_FILES_PER_MANIFEST)
            .map(|index| manifest_file(&format!("file_{index}"), 1))
            .collect::<Vec<_>>();
        let valid = ControlMessage::Manifest {
            version: CURRENT_PROTOCOL,
            transfer_id: "transfer_batch".to_owned(),
            mode: TransferMode::Streamed {
                segment_bytes: 8 * 1024 * 1024,
            },
            files: files.clone(),
        };
        assert_eq!(valid.validate(), Ok(()));

        let mut too_many = files;
        too_many.push(manifest_file("file_overflow", 1));
        let invalid = ControlMessage::Manifest {
            version: CURRENT_PROTOCOL,
            transfer_id: "transfer_batch".to_owned(),
            mode: TransferMode::Streamed {
                segment_bytes: 8 * 1024 * 1024,
            },
            files: too_many,
        };
        assert_eq!(invalid.validate(), Err(ProtocolError::InvalidFileCount));
    }

    #[test]
    fn streamed_manifest_accepts_five_gib_but_buffered_mode_stays_bounded() {
        let streamed = ControlMessage::Manifest {
            version: CURRENT_PROTOCOL,
            transfer_id: "transfer_large".to_owned(),
            mode: TransferMode::Streamed {
                segment_bytes: 8 * 1024 * 1024,
            },
            files: vec![manifest_file("file_large", MAX_TRANSFER_BYTES)],
        };
        assert_eq!(streamed.validate(), Ok(()));

        let buffered = ControlMessage::Manifest {
            version: CURRENT_PROTOCOL,
            transfer_id: "transfer_buffered".to_owned(),
            mode: TransferMode::Buffered,
            files: vec![manifest_file(
                "file_buffered",
                MAX_BUFFERED_TRANSFER_BYTES + 1,
            )],
        };
        assert_eq!(buffered.validate(), Err(ProtocolError::TransferTooLarge));

        let too_large = ControlMessage::Manifest {
            version: CURRENT_PROTOCOL,
            transfer_id: "transfer_too_large".to_owned(),
            mode: TransferMode::Streamed {
                segment_bytes: 8 * 1024 * 1024,
            },
            files: vec![manifest_file("file_too_large", MAX_TRANSFER_BYTES + 1)],
        };
        assert_eq!(too_large.validate(), Err(ProtocolError::TransferTooLarge));
    }

    #[test]
    fn streamed_manifest_rejects_unaligned_segment_sizes() {
        let message = ControlMessage::Manifest {
            version: CURRENT_PROTOCOL,
            transfer_id: "transfer_large".to_owned(),
            mode: TransferMode::Streamed {
                segment_bytes: MIN_STREAM_SEGMENT_BYTES + 1,
            },
            files: vec![manifest_file("file_large", 1)],
        };
        assert_eq!(
            message.validate(),
            Err(ProtocolError::InvalidField {
                field: "segment_bytes"
            })
        );
    }

    #[test]
    fn stream_ready_requires_a_bounded_window_and_consistent_resume_cursor() {
        let ready = ControlMessage::StreamReady {
            version: CURRENT_PROTOCOL,
            transfer_id: "transfer_large".to_owned(),
            max_chunk_bytes: 32 * 1024,
            ack_window_bytes: 16 * 1024 * 1024,
            resume: vec![ResumeCursor {
                file_id: "file_large".to_owned(),
                committed_bytes: 8 * 1024 * 1024,
                last_segment_blake3: Some(VALID_BLAKE3.to_owned()),
            }],
        };
        assert_eq!(ready.validate(), Ok(()));

        let invalid_cursor = ControlMessage::StreamReady {
            version: CURRENT_PROTOCOL,
            transfer_id: "transfer_large".to_owned(),
            max_chunk_bytes: 32 * 1024,
            ack_window_bytes: 16 * 1024 * 1024,
            resume: vec![ResumeCursor {
                file_id: "file_large".to_owned(),
                committed_bytes: 1,
                last_segment_blake3: None,
            }],
        };
        assert_eq!(
            invalid_cursor.validate(),
            Err(ProtocolError::InvalidField {
                field: "last_segment_blake3"
            })
        );
    }

    #[test]
    fn stream_pause_uses_stable_recoverable_reason_codes() {
        let paused = ControlMessage::StreamPaused {
            version: CURRENT_PROTOCOL,
            transfer_id: "transfer_pause".to_owned(),
            reason: StreamPauseReason::DestinationQuotaExceeded,
        };
        paused.validate().expect("stream pause should validate");

        let encoded = serde_json::to_string(&paused).expect("stream pause should encode");
        assert!(encoded.contains(r#""type":"stream_paused""#));
        assert!(encoded.contains(r#""reason":"destination_quota_exceeded""#));
        assert_eq!(
            parse_control_message(&encoded).expect("stream pause should decode"),
            paused
        );

        let permission = ControlMessage::StreamPaused {
            version: CURRENT_PROTOCOL,
            transfer_id: "transfer_pause".to_owned(),
            reason: StreamPauseReason::DestinationPermissionDenied,
        };
        permission
            .validate()
            .expect("permission pause should validate");
    }

    #[test]
    fn segment_commit_and_ack_frames_validate_checkpoint_bounds() {
        let commit = ControlMessage::SegmentCommit {
            version: CURRENT_PROTOCOL,
            transfer_id: "transfer_large".to_owned(),
            file_id: "file_large".to_owned(),
            segment_index: 0,
            offset: 0,
            bytes: 8 * 1024 * 1024,
            blake3: VALID_BLAKE3.to_owned(),
        };
        assert_eq!(commit.validate(), Ok(()));

        let ack = ControlMessage::SegmentAck {
            version: CURRENT_PROTOCOL,
            transfer_id: "transfer_large".to_owned(),
            file_id: "file_large".to_owned(),
            segment_index: 0,
            committed_bytes: 8 * 1024 * 1024,
            blake3: VALID_BLAKE3.to_owned(),
        };
        assert_eq!(ack.validate(), Ok(()));

        let empty_commit = ControlMessage::SegmentCommit {
            version: CURRENT_PROTOCOL,
            transfer_id: "transfer_large".to_owned(),
            file_id: "file_large".to_owned(),
            segment_index: 0,
            offset: 0,
            bytes: 0,
            blake3: VALID_BLAKE3.to_owned(),
        };
        assert_eq!(
            empty_commit.validate(),
            Err(ProtocolError::InvalidField {
                field: "segment_bytes"
            })
        );
    }

    #[test]
    fn stream_complete_requires_exact_per_file_total() {
        let complete = ControlMessage::StreamComplete {
            version: CURRENT_PROTOCOL,
            transfer_id: "transfer_large".to_owned(),
            total_bytes: MAX_TRANSFER_BYTES,
            files: vec![FileDigest {
                file_id: "file_large".to_owned(),
                size_bytes: MAX_TRANSFER_BYTES,
                blake3: VALID_BLAKE3.to_owned(),
            }],
        };
        let json = serde_json::to_string(&complete).expect("serialize stream completion");
        assert_eq!(parse_control_message(&json), Ok(complete));

        let wrong_total = ControlMessage::StreamComplete {
            version: CURRENT_PROTOCOL,
            transfer_id: "transfer_large".to_owned(),
            total_bytes: 1,
            files: vec![FileDigest {
                file_id: "file_large".to_owned(),
                size_bytes: 2,
                blake3: VALID_BLAKE3.to_owned(),
            }],
        };
        assert_eq!(
            wrong_total.validate(),
            Err(ProtocolError::InvalidField {
                field: "total_bytes"
            })
        );
    }

    #[test]
    fn arbitrary_binary_inputs_never_panic() {
        let mut value = 7_u64;
        for _ in 0..16_384 {
            value = value
                .wrapping_mul(2_862_933_555_777_941_757)
                .wrapping_add(3_037_000_493);
            let length = (value as usize) % 160;
            let mut bytes = vec![0_u8; length];
            for (index, byte) in bytes.iter_mut().enumerate() {
                *byte = value.rotate_left((index % 63) as u32) as u8;
            }
            let _ = decode_binary_frame(&bytes);
        }
    }
}
