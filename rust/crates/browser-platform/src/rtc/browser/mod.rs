mod control;
mod incoming;
mod outgoing;
mod recovery;

use std::{cell::RefCell, rc::Rc};

use blake3::Hasher;
use futures_channel::oneshot;
use js_sys::{Array, ArrayBuffer, Math, Reflect, Uint8Array};
use p2p_protocol::{
    CURRENT_PROTOCOL, ControlMessage, FileDigest, FileManifest, MAX_FILES_PER_MANIFEST,
    MAX_TRANSFER_BYTES, TransferMode, Validate, parse_control_message,
};
use p2p_transfer::BackpressurePolicy;
use wasm_bindgen::{JsCast, JsValue, closure::Closure};
use wasm_bindgen_futures::{JsFuture, spawn_local};
use web_sys::{
    Event, File, HtmlInputElement, MessageEvent, RtcConfiguration, RtcDataChannel,
    RtcDataChannelEvent, RtcDataChannelState, RtcDataChannelType, RtcIceCandidate,
    RtcIceCandidateInit, RtcIceServer, RtcPeerConnection, RtcPeerConnectionIceEvent,
    RtcPeerConnectionState, RtcSdpType, RtcSessionDescriptionInit, Url,
};

use super::{
    BrowserPlatformError, CancelReason, RtcConfigResponse, RtcConnectionPhase, RtcEvent, Signal,
    StreamPauseReason, StreamingFileWriter, TransferDirection, TransferFile,
    manifest::{
        IncomingOffer, TransferPlanError, batch_blake3, format_binary_id, parse_binary_id,
        plan_transfer, summarize_transfer_files,
    },
    wire::{ChunkBounds, decode_binary_chunk, encode_binary_chunk, send_control_on},
};
use crate::{
    BrowserStorageErrorKind,
    source_storage::{choose_source_files, persistent_source_file_support as source_file_support},
    stream_recovery::{
        OutgoingRecoveryRecord, StreamRecoveryFile, StreamRecoveryRecord, delete_outgoing_recovery,
        delete_stream_recovery, load_stream_recovery, save_stream_recovery,
    },
    stream_storage::StreamingFileAbortHandle,
};

const PROGRESS_INTERVAL_MS: f64 = 50.0;
const BACKPRESSURE_TIMEOUT_MS: u32 = 250;
const NEGOTIATION_SIGNAL_LIMIT: usize = 64;

type EventCallback = Rc<RefCell<Box<dyn FnMut(RtcEvent)>>>;

#[derive(Clone)]
pub struct BrowserFile {
    inner: File,
    source_handle: Option<JsValue>,
}

impl BrowserFile {
    pub fn name(&self) -> String {
        self.inner.name()
    }

    pub fn mime(&self) -> Option<String> {
        let value = self.inner.type_();
        (!value.is_empty()).then_some(value)
    }

    pub fn size_bytes(&self) -> u64 {
        self.inner.size() as u64
    }

    fn last_modified_ms(&self) -> u64 {
        self.inner.last_modified() as u64
    }

    fn metadata(&self) -> TransferFile {
        TransferFile {
            name: self.name(),
            mime: self.mime(),
            size_bytes: self.size_bytes(),
        }
    }
}

pub fn browser_files_from_input(
    element_id: &str,
) -> Result<Vec<BrowserFile>, BrowserPlatformError> {
    let document = web_sys::window()
        .ok_or(BrowserPlatformError::MissingWindow)?
        .document()
        .ok_or_else(|| BrowserPlatformError::Browser("document is unavailable".to_owned()))?;
    let element = document
        .get_element_by_id(element_id)
        .ok_or_else(|| BrowserPlatformError::Browser("file input is unavailable".to_owned()))?;
    let input = element
        .dyn_into::<HtmlInputElement>()
        .map_err(|element| browser_error(element.into()))?;
    let files = input
        .files()
        .map(|files| {
            (0..files.length())
                .filter_map(|index| files.get(index))
                .map(|inner| BrowserFile {
                    inner,
                    source_handle: None,
                })
                .collect()
        })
        .unwrap_or_default();
    input.set_value("");
    Ok(files)
}

pub fn persistent_source_file_support() -> bool {
    source_file_support()
}

pub async fn choose_persistent_source_files() -> Result<Vec<BrowserFile>, BrowserPlatformError> {
    choose_source_files().await.map(|files| {
        files
            .into_iter()
            .map(|file| BrowserFile {
                inner: file.file,
                source_handle: Some(file.handle),
            })
            .collect()
    })
}

#[derive(Clone)]
pub struct RtcPeer {
    inner: Rc<RefCell<Inner>>,
}

struct Inner {
    callback: EventCallback,
    rtc_config: RtcConfigResponse,
    peer_connection: Option<RtcPeerConnection>,
    data_channel: Option<RtcDataChannel>,
    target_peer: Option<String>,
    negotiating: bool,
    local_description_announced: bool,
    remote_description_set: bool,
    pending_local_candidates: Vec<Signal>,
    pending_remote_candidates: Vec<(String, Signal)>,
    outgoing: Option<OutgoingState>,
    pending_outgoing_recovery: Option<OutgoingRecoveryRecord>,
    restoring_outgoing: bool,
    incoming: Option<IncomingOffer>,
    pending_recovery: Option<StreamRecoveryRecord>,
    paused_receive_reason: Option<StreamPauseReason>,
    restoring_transfer: Option<String>,
    receive: Option<ReceiveState>,
    object_url: Option<String>,
    peer_ice: Option<Closure<dyn FnMut(RtcPeerConnectionIceEvent)>>,
    peer_state: Option<Closure<dyn FnMut(Event)>>,
    peer_data_channel: Option<Closure<dyn FnMut(RtcDataChannelEvent)>>,
    data_open: Option<Closure<dyn FnMut(Event)>>,
    data_message: Option<Closure<dyn FnMut(MessageEvent)>>,
    data_close: Option<Closure<dyn FnMut(Event)>>,
    data_error: Option<Closure<dyn FnMut(Event)>>,
}

