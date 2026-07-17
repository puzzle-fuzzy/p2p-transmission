#[cfg(any(target_arch = "wasm32", test))]
mod checkpoint;
#[cfg(any(target_arch = "wasm32", test))]
mod finalization;
#[cfg(any(target_arch = "wasm32", test))]
mod manifest;
#[cfg(any(target_arch = "wasm32", test))]
mod wire;

use p2p_protocol::{CancelReason, RtcConfigResponse, Signal, StreamPauseReason};
pub use p2p_transfer::{TransferDirection, TransferFile};

use crate::{BrowserPlatformError, StreamingFileWriter};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RtcConnectionPhase {
    New,
    Connecting,
    Connected,
    Disconnected,
    Failed,
    Closed,
}

#[derive(Clone, Debug, PartialEq)]
pub enum RtcEvent {
    OutboundSignal {
        to_peer_id: String,
        signal: Signal,
    },
    ConnectionState(RtcConnectionPhase),
    DataChannelReady,
    OutgoingOffered {
        transfer_id: String,
        file: TransferFile,
        files: Vec<TransferFile>,
    },
    OutgoingRecoveryOffered {
        transfer_id: String,
        file: TransferFile,
        files: Vec<TransferFile>,
    },
    IncomingOffered {
        transfer_id: String,
        mode: p2p_protocol::TransferMode,
        file: TransferFile,
        files: Vec<TransferFile>,
        recovery_available: bool,
    },
    TransferStarted {
        transfer_id: String,
        direction: TransferDirection,
        mode: p2p_protocol::TransferMode,
        file: TransferFile,
        files: Vec<TransferFile>,
    },
    TransferProgress {
        transfer_id: String,
        direction: TransferDirection,
        completed_bytes: u64,
        total_bytes: u64,
    },
    AwaitingVerification {
        transfer_id: String,
        file: TransferFile,
        files: Vec<TransferFile>,
    },
    TransferRejected {
        transfer_id: String,
        direction: TransferDirection,
        file: TransferFile,
        files: Vec<TransferFile>,
    },
    TransferCompleted {
        transfer_id: String,
        direction: TransferDirection,
        file: TransferFile,
        files: Vec<TransferFile>,
        blake3: String,
        download_url: Option<String>,
    },
    TransferCancelled {
        transfer_id: String,
        reason: CancelReason,
    },
    TransferPaused {
        transfer_id: String,
        direction: TransferDirection,
        reason: StreamPauseReason,
        completed_bytes: u64,
        total_bytes: u64,
    },
    TransferFailed {
        transfer_id: Option<String>,
        message: String,
    },
}

#[cfg(target_arch = "wasm32")]
mod browser;

#[cfg(target_arch = "wasm32")]
pub use browser::{
    BrowserFile, RtcPeer, browser_files_from_input, choose_persistent_source_files,
    persistent_source_file_support,
};

#[cfg(not(target_arch = "wasm32"))]
mod native {
    use super::*;

    #[derive(Clone)]
    pub struct BrowserFile;

    impl BrowserFile {
        pub fn name(&self) -> String {
            String::new()
        }

        pub fn mime(&self) -> Option<String> {
            None
        }

        pub fn size_bytes(&self) -> u64 {
            0
        }
    }

    #[derive(Clone)]
    pub struct RtcPeer;

    impl RtcPeer {
        pub fn new(
            _rtc_config: RtcConfigResponse,
            _on_event: impl FnMut(RtcEvent) + 'static,
        ) -> Result<Self, BrowserPlatformError> {
            Err(BrowserPlatformError::UnsupportedTarget)
        }

        pub async fn accept_stream_transfer(
            &self,
            _transfer_id: &str,
            _writers: Vec<StreamingFileWriter>,
        ) -> Result<(), BrowserPlatformError> {
            Err(BrowserPlatformError::UnsupportedTarget)
        }

        pub async fn resume_stream_transfer(
            &self,
            _transfer_id: &str,
        ) -> Result<(), BrowserPlatformError> {
            Err(BrowserPlatformError::UnsupportedTarget)
        }

        pub fn data_channel_ready(&self) -> bool {
            false
        }

        pub fn resumable_transfer_active(&self) -> bool {
            false
        }

        pub fn start_offer(&self, _target_peer: String) -> bool {
            false
        }

        pub fn ptr_eq(&self, _other: &Self) -> bool {
            true
        }

        pub fn accept_signal(&self, _from_peer: String, _signal: Signal) {}

        pub fn offer_files(
            &self,
            _files: Vec<BrowserFile>,
        ) -> Result<String, BrowserPlatformError> {
            Err(BrowserPlatformError::UnsupportedTarget)
        }

        pub async fn offer_persistent_files(
            &self,
            _files: Vec<BrowserFile>,
        ) -> Result<String, BrowserPlatformError> {
            Err(BrowserPlatformError::UnsupportedTarget)
        }

        pub async fn restore_outgoing_transfer(
            &self,
            _peer_id: &str,
        ) -> Result<bool, BrowserPlatformError> {
            Err(BrowserPlatformError::UnsupportedTarget)
        }

        pub async fn resume_outgoing_transfer(&self) -> Result<(), BrowserPlatformError> {
            Err(BrowserPlatformError::UnsupportedTarget)
        }

        pub fn decide_transfer(
            &self,
            _transfer_id: &str,
            _accepted: bool,
        ) -> Result<(), BrowserPlatformError> {
            Err(BrowserPlatformError::UnsupportedTarget)
        }

        pub async fn cancel_transfer(
            &self,
            _reason: CancelReason,
        ) -> Result<(), BrowserPlatformError> {
            Err(BrowserPlatformError::UnsupportedTarget)
        }

        pub fn reset(&self) {}

        pub fn prepare_reconnect(&self) {}
    }

    pub fn browser_files_from_input(
        _element_id: &str,
    ) -> Result<Vec<BrowserFile>, BrowserPlatformError> {
        Err(BrowserPlatformError::UnsupportedTarget)
    }

    pub fn persistent_source_file_support() -> bool {
        false
    }

    pub async fn choose_persistent_source_files() -> Result<Vec<BrowserFile>, BrowserPlatformError>
    {
        Err(BrowserPlatformError::UnsupportedTarget)
    }
}

#[cfg(not(target_arch = "wasm32"))]
pub use native::{
    BrowserFile, RtcPeer, browser_files_from_input, choose_persistent_source_files,
    persistent_source_file_support,
};
