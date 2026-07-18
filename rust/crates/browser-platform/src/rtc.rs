#[cfg(any(target_arch = "wasm32", test))]
mod checkpoint;
#[cfg(any(target_arch = "wasm32", test))]
mod finalization;
#[cfg(any(target_arch = "wasm32", test))]
mod manifest;
#[cfg(any(target_arch = "wasm32", test))]
mod wire;

use std::rc::Rc;

use p2p_protocol::{CancelReason, RtcConfigResponse, Signal, StreamPauseReason};
pub use p2p_transfer::{TransferDirection, TransferFile};

use crate::{BrowserPlatformError, StreamingFileWriter, monotonic_millis};

#[derive(Clone, Debug)]
pub struct RtcConfigLease {
    inner: Rc<RtcConfigLeaseInner>,
}

#[derive(Debug)]
struct RtcConfigLeaseInner {
    response: RtcConfigResponse,
    valid_until_ms: u64,
}

impl RtcConfigLease {
    pub fn from_request_start(response: RtcConfigResponse, request_started_at_ms: u64) -> Self {
        let ttl_ms = response.ttl_ms;
        Self {
            inner: Rc::new(RtcConfigLeaseInner {
                response,
                valid_until_ms: rtc_config_deadline_ms(request_started_at_ms, ttl_ms),
            }),
        }
    }

    pub fn response(&self) -> &RtcConfigResponse {
        &self.inner.response
    }

    pub fn remaining_ms(&self) -> u64 {
        self.inner.valid_until_ms.saturating_sub(monotonic_millis())
    }

    pub fn is_valid(&self) -> bool {
        self.remaining_ms() > 0
    }

    pub fn ptr_eq(&self, other: &Self) -> bool {
        Rc::ptr_eq(&self.inner, &other.inner)
    }
}

fn rtc_config_deadline_ms(received_at_ms: u64, valid_for_ms: u64) -> u64 {
    received_at_ms.saturating_add(valid_for_ms)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RtcConnectionPhase {
    New,
    Connecting,
    Connected,
    Disconnected,
    Failed,
    Closed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OfferStart {
    Started,
    AlreadyActive,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SignalAcceptance {
    Scheduled,
    Deferred,
    Ignored,
}

#[derive(Clone, Debug, PartialEq)]
pub enum RtcEvent {
    OutboundSignal {
        to_peer_id: String,
        negotiation_id: String,
        signal: Signal,
    },
    ConnectionState(RtcConnectionPhase),
    DataChannelReady,
    NegotiationFailed {
        message: String,
    },
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
            _rtc_config: RtcConfigLease,
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

        pub fn replace_reconnect_rtc_config(
            &self,
            _rtc_config: RtcConfigLease,
        ) -> Result<(), BrowserPlatformError> {
            Err(BrowserPlatformError::UnsupportedTarget)
        }

        pub fn resumable_transfer_active(&self) -> bool {
            false
        }

        pub fn start_offer(
            &self,
            _target_peer: String,
        ) -> Result<OfferStart, BrowserPlatformError> {
            Err(BrowserPlatformError::UnsupportedTarget)
        }

        pub fn ptr_eq(&self, _other: &Self) -> bool {
            true
        }

        pub fn accept_signal(
            &self,
            _from_peer: String,
            _negotiation_id: String,
            _signal: Signal,
        ) -> Result<SignalAcceptance, BrowserPlatformError> {
            Err(BrowserPlatformError::UnsupportedTarget)
        }

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

#[cfg(test)]
mod lease_tests {
    use super::rtc_config_deadline_ms;

    #[test]
    fn rtc_config_deadline_is_relative_to_local_receipt() {
        assert_eq!(rtc_config_deadline_ms(1_000, 600_000), 601_000);
    }

    #[test]
    fn rtc_config_deadline_saturates_instead_of_wrapping() {
        assert_eq!(rtc_config_deadline_ms(u64::MAX - 5, 10), u64::MAX);
    }
}
