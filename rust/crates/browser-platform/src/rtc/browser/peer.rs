use std::{cell::RefCell, rc::Rc};

use blake3::Hasher;
use futures_channel::oneshot;
use p2p_protocol::{FileDigest, TransferMode};
use wasm_bindgen::{JsValue, closure::Closure};
use web_sys::{
    Event, File, MessageEvent, RtcDataChannel, RtcDataChannelEvent, RtcDataChannelState,
    RtcPeerConnection, RtcPeerConnectionIceEvent, Url,
};

use super::super::{
    BrowserPlatformError, RtcConfigResponse, RtcEvent, Signal, StreamPauseReason,
    StreamingFileWriter, TransferFile, manifest::IncomingOffer,
};
use crate::{
    stream_recovery::{OutgoingRecoveryRecord, StreamRecoveryRecord},
    stream_storage::StreamingFileAbortHandle,
};

pub(super) type EventCallback = Rc<RefCell<Box<dyn FnMut(RtcEvent)>>>;

#[derive(Clone)]
pub struct RtcPeer {
    pub(super) inner: Rc<RefCell<Inner>>,
}

pub(super) struct Inner {
    pub(super) callback: EventCallback,
    pub(super) rtc_config: RtcConfigResponse,
    pub(super) peer_connection: Option<RtcPeerConnection>,
    pub(super) data_channel: Option<RtcDataChannel>,
    pub(super) target_peer: Option<String>,
    pub(super) negotiating: bool,
    pub(super) local_description_announced: bool,
    pub(super) remote_description_set: bool,
    pub(super) pending_local_candidates: Vec<Signal>,
    pub(super) pending_remote_candidates: Vec<(String, Signal)>,
    pub(super) outgoing: Option<OutgoingState>,
    pub(super) pending_outgoing_recovery: Option<OutgoingRecoveryRecord>,
    pub(super) restoring_outgoing: bool,
    pub(super) incoming: Option<IncomingOffer>,
    pub(super) pending_recovery: Option<StreamRecoveryRecord>,
    pub(super) paused_receive_reason: Option<StreamPauseReason>,
    pub(super) restoring_transfer: Option<String>,
    pub(super) receive: Option<ReceiveState>,
    pub(super) object_url: Option<String>,
    pub(super) peer_ice: Option<Closure<dyn FnMut(RtcPeerConnectionIceEvent)>>,
    pub(super) peer_state: Option<Closure<dyn FnMut(Event)>>,
    pub(super) peer_data_channel: Option<Closure<dyn FnMut(RtcDataChannelEvent)>>,
    pub(super) data_open: Option<Closure<dyn FnMut(Event)>>,
    pub(super) data_message: Option<Closure<dyn FnMut(MessageEvent)>>,
    pub(super) data_close: Option<Closure<dyn FnMut(Event)>>,
    pub(super) data_error: Option<Closure<dyn FnMut(Event)>>,
}

#[derive(Clone, Copy)]
pub(super) struct StreamReadyPlan {
    pub(super) max_chunk_bytes: u32,
    pub(super) ack_window_bytes: u64,
}

pub(super) struct PendingSegmentAck {
    pub(super) file_index: usize,
    pub(super) segment_index: u64,
    pub(super) committed_bytes: u64,
    pub(super) blake3: String,
    pub(super) file_hasher: Box<Hasher>,
    pub(super) sender: Option<oneshot::Sender<Result<(), String>>>,
}

pub(super) struct OutgoingFileState {
    pub(super) file_bytes: [u8; 16],
    pub(super) file: TransferFile,
    pub(super) browser_file: File,
    pub(super) source_handle: Option<JsValue>,
    pub(super) last_modified_ms: u64,
    pub(super) expected_hash: Option<String>,
    pub(super) committed_bytes: u64,
    pub(super) committed_hasher: Box<Hasher>,
    pub(super) last_segment_blake3: Option<String>,
}

pub(super) struct OutgoingState {
    pub(super) transfer_id: String,
    pub(super) transfer_bytes: [u8; 16],
    pub(super) mode: TransferMode,
    pub(super) files: Vec<OutgoingFileState>,
    pub(super) total_bytes: u64,
    pub(super) sent_bytes: u64,
    pub(super) expected_digests: Vec<FileDigest>,
    pub(super) accepted: bool,
    pub(super) stream_ready: Option<StreamReadyPlan>,
    pub(super) pending_ack: Option<PendingSegmentAck>,
    pub(super) generation: u64,
    pub(super) sending: bool,
    pub(super) cancelled: bool,
    pub(super) last_progress_ms: f64,
    pub(super) max_buffered_bytes: u64,
    pub(super) recovery_peer_id: Option<String>,
    pub(super) restored_from_disk: bool,
    pub(super) reconciling_resume: bool,
}

pub(super) struct ReceiveState {
    pub(super) offer: IncomingOffer,
    pub(super) started: bool,
    pub(super) received_bytes: u64,
    pub(super) payload: ReceivePayload,
    pub(super) hasher: Hasher,
    pub(super) resume_requested: bool,
    pub(super) last_progress_ms: f64,
    pub(super) recovery_persisted: bool,
    pub(super) generation: u64,
}

pub(super) enum ReceivePayload {
    Buffered {
        chunks: Vec<Vec<u8>>,
    },
    Streamed {
        segment_bytes: u32,
        current_file_index: usize,
        files: Vec<ReceiveFileState>,
    },
}