#[derive(Clone, Copy)]
struct StreamReadyPlan {
    max_chunk_bytes: u32,
    ack_window_bytes: u64,
}

struct PendingSegmentAck {
    file_index: usize,
    segment_index: u64,
    committed_bytes: u64,
    blake3: String,
    file_hasher: Box<Hasher>,
    sender: Option<oneshot::Sender<Result<(), String>>>,
}

struct OutgoingFileState {
    file_bytes: [u8; 16],
    file: TransferFile,
    browser_file: File,
    source_handle: Option<JsValue>,
    last_modified_ms: u64,
    expected_hash: Option<String>,
    committed_bytes: u64,
    committed_hasher: Box<Hasher>,
    last_segment_blake3: Option<String>,
}

struct OutgoingState {
    transfer_id: String,
    transfer_bytes: [u8; 16],
    mode: TransferMode,
    files: Vec<OutgoingFileState>,
    total_bytes: u64,
    sent_bytes: u64,
    expected_digests: Vec<FileDigest>,
    accepted: bool,
    stream_ready: Option<StreamReadyPlan>,
    pending_ack: Option<PendingSegmentAck>,
    generation: u64,
    sending: bool,
    cancelled: bool,
    last_progress_ms: f64,
    max_buffered_bytes: u64,
    recovery_peer_id: Option<String>,
    restored_from_disk: bool,
    reconciling_resume: bool,
}

struct ReceiveState {
    offer: IncomingOffer,
    started: bool,
    received_bytes: u64,
    payload: ReceivePayload,
    hasher: Hasher,
    resume_requested: bool,
    last_progress_ms: f64,
    recovery_persisted: bool,
    generation: u64,
}

enum ReceivePayload {
    Buffered {
        chunks: Vec<Vec<u8>>,
    },
    Streamed {
        segment_bytes: u32,
        current_file_index: usize,
        files: Vec<ReceiveFileState>,
    },
}

struct ReceiveFileState {
    writer: Option<StreamingFileWriter>,
    active_abort: Option<StreamingFileAbortHandle>,
    received_bytes: u64,
    hasher: Box<Hasher>,
    segment_index: u64,
    segment_offset: u64,
    chunks: Vec<Vec<u8>>,
    segment_hasher: Box<Hasher>,
    committed_hasher: Box<Hasher>,
    last_segment_blake3: Option<String>,
    writing: bool,
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

    pub fn start_offer(&self, target_peer: String) -> bool {
        {
            let mut inner = self.inner.borrow_mut();
            if inner.negotiating
                || inner.target_peer.as_ref() == Some(&target_peer)
                    && inner.peer_connection.is_some()
            {
                return false;
            }
            inner.negotiating = true;
        }
        let peer = self.clone();
        spawn_local(async move {
            if let Err(error) = peer.create_offer(target_peer).await {
                peer.inner.borrow_mut().negotiating = false;
                peer.fail(None, error.to_string());
            }
        });
        true
    }

    pub fn ptr_eq(&self, other: &Self) -> bool {
        Rc::ptr_eq(&self.inner, &other.inner)
    }

    pub fn accept_signal(&self, from_peer: String, signal: Signal) {
        let peer = self.clone();
        spawn_local(async move {
            if let Err(error) = peer.accept_signal_inner(from_peer, signal).await {
                peer.fail(None, error.to_string());
            }
        });
    }

    pub fn offer_files(&self, files: Vec<BrowserFile>) -> Result<String, BrowserPlatformError> {
        let prepared = prepare_outgoing(files, None)?;
        self.install_and_offer_outgoing(prepared)
    }

    fn install_and_offer_outgoing(
        &self,
        prepared: (OutgoingState, ControlMessage, Vec<TransferFile>),
    ) -> Result<String, BrowserPlatformError> {
        let channel = self.current_data_channel()?;
        let (outgoing, message, metadata) = prepared;
        let transfer_id = outgoing.transfer_id.clone();
        {
            let mut inner = self.inner.borrow_mut();
            if inner.outgoing.is_some()
                || inner.incoming.is_some()
                || inner.receive.is_some()
                || inner.restoring_outgoing
            {
                return Err(BrowserPlatformError::Browser(
                    "another transfer is already active".to_owned(),
                ));
            }
            inner.outgoing = Some(outgoing);
        }
        if let Err(error) = send_control_on(&channel, &message) {
            self.inner.borrow_mut().outgoing = None;
            return Err(error);
        }
        self.emit(RtcEvent::OutgoingOffered {
            transfer_id: transfer_id.clone(),
            file: summarize_transfer_files(&metadata),
            files: metadata,
        });
        Ok(transfer_id)
    }

