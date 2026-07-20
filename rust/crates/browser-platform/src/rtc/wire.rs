use p2p_protocol::{
    BinaryChunkHeader, CURRENT_PROTOCOL, ControlMessage, ProtocolError, Validate,
    decode_binary_frame,
};

#[derive(Debug)]
pub(super) enum ControlFrameEncodeError {
    Protocol(ProtocolError),
    Serialize(serde_json::Error),
}

impl std::fmt::Display for ControlFrameEncodeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Protocol(error) => error.fmt(formatter),
            Self::Serialize(error) => error.fmt(formatter),
        }
    }
}

pub(super) struct BinaryChunk<'a> {
    pub(super) header: BinaryChunkHeader,
    pub(super) payload: &'a [u8],
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct ChunkBounds {
    transfer_id: [u8; 16],
    file_id: [u8; 16],
    offset: u64,
    upper_bound: u64,
}

impl ChunkBounds {
    pub(super) fn new(
        transfer_id: [u8; 16],
        file_id: [u8; 16],
        offset: u64,
        upper_bound: u64,
    ) -> Self {
        Self {
            transfer_id,
            file_id,
            offset,
            upper_bound,
        }
    }

    pub(super) fn next_offset(self, header: &BinaryChunkHeader, payload_len: usize) -> Option<u64> {
        if header.transfer_id != self.transfer_id
            || header.file_id != self.file_id
            || header.offset != self.offset
            || usize::try_from(header.payload_len).ok()? != payload_len
        {
            return None;
        }
        self.offset
            .checked_add(u64::try_from(payload_len).ok()?)
            .filter(|next| *next <= self.upper_bound)
    }
}

pub(super) fn encode_control_frame(
    message: &ControlMessage,
) -> Result<String, ControlFrameEncodeError> {
    message
        .validate()
        .map_err(ControlFrameEncodeError::Protocol)?;
    serde_json::to_string(message).map_err(ControlFrameEncodeError::Serialize)
}

#[cfg(target_arch = "wasm32")]
pub(super) fn send_control_on(
    channel: &web_sys::RtcDataChannel,
    message: &ControlMessage,
) -> Result<(), crate::BrowserPlatformError> {
    let json = encode_control_frame(message).map_err(|error| match error {
        ControlFrameEncodeError::Protocol(error) => {
            crate::BrowserPlatformError::Decode(error.to_string())
        }
        ControlFrameEncodeError::Serialize(error) => {
            crate::BrowserPlatformError::Decode(error.to_string())
        }
    })?;
    channel.send_with_str(&json).map_err(|value| {
        crate::BrowserPlatformError::Browser(
            value.as_string().unwrap_or_else(|| format!("{value:?}")),
        )
    })
}

pub(super) fn encode_binary_chunk(
    transfer_id: [u8; 16],
    file_id: [u8; 16],
    offset: u64,
    payload_len: u32,
    payload: &[u8],
) -> Vec<u8> {
    let mut frame = BinaryChunkHeader {
        version: CURRENT_PROTOCOL,
        transfer_id,
        file_id,
        offset,
        payload_len,
    }
    .encode()
    .to_vec();
    frame.extend_from_slice(payload);
    frame
}

pub(super) fn decode_binary_chunk(frame: &[u8]) -> Result<BinaryChunk<'_>, ProtocolError> {
    let (header, payload) = decode_binary_frame(frame)?;
    Ok(BinaryChunk { header, payload })
}

#[cfg(test)]
mod tests {
    use p2p_protocol::{CHUNK_HEADER_LEN, ControlMessage, ProtocolVersion, parse_control_message};
    use p2p_transfer::DEFAULT_CHUNK_BYTES;

    use super::*;

    const TRANSFER_ID: [u8; 16] = [0x11; 16];
    const FILE_ID: [u8; 16] = [0x22; 16];

    #[test]
    fn default_binary_frame_stays_below_the_conservative_64_kib_boundary() {
        assert!(CHUNK_HEADER_LEN + DEFAULT_CHUNK_BYTES <= 64 * 1024);
    }