pub(super) struct ReceiveFileState {
    pub(super) writer: Option<StreamingFileWriter>,
    pub(super) active_abort: Option<StreamingFileAbortHandle>,
    pub(super) received_bytes: u64,
    pub(super) hasher: Box<Hasher>,
    pub(super) segment_index: u64,
    pub(super) segment_offset: u64,
    pub(super) chunks: Vec<Vec<u8>>,
    pub(super) segment_hasher: Box<Hasher>,
    pub(super) committed_hasher: Box<Hasher>,
    pub(super) last_segment_blake3: Option<String>,
    pub(super) writing: bool,
}

impl Drop for Inner {
    fn drop(&mut self) {
        clear_peer_resources(self);
        if let Some(url) = self.object_url.take() {
            let _ = Url::revoke_object_url(&url);
        }
    }
}

impl RtcPeer {
    pub fn new(
        rtc_config: RtcConfigResponse,
        on_event: impl FnMut(RtcEvent) + 'static,
    ) -> Result<Self, BrowserPlatformError> {
        rtc_config.version.validate().map_err(protocol_error)?;
        Ok(Self {
            inner: Rc::new(RefCell::new(Inner {
                callback: Rc::new(RefCell::new(Box::new(on_event))),
                rtc_config,
                peer_connection: None,
                data_channel: None,
                target_peer: None,
                negotiating: false,
                local_description_announced: false,
                remote_description_set: false,
                pending_local_candidates: Vec::new(),
                pending_remote_candidates: Vec::new(),
                outgoing: None,
                pending_outgoing_recovery: None,
                restoring_outgoing: false,
                incoming: None,
                pending_recovery: None,
                paused_receive_reason: None,
                restoring_transfer: None,
                receive: None,
                object_url: None,
                peer_ice: None,
                peer_state: None,
                peer_data_channel: None,
                data_open: None,
                data_message: None,
                data_close: None,
                data_error: None,
            })),
        })
    }

    pub fn data_channel_ready(&self) -> bool {
        self.inner
            .borrow()
            .data_channel
            .as_ref()
            .is_some_and(|channel| channel.ready_state() == RtcDataChannelState::Open)
    }

    pub fn resumable_transfer_active(&self) -> bool {
        let inner = self.inner.borrow();
        inner
            .outgoing
            .as_ref()
            .is_some_and(|outgoing| matches!(outgoing.mode, TransferMode::Streamed { .. }))
            || inner
                .receive
                .as_ref()
                .is_some_and(|receive| matches!(receive.offer.mode, TransferMode::Streamed { .. }))
    }

    pub fn ptr_eq(&self, other: &Self) -> bool {
        Rc::ptr_eq(&self.inner, &other.inner)
    }

    pub(super) fn current_peer_connection(
        &self,
    ) -> Result<RtcPeerConnection, BrowserPlatformError> {
        self.inner
            .borrow()
            .peer_connection
            .clone()
            .ok_or_else(|| BrowserPlatformError::Browser("PeerConnection is not ready".to_owned()))
    }

    pub(super) fn current_data_channel(&self) -> Result<RtcDataChannel, BrowserPlatformError> {
        let channel =
            self.inner.borrow().data_channel.clone().ok_or_else(|| {
                BrowserPlatformError::Browser("DataChannel is not ready".to_owned())
            })?;
        if channel.ready_state() != RtcDataChannelState::Open {
            return Err(BrowserPlatformError::Browser(
                "DataChannel is not open".to_owned(),
            ));
        }
        Ok(channel)
    }

    pub(super) fn emit(&self, event: RtcEvent) {
        let callback = self.inner.borrow().callback.clone();
        (callback.borrow_mut())(event);
    }

    pub(super) fn fail(&self, transfer_id: Option<String>, message: String) {
        self.emit(RtcEvent::TransferFailed {
            transfer_id,
            message,
        });
    }
}

pub(super) fn clear_peer_resources(inner: &mut Inner) {
    if let Some(channel) = inner.data_channel.take() {
        channel.set_onopen(None);
        channel.set_onmessage(None);
        channel.set_onclose(None);
        channel.set_onerror(None);
        channel.set_onbufferedamountlow(None);
        channel.close();
    }
    if let Some(peer_connection) = inner.peer_connection.take() {
        peer_connection.set_onicecandidate(None);
        peer_connection.set_onconnectionstatechange(None);
        peer_connection.set_ondatachannel(None);
        peer_connection.close();
    }
    inner.target_peer = None;
    inner.negotiating = false;
    inner.local_description_announced = false;
    inner.remote_description_set = false;
    inner.pending_local_candidates.clear();
    inner.pending_remote_candidates.clear();
    inner.peer_ice = None;
    inner.peer_state = None;
    inner.peer_data_channel = None;
    inner.data_open = None;
    inner.data_message = None;
    inner.data_close = None;
    inner.data_error = None;
}

pub(super) fn protocol_error(error: p2p_protocol::ProtocolError) -> BrowserPlatformError {
    BrowserPlatformError::Decode(error.to_string())
}

pub(super) fn browser_error(value: JsValue) -> BrowserPlatformError {
    BrowserPlatformError::Browser(value.as_string().unwrap_or_else(|| format!("{value:?}")))
}

pub(super) fn reconnectable_channel_error(error: &BrowserPlatformError) -> bool {
    let message = error.to_string();
    message.contains("RTCDataChannel")
        || message.contains("DataChannel is not open")
        || message.contains("DataChannel is not ready")
}