    pub fn decide_transfer(
        &self,
        transfer_id: &str,
        accepted: bool,
    ) -> Result<(), BrowserPlatformError> {
        let channel = self.current_data_channel()?;
        let offer = {
            let mut inner = self.inner.borrow_mut();
            let Some(offer) = inner.incoming.take() else {
                return Err(BrowserPlatformError::Browser(
                    "incoming transfer is no longer available".to_owned(),
                ));
            };
            if offer.transfer_id != transfer_id {
                inner.incoming = Some(offer);
                return Err(BrowserPlatformError::Browser(
                    "incoming transfer id does not match".to_owned(),
                ));
            }
            inner.pending_recovery = None;
            inner.paused_receive_reason = None;
            offer
        };
        if accepted {
            if offer.mode != TransferMode::Buffered {
                self.inner.borrow_mut().incoming = Some(offer);
                return Err(BrowserPlatformError::Browser(
                    "streaming transfer requires a save destination".to_owned(),
                ));
            }
            send_control_on(
                &channel,
                &ControlMessage::Decision {
                    version: CURRENT_PROTOCOL,
                    transfer_id: transfer_id.to_owned(),
                    accepted: true,
                },
            )?;
            self.inner.borrow_mut().receive = Some(ReceiveState {
                offer,
                started: false,
                received_bytes: 0,
                payload: ReceivePayload::Buffered { chunks: Vec::new() },
                hasher: Hasher::new(),
                resume_requested: false,
                last_progress_ms: 0.0,
                recovery_persisted: false,
                generation: 0,
            });
        } else {
            send_control_on(
                &channel,
                &ControlMessage::Decision {
                    version: CURRENT_PROTOCOL,
                    transfer_id: transfer_id.to_owned(),
                    accepted: false,
                },
            )?;
            self.emit(RtcEvent::TransferRejected {
                transfer_id: transfer_id.to_owned(),
                direction: TransferDirection::Receive,
                file: summarize_transfer_files(&offer.transfer_files()),
                files: offer.transfer_files(),
            });
            let transfer_id = transfer_id.to_owned();
            spawn_local(async move {
                let _ = delete_stream_recovery(&transfer_id).await;
            });
        }
        Ok(())
    }

    pub async fn cancel_transfer(&self, reason: CancelReason) -> Result<(), BrowserPlatformError> {
        let transfer_id = {
            let inner = self.inner.borrow();
            active_transfer_id(&inner)
        };
        let Some(transfer_id) = transfer_id else {
            return Ok(());
        };
        let mut first_error = self.current_data_channel().ok().and_then(|channel| {
            send_control_on(
                &channel,
                &ControlMessage::Cancel {
                    version: CURRENT_PROTOCOL,
                    transfer_id: transfer_id.clone(),
                    reason,
                },
            )
            .err()
        });
        let (writers, active_aborts, delete_recovery, outgoing_recovery_peer) = {
            let mut inner = self.inner.borrow_mut();
            let mut writers = Vec::new();
            let mut active_aborts = Vec::new();
            let mut delete_recovery = false;
            let mut outgoing_recovery_peer = None;

            if inner
                .outgoing
                .as_ref()
                .is_some_and(|state| state.transfer_id == transfer_id)
            {
                let mut outgoing = inner.outgoing.take().expect("outgoing was checked");
                outgoing.cancelled = true;
                outgoing.generation = outgoing.generation.saturating_add(1);
                if let Some(pending) = outgoing.pending_ack.as_mut() {
                    pending.sender.take();
                }
                outgoing_recovery_peer = outgoing.recovery_peer_id;
            }
            if inner
                .pending_outgoing_recovery
                .as_ref()
                .is_some_and(|state| state.transfer_id == transfer_id)
            {
                outgoing_recovery_peer = inner
                    .pending_outgoing_recovery
                    .take()
                    .map(|state| state.peer_id);
            }
            if inner
                .incoming
                .as_ref()
                .is_some_and(|state| state.transfer_id == transfer_id)
            {
                inner.incoming = None;
                delete_recovery = true;
            }
            if inner
                .pending_recovery
                .as_ref()
                .is_some_and(|state| state.transfer_id == transfer_id)
            {
                inner.pending_recovery = None;
                inner.paused_receive_reason = None;
                delete_recovery = true;
            }
            if inner.restoring_transfer.as_deref() == Some(transfer_id.as_str()) {
                inner.restoring_transfer = None;
                delete_recovery = true;
            }
            if inner
                .receive
                .as_ref()
                .is_some_and(|state| state.offer.transfer_id == transfer_id)
            {
                let mut receive = inner.receive.take().expect("receiver was checked");
                receive.generation = receive.generation.saturating_add(1);
                if let ReceivePayload::Streamed { files, .. } = &mut receive.payload {
                    for file in files {
                        if let Some(abort) = file.active_abort.take() {
                            active_aborts.push(abort);
                        }
                        if let Some(writer) = file.writer.take() {
                            writers.push(writer);
                        }
                    }
                }
                delete_recovery = true;
            }
            (
                writers,
                active_aborts,
                delete_recovery,
                outgoing_recovery_peer,
            )
        };

        for abort in active_aborts {
            if let Err(error) = abort.abort().await
                && first_error.is_none()
            {
                first_error = Some(error);
            }
        }
        for writer in writers {
            if let Err(error) = writer.abort().await
                && first_error.is_none()
            {
                first_error = Some(error);
            }
        }
        if delete_recovery
            && let Err(error) = delete_stream_recovery(&transfer_id).await
            && first_error.is_none()
        {
            first_error = Some(error);
        }
        if let Some(peer_id) = outgoing_recovery_peer
            && let Err(error) = delete_outgoing_recovery(&peer_id).await
            && first_error.is_none()
        {
            first_error = Some(error);
        }
        self.emit(RtcEvent::TransferCancelled {
            transfer_id,
            reason,
        });
        first_error.map_or(Ok(()), Err)
    }

    pub fn reset(&self) {
        let (cancelled, outgoing_recovery_peer) = {
            let mut inner = self.inner.borrow_mut();
            let transfer_id = active_transfer_id(&inner);
            let outgoing_recovery_peer = inner
                .outgoing
                .as_ref()
                .and_then(|state| state.recovery_peer_id.clone())
                .or_else(|| {
                    inner
                        .pending_outgoing_recovery
                        .as_ref()
                        .map(|state| state.peer_id.clone())
                });
            clear_peer_resources(&mut inner);
            inner.outgoing = None;
            inner.pending_outgoing_recovery = None;
            inner.restoring_outgoing = false;
            inner.incoming = None;
            inner.pending_recovery = None;
            inner.paused_receive_reason = None;
            inner.restoring_transfer = None;
            inner.receive = None;
            (transfer_id, outgoing_recovery_peer)
        };
        if let Some(transfer_id) = cancelled {
            let recovery_id = transfer_id.clone();
            spawn_local(async move {
                let _ = delete_stream_recovery(&recovery_id).await;
            });
            self.emit(RtcEvent::TransferCancelled {
                transfer_id,
                reason: CancelReason::PeerClosed,
            });
        }
        if let Some(peer_id) = outgoing_recovery_peer {
            spawn_local(async move {
                let _ = delete_outgoing_recovery(&peer_id).await;
            });
        }
    }