    #[test]
    fn binary_chunk_round_trips_without_changing_wire_fields() {
        let payload = b"wire payload";
        let frame = encode_binary_chunk(TRANSFER_ID, FILE_ID, 37, payload.len() as u32, payload);
        let chunk = decode_binary_chunk(&frame).expect("binary chunk should decode");

        assert_eq!(chunk.header.version, CURRENT_PROTOCOL);
        assert_eq!(chunk.header.transfer_id, TRANSFER_ID);
        assert_eq!(chunk.header.file_id, FILE_ID);
        assert_eq!(chunk.header.offset, 37);
        assert_eq!(chunk.header.payload_len, payload.len() as u32);
        assert_eq!(chunk.payload, payload);
    }

    #[test]
    fn binary_chunk_preserves_the_planned_payload_length() {
        let frame = encode_binary_chunk(TRANSFER_ID, FILE_ID, 0, 5, b"four");
        assert_eq!(&frame[49..53], &5_u32.to_be_bytes());
        assert!(matches!(
            decode_binary_chunk(&frame),
            Err(ProtocolError::BinaryLengthMismatch)
        ));
    }

    #[test]
    fn chunk_bounds_accept_exact_sequence_and_final_partial_chunk() {
        let first = BinaryChunkHeader {
            version: CURRENT_PROTOCOL,
            transfer_id: TRANSFER_ID,
            file_id: FILE_ID,
            offset: 0,
            payload_len: 64,
        };
        assert_eq!(
            ChunkBounds::new(TRANSFER_ID, FILE_ID, 0, 100).next_offset(&first, 64),
            Some(64)
        );

        let final_chunk = BinaryChunkHeader {
            offset: 64,
            payload_len: 36,
            ..first
        };
        assert_eq!(
            ChunkBounds::new(TRANSFER_ID, FILE_ID, 64, 100).next_offset(&final_chunk, 36),
            Some(100)
        );
    }

    #[test]
    fn chunk_bounds_reject_wrong_identity_order_length_and_overflow() {
        let valid = BinaryChunkHeader {
            version: CURRENT_PROTOCOL,
            transfer_id: TRANSFER_ID,
            file_id: FILE_ID,
            offset: 10,
            payload_len: 5,
        };
        let bounds = ChunkBounds::new(TRANSFER_ID, FILE_ID, 10, 15);

        assert_eq!(
            bounds.next_offset(
                &BinaryChunkHeader {
                    transfer_id: [0x33; 16],
                    ..valid
                },
                5
            ),
            None
        );
        assert_eq!(
            bounds.next_offset(
                &BinaryChunkHeader {
                    file_id: [0x33; 16],
                    ..valid
                },
                5
            ),
            None
        );
        assert_eq!(
            bounds.next_offset(&BinaryChunkHeader { offset: 9, ..valid }, 5),
            None
        );
        assert_eq!(bounds.next_offset(&valid, 4), None);
        assert_eq!(
            ChunkBounds::new(TRANSFER_ID, FILE_ID, 10, 14).next_offset(&valid, 5),
            None
        );

        let overflow = BinaryChunkHeader {
            offset: u64::MAX,
            payload_len: 1,
            ..valid
        };
        assert_eq!(
            ChunkBounds::new(TRANSFER_ID, FILE_ID, u64::MAX, u64::MAX).next_offset(&overflow, 1),
            None
        );
    }

    #[test]
    fn control_frame_encoding_keeps_validation_and_json_shape() {
        let message = ControlMessage::Start {
            version: CURRENT_PROTOCOL,
            transfer_id: "transfer_000102030405060708090a0b0c0d0e0f".to_owned(),
        };
        let json = encode_control_frame(&message).expect("control frame should encode");
        assert_eq!(
            parse_control_message(&json).expect("control frame should parse"),
            message
        );

        let invalid = ControlMessage::Start {
            version: ProtocolVersion::new(CURRENT_PROTOCOL.major + 1, 0),
            transfer_id: "transfer_000102030405060708090a0b0c0d0e0f".to_owned(),
        };
        assert!(matches!(
            encode_control_frame(&invalid),
            Err(ControlFrameEncodeError::Protocol(
                ProtocolError::UnsupportedVersion { .. }
            ))
        ));
    }
}
