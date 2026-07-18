mod connection;
mod control;
mod files;
mod incoming;
mod lifecycle;
mod outgoing;
mod peer;
mod recovery;
mod signaling;

pub use files::{
    BrowserFile, browser_files_from_input, choose_persistent_source_files,
    persistent_source_file_support,
};
pub use peer::RtcPeer;

use lifecycle::prepare_outgoing;
use peer::{
    Inner, OutgoingFileState, OutgoingState, PendingSegmentAck, ReceiveFileState, ReceivePayload,
    ReceiveState, StreamReadyPlan, browser_error, clear_peer_resources, protocol_error,
    reconnectable_channel_error,
};

use super::{
    BrowserPlatformError, RtcConnectionPhase, RtcEvent, StreamingFileWriter, TransferDirection,
    manifest::{batch_blake3, format_binary_id, parse_binary_id, summarize_transfer_files},
    wire::{ChunkBounds, decode_binary_chunk, encode_binary_chunk, send_control_on},
};
use crate::{
    BrowserStorageErrorKind,
    stream_recovery::{
        StreamRecoveryFile, StreamRecoveryRecord, delete_stream_recovery, load_stream_recovery,
        save_stream_recovery,
    },
};

const PROGRESS_INTERVAL_MS: f64 = 50.0;
const BACKPRESSURE_TIMEOUT_MS: u32 = 250;