    pub fn prepare_reconnect(&self) {
        let cancelled = {
            let mut inner = self.inner.borrow_mut();
            let mut cancelled = None;

            if let Some(outgoing) = inner.outgoing.as_mut() {
                if matches!(outgoing.mode, TransferMode::Streamed { .. }) {
                    outgoing.generation = outgoing.generation.saturating_add(1);
                    outgoing.accepted = false;
                    outgoing.stream_ready = None;
                    outgoing.sending = false;
                    outgoing.sent_bytes =
                        outgoing.files.iter().map(|file| file.committed_bytes).sum();
                    if let Some(pending) = outgoing.pending_ack.as_mut() {
                        pending.sender.take();
                    }
                } else {
                    cancelled = Some(outgoing.transfer_id.clone());
                    inner.outgoing = None;
                }
            }

            if let Some(receive) = inner.receive.as_mut() {
                if matches!(receive.payload, ReceivePayload::Streamed { .. }) {
                    recovery::prepare_receive_reconnect(receive);
                } else {
                    cancelled = Some(receive.offer.transfer_id.clone());
                    inner.receive = None;
                }
            }

            if let Some(incoming) = inner.incoming.take() {
                cancelled.get_or_insert(incoming.transfer_id);
            }
            clear_peer_resources(&mut inner);
            cancelled
        };
        if let Some(transfer_id) = cancelled {
            self.emit(RtcEvent::TransferCancelled {
                transfer_id,
                reason: CancelReason::PeerClosed,
            });
        }
    }

    fn suspend_stream_for_reconnect(&self) {
        let mut inner = self.inner.borrow_mut();
        if let Some(outgoing) = inner.outgoing.as_mut()
            && matches!(outgoing.mode, TransferMode::Streamed { .. })
        {
            outgoing.generation = outgoing.generation.saturating_add(1);
            outgoing.accepted = false;
            outgoing.stream_ready = None;
            outgoing.sending = false;
            outgoing.sent_bytes = outgoing.files.iter().map(|file| file.committed_bytes).sum();
            if let Some(pending) = outgoing.pending_ack.as_mut() {
                pending.sender.take();
            }
        }
        if let Some(receive) = inner.receive.as_mut()
            && matches!(receive.payload, ReceivePayload::Streamed { .. })
        {
            recovery::prepare_receive_reconnect(receive);
        }
    }

    async fn create_offer(&self, target_peer: String) -> Result<(), BrowserPlatformError> {
        let peer_connection = self.ensure_peer_connection(&target_peer)?;
        let channel = peer_connection.create_data_channel("p2p-transfer");
        self.install_data_channel(channel);
        let offer_value = JsFuture::from(peer_connection.create_offer())
            .await
            .map_err(browser_error)?;
        let offer_sdp = description_sdp(&offer_value)?;
        let offer = offer_value.unchecked_into::<RtcSessionDescriptionInit>();
        JsFuture::from(peer_connection.set_local_description(&offer))
            .await
            .map_err(browser_error)?;
        self.inner.borrow_mut().negotiating = false;
        self.announce_local_description(target_peer, Signal::Offer { sdp: offer_sdp });
        Ok(())
    }

    async fn accept_signal_inner(
        &self,
        from_peer: String,
        signal: Signal,
    ) -> Result<(), BrowserPlatformError> {
        match signal {
            Signal::Offer { sdp } => {
                let should_replace = {
                    let inner = self.inner.borrow();
                    inner.target_peer.as_deref() == Some(from_peer.as_str())
                        && inner.peer_connection.is_some()
                        && inner.remote_description_set
                        && !inner.data_channel.as_ref().is_some_and(|channel| {
                            channel.ready_state() == RtcDataChannelState::Open
                        })
                };
                if should_replace {
                    self.prepare_reconnect();
                }
                let peer_connection = self.ensure_peer_connection(&from_peer)?;
                let remote = RtcSessionDescriptionInit::new(RtcSdpType::Offer);
                remote.set_sdp(&sdp);
                JsFuture::from(peer_connection.set_remote_description(&remote))
                    .await
                    .map_err(browser_error)?;
                self.inner.borrow_mut().remote_description_set = true;
                self.apply_pending_candidates().await?;
                let answer_value = JsFuture::from(peer_connection.create_answer())
                    .await
                    .map_err(browser_error)?;
                let answer_sdp = description_sdp(&answer_value)?;
                let answer = answer_value.unchecked_into::<RtcSessionDescriptionInit>();
                JsFuture::from(peer_connection.set_local_description(&answer))
                    .await
                    .map_err(browser_error)?;
                self.announce_local_description(from_peer, Signal::Answer { sdp: answer_sdp });
            }
            Signal::Answer { sdp } => {
                let peer_connection = self.current_peer_connection()?;
                let remote = RtcSessionDescriptionInit::new(RtcSdpType::Answer);
                remote.set_sdp(&sdp);
                JsFuture::from(peer_connection.set_remote_description(&remote))
                    .await
                    .map_err(browser_error)?;
                self.inner.borrow_mut().remote_description_set = true;
                self.apply_pending_candidates().await?;
            }
            candidate @ Signal::IceCandidate { .. } => {
                let ready = {
                    let inner = self.inner.borrow();
                    inner.peer_connection.is_some() && inner.remote_description_set
                };
                if !ready {
                    let mut inner = self.inner.borrow_mut();
                    if inner.pending_remote_candidates.len() >= NEGOTIATION_SIGNAL_LIMIT {
                        return Err(BrowserPlatformError::Browser(
                            "too many queued ICE candidates".to_owned(),
                        ));
                    }
                    inner.pending_remote_candidates.push((from_peer, candidate));
                    return Ok(());
                }
                self.apply_ice_candidate(candidate).await?;
            }
        }
        Ok(())
    }

    async fn apply_pending_candidates(&self) -> Result<(), BrowserPlatformError> {
        let pending = std::mem::take(&mut self.inner.borrow_mut().pending_remote_candidates);
        for (_, signal) in pending {
            self.apply_ice_candidate(signal).await?;
        }
        Ok(())
    }

    async fn apply_ice_candidate(&self, signal: Signal) -> Result<(), BrowserPlatformError> {
        let Signal::IceCandidate {
            candidate,
            sdp_mid,
            sdp_m_line_index,
        } = signal
        else {
            return Ok(());
        };
        let peer_connection = self.current_peer_connection()?;
        let candidate_init = RtcIceCandidateInit::new(&candidate);
        candidate_init.set_sdp_mid(sdp_mid.as_deref());
        candidate_init.set_sdp_m_line_index(sdp_m_line_index);
        let candidate = RtcIceCandidate::new(&candidate_init).map_err(browser_error)?;
        JsFuture::from(
            peer_connection.add_ice_candidate_with_opt_rtc_ice_candidate(Some(&candidate)),
        )
        .await
        .map_err(browser_error)?;
        Ok(())
    }

    fn ensure_peer_connection(
        &self,
        target_peer: &str,
    ) -> Result<RtcPeerConnection, BrowserPlatformError> {
        let existing = {
            let inner = self.inner.borrow();
            inner.peer_connection.clone().zip(inner.target_peer.clone())
        };
        if let Some((existing, existing_target)) = existing {
            if existing_target == target_peer {
                return Ok(existing);
            }
            self.reset();
        }

        let configuration = rtc_configuration(&self.inner.borrow().rtc_config);
        let peer_connection =
            RtcPeerConnection::new_with_configuration(&configuration).map_err(browser_error)?;
        {
            let mut inner = self.inner.borrow_mut();
            inner.target_peer = Some(target_peer.to_owned());
            inner.local_description_announced = false;
            inner.remote_description_set = false;
            inner.pending_local_candidates.clear();
        }

        let ice_peer = self.clone();
        let on_ice = Closure::<dyn FnMut(RtcPeerConnectionIceEvent)>::new(
            move |event: RtcPeerConnectionIceEvent| {
                let Some(candidate) = event.candidate() else {
                    return;
                };
                ice_peer.queue_or_emit_local_candidate(Signal::IceCandidate {
                    candidate: candidate.candidate(),
                    sdp_mid: candidate.sdp_mid(),
                    sdp_m_line_index: candidate.sdp_m_line_index(),
                });
            },
        );
        peer_connection.set_onicecandidate(Some(on_ice.as_ref().unchecked_ref()));

        let state_peer = self.clone();
        let state_connection = peer_connection.clone();
        let on_state = Closure::<dyn FnMut(Event)>::new(move |_| {
            let phase = map_connection_state(state_connection.connection_state());
            if matches!(
                phase,
                RtcConnectionPhase::Failed | RtcConnectionPhase::Closed
            ) {
                state_peer.suspend_stream_for_reconnect();
            }
            state_peer.emit(RtcEvent::ConnectionState(phase));
        });
        peer_connection.set_onconnectionstatechange(Some(on_state.as_ref().unchecked_ref()));

        let channel_peer = self.clone();
        let on_data_channel =
            Closure::<dyn FnMut(RtcDataChannelEvent)>::new(move |event: RtcDataChannelEvent| {
                channel_peer.install_data_channel(event.channel());
            });
        peer_connection.set_ondatachannel(Some(on_data_channel.as_ref().unchecked_ref()));

        let mut inner = self.inner.borrow_mut();
        inner.peer_connection = Some(peer_connection.clone());
        inner.peer_ice = Some(on_ice);
        inner.peer_state = Some(on_state);
        inner.peer_data_channel = Some(on_data_channel);
        Ok(peer_connection)
    }

    fn install_data_channel(&self, channel: RtcDataChannel) {
        channel.set_binary_type(RtcDataChannelType::Arraybuffer);
        channel.set_buffered_amount_low_threshold(
            BackpressurePolicy::default().low_watermark_bytes as u32,
        );

        let open_peer = self.clone();
        let on_open = Closure::<dyn FnMut(Event)>::new(move |_| {
            open_peer.data_channel_opened();
        });
        channel.set_onopen(Some(on_open.as_ref().unchecked_ref()));

        let message_peer = self.clone();
        let on_message = Closure::<dyn FnMut(MessageEvent)>::new(move |event: MessageEvent| {
            if let Some(text) = event.data().as_string() {
                match parse_control_message(&text) {
                    Ok(message) => message_peer.handle_control(message),
                    Err(error) => message_peer.fail(None, error.to_string()),
                }
                return;
            }
            if event.data().is_instance_of::<ArrayBuffer>() {
                message_peer.handle_binary(Uint8Array::new(&event.data()).to_vec());
            } else {
                message_peer.fail(None, "unsupported DataChannel frame".to_owned());
            }
        });
        channel.set_onmessage(Some(on_message.as_ref().unchecked_ref()));

        let close_peer = self.clone();
        let on_close = Closure::<dyn FnMut(Event)>::new(move |_| {
            close_peer.suspend_stream_for_reconnect();
            close_peer.emit(RtcEvent::ConnectionState(RtcConnectionPhase::Closed));
        });
        channel.set_onclose(Some(on_close.as_ref().unchecked_ref()));

        let error_peer = self.clone();
        let on_error = Closure::<dyn FnMut(Event)>::new(move |_| {
            error_peer.suspend_stream_for_reconnect();
            error_peer.emit(RtcEvent::ConnectionState(RtcConnectionPhase::Failed));
        });
        channel.set_onerror(Some(on_error.as_ref().unchecked_ref()));

        let already_open = channel.ready_state() == RtcDataChannelState::Open;
        let mut inner = self.inner.borrow_mut();
        if let Some(previous) = inner.data_channel.replace(channel) {
            previous.set_onopen(None);
            previous.set_onmessage(None);
            previous.set_onclose(None);
            previous.set_onerror(None);
            previous.set_onbufferedamountlow(None);
            previous.close();
        }
        inner.data_open = Some(on_open);
        inner.data_message = Some(on_message);
        inner.data_close = Some(on_close);
        inner.data_error = Some(on_error);
        drop(inner);
        if already_open {
            self.data_channel_opened();
        }
    }

    fn handle_decision(&self, transfer_id: String, accepted: bool) {
        let (rejected, start_generation) = {
            let mut inner = self.inner.borrow_mut();
            let Some(outgoing) = inner.outgoing.as_mut() else {
                drop(inner);
                self.fail(
                    Some(transfer_id),
                    "decision has no outgoing transfer".to_owned(),
                );
                return;
            };
            if outgoing.transfer_id != transfer_id {
                drop(inner);
                self.fail(Some(transfer_id), "decision id does not match".to_owned());
                return;
            }
            if !accepted {
                let outgoing = inner.outgoing.take().expect("outgoing was checked");
                let files = outgoing
                    .files
                    .iter()
                    .map(|file| file.file.clone())
                    .collect::<Vec<_>>();
                (
                    Some((
                        summarize_transfer_files(&files),
                        files,
                        outgoing.recovery_peer_id,
                    )),
                    None,
                )
            } else {
                outgoing.accepted = true;
                let ready =
                    outgoing.mode == TransferMode::Buffered || outgoing.stream_ready.is_some();
                let should_start = ready && !outgoing.sending;
                if should_start {
                    outgoing.sending = true;
                }
                (None, should_start.then_some(outgoing.generation))
            }
        };
        if let Some((file, files, recovery_peer_id)) = rejected {
            self.emit(RtcEvent::TransferRejected {
                transfer_id,
                direction: TransferDirection::Send,
                file,
                files,
            });
            if let Some(peer_id) = recovery_peer_id {
                spawn_local(async move {
                    let _ = delete_outgoing_recovery(&peer_id).await;
                });
            }
        } else if let Some(generation) = start_generation {
            self.spawn_outgoing(transfer_id, generation);
        }
    }

    fn handle_stream_paused(&self, transfer_id: String, reason: StreamPauseReason) {
        let paused = {
            let mut inner = self.inner.borrow_mut();
            let Some(outgoing) = inner.outgoing.as_mut() else {
                drop(inner);
                self.fail(
                    Some(transfer_id),
                    "stream pause has no outgoing transfer".to_owned(),
                );
                return;
            };
            if outgoing.transfer_id != transfer_id
                || !matches!(outgoing.mode, TransferMode::Streamed { .. })
            {
                drop(inner);
                self.fail(
                    Some(transfer_id),
                    "stream pause does not match the outgoing transfer".to_owned(),
                );
                return;
            }
            outgoing.generation = outgoing.generation.saturating_add(1);
            outgoing.accepted = true;
            outgoing.sending = false;
            outgoing.stream_ready = None;
            if let Some(pending) = outgoing.pending_ack.as_mut() {
                pending.sender.take();
            }
            outgoing.sent_bytes = outgoing.files.iter().map(|file| file.committed_bytes).sum();
            (outgoing.sent_bytes, outgoing.total_bytes)
        };
        self.emit(RtcEvent::TransferPaused {
            transfer_id,
            direction: TransferDirection::Send,
            reason,
            completed_bytes: paused.0,
            total_bytes: paused.1,
        });
    }

    fn handle_stream_complete(
        &self,
        transfer_id: String,
        total_bytes: u64,
        files: Vec<FileDigest>,
    ) {
        if self.inner.borrow().receive.is_some() {
            self.finish_stream_receive(transfer_id, total_bytes, files);
            return;
        }
        let completed = {
            let mut inner = self.inner.borrow_mut();
            let Some(outgoing) = inner.outgoing.as_ref() else {
                drop(inner);
                self.fail(
                    Some(transfer_id),
                    "stream completion has no active transfer".to_owned(),
                );
                return;
            };
            if outgoing.transfer_id != transfer_id
                || !matches!(outgoing.mode, TransferMode::Streamed { .. })
                || total_bytes != outgoing.total_bytes
                || outgoing.sent_bytes != total_bytes
                || files != outgoing.expected_digests
            {
                drop(inner);
                self.fail(
                    Some(transfer_id),
                    "receiver stream verification does not match".to_owned(),
                );
                return;
            }
            let outgoing = inner.outgoing.take().expect("outgoing was checked");
            let transfer_files = outgoing
                .files
                .into_iter()
                .map(|file| file.file)
                .collect::<Vec<_>>();
            (
                outgoing.transfer_id,
                transfer_files,
                outgoing.recovery_peer_id,
            )
        };
        self.emit(RtcEvent::TransferCompleted {
            transfer_id: completed.0,
            direction: TransferDirection::Send,
            file: summarize_transfer_files(&completed.1),
            files: completed.1,
            blake3: batch_blake3(&files),
            download_url: None,
        });
        if let Some(peer_id) = completed.2 {
            spawn_local(async move {
                let _ = delete_outgoing_recovery(&peer_id).await;
            });
        }
    }

    fn handle_complete(&self, transfer_id: String, bytes: u64, blake3: String) {
        if self.inner.borrow().receive.is_some() {
            self.finish_receive(transfer_id, bytes, blake3);
            return;
        }
        let completed = {
            let mut inner = self.inner.borrow_mut();
            let Some(outgoing) = inner.outgoing.as_ref() else {
                drop(inner);
                self.fail(
                    Some(transfer_id),
                    "completion has no active transfer".to_owned(),
                );
                return;
            };
            if outgoing.transfer_id != transfer_id
                || outgoing.mode != TransferMode::Buffered
                || outgoing.sent_bytes != bytes
                || outgoing.files.len() != 1
                || outgoing.files[0].expected_hash.as_deref() != Some(blake3.as_str())
            {
                drop(inner);
                self.fail(
                    Some(transfer_id),
                    "receiver verification does not match".to_owned(),
                );
                return;
            }
            let outgoing = inner.outgoing.take().expect("outgoing was checked");
            (outgoing.files[0].file.clone(), outgoing.transfer_id)
        };
        self.emit(RtcEvent::TransferCompleted {
            transfer_id: completed.1,
            direction: TransferDirection::Send,
            file: completed.0.clone(),
            files: vec![completed.0],
            blake3,
            download_url: None,
        });
    }

    fn send_transfer_error(&self, transfer_id: &str, code: &str, message: &str) {
        if let Ok(channel) = self.current_data_channel() {
            let _ = send_control_on(
                &channel,
                &ControlMessage::Error {
                    version: CURRENT_PROTOCOL,
                    transfer_id: transfer_id.to_owned(),
                    code: code.to_owned(),
                    message: message.to_owned(),
                },
            );
        }
    }

    fn clear_transfer(&self, transfer_id: &str) {
        let mut inner = self.inner.borrow_mut();
        let mut delete_recovery = false;
        let mut outgoing_recovery_peer = None;
        if inner
            .outgoing
            .as_ref()
            .is_some_and(|state| state.transfer_id == transfer_id)
        {
            outgoing_recovery_peer = inner
                .outgoing
                .take()
                .and_then(|state| state.recovery_peer_id);
        }
        if inner
            .pending_outgoing_recovery
            .as_ref()
            .is_some_and(|state| state.transfer_id == transfer_id)
        {
            outgoing_recovery_peer = inner
                .pending_outgoing_recovery
                .take()
                .map(|state| state.peer_id);
        }
        if inner
            .incoming
            .as_ref()
            .is_some_and(|state| state.transfer_id == transfer_id)
        {
            inner.incoming = None;
            delete_recovery = true;
        }
        if inner
            .pending_recovery
            .as_ref()
            .is_some_and(|state| state.transfer_id == transfer_id)
        {
            inner.pending_recovery = None;
            inner.paused_receive_reason = None;
            delete_recovery = true;
        }
        if inner.restoring_transfer.as_deref() == Some(transfer_id) {
            inner.restoring_transfer = None;
            delete_recovery = true;
        }
        if inner
            .receive
            .as_ref()
            .is_some_and(|state| state.offer.transfer_id == transfer_id)
        {
            inner.receive = None;
            delete_recovery = true;
        }
        drop(inner);
        if delete_recovery {
            let transfer_id = transfer_id.to_owned();
            spawn_local(async move {
                let _ = delete_stream_recovery(&transfer_id).await;
            });
        }
        if let Some(peer_id) = outgoing_recovery_peer {
            spawn_local(async move {
                let _ = delete_outgoing_recovery(&peer_id).await;
            });
        }
    }

    fn current_peer_connection(&self) -> Result<RtcPeerConnection, BrowserPlatformError> {
        self.inner
            .borrow()
            .peer_connection
            .clone()
            .ok_or_else(|| BrowserPlatformError::Browser("PeerConnection is not ready".to_owned()))
    }

    fn current_data_channel(&self) -> Result<RtcDataChannel, BrowserPlatformError> {
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

    fn emit(&self, event: RtcEvent) {
        let callback = self.inner.borrow().callback.clone();
        (callback.borrow_mut())(event);
    }

    fn queue_or_emit_local_candidate(&self, signal: Signal) {
        let mut emit_to = None;
        let mut overflowed = false;
        {
            let mut inner = self.inner.borrow_mut();
            let Some(target_peer) = inner.target_peer.clone() else {
                return;
            };
            if inner.local_description_announced {
                emit_to = Some(target_peer);
            } else if inner.pending_local_candidates.len() < NEGOTIATION_SIGNAL_LIMIT {
                inner.pending_local_candidates.push(signal.clone());
            } else {
                overflowed = true;
            }
        }
        if overflowed {
            self.fail(None, "too many queued local ICE candidates".to_owned());
        } else if let Some(to_peer_id) = emit_to {
            self.emit(RtcEvent::OutboundSignal { to_peer_id, signal });
        }
    }

    fn announce_local_description(&self, to_peer_id: String, signal: Signal) {
        let candidates = {
            let mut inner = self.inner.borrow_mut();
            inner.local_description_announced = true;
            std::mem::take(&mut inner.pending_local_candidates)
        };
        self.emit(RtcEvent::OutboundSignal {
            to_peer_id: to_peer_id.clone(),
            signal,
        });
        for signal in candidates {
            self.emit(RtcEvent::OutboundSignal {
                to_peer_id: to_peer_id.clone(),
                signal,
            });
        }
    }

    fn fail(&self, transfer_id: Option<String>, message: String) {
        self.emit(RtcEvent::TransferFailed {
            transfer_id,
            message,
        });
    }
}

fn rtc_configuration(response: &RtcConfigResponse) -> RtcConfiguration {
    let configuration = RtcConfiguration::new();
    let servers = Array::new();
    for value in &response.ice_servers {
        let server = RtcIceServer::new();
        let urls = Array::new();
        for url in &value.urls {
            urls.push(&JsValue::from_str(url));
        }
        server.set_urls_str_sequence(urls.as_ref());
        if let Some(username) = &value.username {
            server.set_username(username);
        }
        if let Some(credential) = &value.credential {
            server.set_credential(credential);
        }
        servers.push(&server);
    }
    configuration.set_ice_servers(servers.as_ref());
    configuration
}

fn clear_peer_resources(inner: &mut Inner) {
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

fn active_transfer_id(inner: &Inner) -> Option<String> {
    inner
        .outgoing
        .as_ref()
        .map(|state| state.transfer_id.clone())
        .or_else(|| {
            inner
                .pending_outgoing_recovery
                .as_ref()
                .map(|state| state.transfer_id.clone())
        })
        .or_else(|| {
            inner
                .receive
                .as_ref()
                .map(|state| state.offer.transfer_id.clone())
        })
        .or_else(|| {
            inner
                .incoming
                .as_ref()
                .map(|state| state.transfer_id.clone())
        })
        .or_else(|| {
            inner
                .pending_recovery
                .as_ref()
                .map(|state| state.transfer_id.clone())
        })
        .or_else(|| inner.restoring_transfer.clone())
}

fn random_binary_id(prefix: &str) -> (String, [u8; 16]) {
    let mut bytes = [0_u8; 16];
    for byte in &mut bytes {
        *byte = (Math::random() * 256.0) as u8;
    }
    (format_binary_id(prefix, &bytes), bytes)
}

fn map_connection_state(state: RtcPeerConnectionState) -> RtcConnectionPhase {
    match state {
        RtcPeerConnectionState::New => RtcConnectionPhase::New,
        RtcPeerConnectionState::Connecting => RtcConnectionPhase::Connecting,
        RtcPeerConnectionState::Connected => RtcConnectionPhase::Connected,
        RtcPeerConnectionState::Disconnected => RtcConnectionPhase::Disconnected,
        RtcPeerConnectionState::Failed => RtcConnectionPhase::Failed,
        RtcPeerConnectionState::Closed => RtcConnectionPhase::Closed,
        _ => RtcConnectionPhase::Failed,
    }
}

fn description_sdp(value: &JsValue) -> Result<String, BrowserPlatformError> {
    Reflect::get(value, &JsValue::from_str("sdp"))
        .map_err(browser_error)?
        .as_string()
        .ok_or_else(|| BrowserPlatformError::Decode("RTC description has no SDP".to_owned()))
}

fn protocol_error(error: p2p_protocol::ProtocolError) -> BrowserPlatformError {
    BrowserPlatformError::Decode(error.to_string())
}

fn browser_error(value: JsValue) -> BrowserPlatformError {
    BrowserPlatformError::Browser(value.as_string().unwrap_or_else(|| format!("{value:?}")))
}

fn reconnectable_channel_error(error: &BrowserPlatformError) -> bool {
    let message = error.to_string();
    message.contains("RTCDataChannel")
        || message.contains("DataChannel is not open")
        || message.contains("DataChannel is not ready")
}

fn prepare_outgoing(
    files: Vec<BrowserFile>,
    recovery_peer_id: Option<String>,
) -> Result<(OutgoingState, ControlMessage, Vec<TransferFile>), BrowserPlatformError> {
    let metadata = files.iter().map(BrowserFile::metadata).collect::<Vec<_>>();
    let plan = plan_transfer(&metadata).map_err(|error| {
        let message = match error {
            TransferPlanError::InvalidFileCount => {
                format!("select between 1 and {MAX_FILES_PER_MANIFEST} files")
            }
            TransferPlanError::SizeOverflow => "transfer size overflow".to_owned(),
            TransferPlanError::TransferTooLarge => {
                format!("files exceed the {MAX_TRANSFER_BYTES} byte transfer limit")
            }
        };
        BrowserPlatformError::Browser(message)
    })?;
    let total_bytes = plan.total_bytes;
    let mode = plan.mode;
    let (transfer_id, transfer_bytes) = random_binary_id("transfer");
    let outgoing_files = files
        .into_iter()
        .zip(metadata.iter().cloned())
        .map(|(file, metadata)| {
            let (file_id, file_bytes) = random_binary_id("file");
            let last_modified_ms = file.last_modified_ms();
            (
                FileManifest {
                    file_id,
                    name: metadata.name.clone(),
                    mime: metadata.mime.clone(),
                    size_bytes: metadata.size_bytes,
                },
                OutgoingFileState {
                    file_bytes,
                    file: metadata,
                    browser_file: file.inner,
                    source_handle: file.source_handle,
                    last_modified_ms,
                    expected_hash: None,
                    committed_bytes: 0,
                    committed_hasher: Box::new(Hasher::new()),
                    last_segment_blake3: None,
                },
            )
        })
        .collect::<Vec<_>>();
    let message = ControlMessage::Manifest {
        version: CURRENT_PROTOCOL,
        transfer_id: transfer_id.clone(),
        mode,
        files: outgoing_files
            .iter()
            .map(|(manifest, _)| manifest.clone())
            .collect(),
    };
    message.validate().map_err(protocol_error)?;
    let outgoing = OutgoingState {
        transfer_id,
        transfer_bytes,
        mode,
        files: outgoing_files.into_iter().map(|(_, state)| state).collect(),
        total_bytes,
        sent_bytes: 0,
        expected_digests: Vec::new(),
        accepted: false,
        stream_ready: None,
        pending_ack: None,
        generation: 0,
        sending: false,
        cancelled: false,
        last_progress_ms: 0.0,
        max_buffered_bytes: 0,
        recovery_peer_id,
        restored_from_disk: false,
        reconciling_resume: false,
    };
    Ok((outgoing, message, metadata))
}
