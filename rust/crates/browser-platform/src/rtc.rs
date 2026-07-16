use p2p_protocol::{CancelReason, RtcConfigResponse, Signal, StreamPauseReason};

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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TransferDirection {
    Send,
    Receive,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TransferFile {
    pub name: String,
    pub mime: Option<String>,
    pub size_bytes: u64,
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
mod browser {
    use std::{cell::RefCell, rc::Rc};

    use blake3::Hasher;
    use futures_channel::oneshot;
    use futures_util::{
        FutureExt,
        future::{Either, select},
        pin_mut,
    };
    use gloo_timers::future::TimeoutFuture;
    use js_sys::{Array, ArrayBuffer, Date, Math, Reflect, Uint8Array};
    use p2p_protocol::{
        BinaryChunkHeader, CURRENT_PROTOCOL, ControlMessage, FileDigest, FileManifest,
        MAX_BUFFERED_TRANSFER_BYTES, MAX_FILES_PER_MANIFEST, MAX_TRANSFER_BYTES, ResumeCursor,
        TransferMode, Validate, decode_binary_frame, parse_control_message,
    };
    use p2p_transfer::{
        BackpressurePolicy, ChunkPlan, DEFAULT_STREAM_ACK_WINDOW_BYTES, DEFAULT_STREAM_CHUNK_BYTES,
        DEFAULT_STREAM_SEGMENT_BYTES, SegmentPlan,
    };
    use wasm_bindgen::{JsCast, JsValue, closure::Closure};
    use wasm_bindgen_futures::{JsFuture, spawn_local};
    use web_sys::{
        Blob, BlobPropertyBag, Event, File, HtmlInputElement, MessageEvent, RtcConfiguration,
        RtcDataChannel, RtcDataChannelEvent, RtcDataChannelState, RtcDataChannelType,
        RtcIceCandidate, RtcIceCandidateInit, RtcIceServer, RtcPeerConnection,
        RtcPeerConnectionIceEvent, RtcPeerConnectionState, RtcSdpType, RtcSessionDescriptionInit,
        Url,
    };

    use super::{
        BrowserPlatformError, CancelReason, RtcConfigResponse, RtcConnectionPhase, RtcEvent,
        Signal, StreamPauseReason, StreamingFileWriter, TransferDirection, TransferFile,
    };
    use crate::{
        BrowserStorageErrorKind,
        source_storage::{
            SourceFilePermission, choose_source_files,
            persistent_source_file_support as source_file_support, recover_source_file,
            source_file_permissions,
        },
        stream_recovery::{
            OutgoingRecoveryFile, OutgoingRecoveryRecord, StreamRecoveryFile, StreamRecoveryRecord,
            delete_outgoing_recovery, delete_stream_recovery, load_outgoing_recovery,
            load_stream_recovery, save_outgoing_recovery, save_stream_recovery,
        },
        stream_storage::{
            StreamFilePermission, StreamingFileAbortHandle, reopen_stream_file,
            stream_file_permissions,
        },
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

    pub async fn choose_persistent_source_files() -> Result<Vec<BrowserFile>, BrowserPlatformError>
    {
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

    #[derive(Clone)]
    struct IncomingFile {
        file_bytes: [u8; 16],
        file: TransferFile,
    }

    #[derive(Clone)]
    struct IncomingOffer {
        transfer_id: String,
        transfer_bytes: [u8; 16],
        mode: TransferMode,
        files: Vec<IncomingFile>,
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
                || inner.receive.as_ref().is_some_and(|receive| {
                    matches!(receive.offer.mode, TransferMode::Streamed { .. })
                })
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

        pub async fn offer_persistent_files(
            &self,
            files: Vec<BrowserFile>,
        ) -> Result<String, BrowserPlatformError> {
            let peer_id = self.inner.borrow().target_peer.clone().ok_or_else(|| {
                BrowserPlatformError::Browser("receiver peer is unavailable".to_owned())
            })?;
            let mut prepared = prepare_outgoing(files, Some(peer_id.clone()))?;
            if matches!(prepared.0.mode, TransferMode::Buffered) {
                prepared.0.recovery_peer_id = None;
            } else {
                let recovery = outgoing_recovery_record(&prepared.0).ok_or_else(|| {
                    BrowserPlatformError::Browser(
                        "selected files cannot be restored after a refresh".to_owned(),
                    )
                })?;
                save_outgoing_recovery(&recovery).await?;
            }
            match self.install_and_offer_outgoing(prepared) {
                Ok(transfer_id) => Ok(transfer_id),
                Err(error) => {
                    let _ = delete_outgoing_recovery(&peer_id).await;
                    Err(error)
                }
            }
        }

        pub async fn restore_outgoing_transfer(
            &self,
            peer_id: &str,
        ) -> Result<bool, BrowserPlatformError> {
            {
                let mut inner = self.inner.borrow_mut();
                if inner.outgoing.is_some()
                    || inner.pending_outgoing_recovery.is_some()
                    || inner.restoring_outgoing
                {
                    return Ok(false);
                }
                inner.restoring_outgoing = true;
            }
            let recovery = match load_outgoing_recovery(peer_id).await {
                Ok(Some(recovery)) if recovery.peer_id == peer_id => recovery,
                Ok(Some(_)) => {
                    let _ = delete_outgoing_recovery(peer_id).await;
                    self.inner.borrow_mut().restoring_outgoing = false;
                    return Ok(false);
                }
                Ok(None) => {
                    self.inner.borrow_mut().restoring_outgoing = false;
                    return Ok(false);
                }
                Err(error) => {
                    self.inner.borrow_mut().restoring_outgoing = false;
                    return Err(error);
                }
            };
            let handles = recovery
                .files
                .iter()
                .map(|file| file.handle.clone())
                .collect::<Vec<_>>();
            match source_file_permissions(&handles, false).await {
                Ok(permissions)
                    if permissions
                        .iter()
                        .all(|permission| *permission == SourceFilePermission::Granted) =>
                {
                    if let Err(error) = self.restore_outgoing_recovery(recovery.clone()).await {
                        let _ = delete_outgoing_recovery(peer_id).await;
                        self.inner.borrow_mut().restoring_outgoing = false;
                        return Err(error);
                    }
                }
                Ok(permissions) if permissions.contains(&SourceFilePermission::Prompt) => {
                    let files = recovery_transfer_files(&recovery);
                    let summary = summarize_transfer_files(&files);
                    {
                        let mut inner = self.inner.borrow_mut();
                        inner.restoring_outgoing = false;
                        inner.pending_outgoing_recovery = Some(recovery.clone());
                    }
                    self.emit(RtcEvent::OutgoingRecoveryOffered {
                        transfer_id: recovery.transfer_id,
                        file: summary,
                        files,
                    });
                }
                Ok(_) | Err(_) => {
                    let _ = delete_outgoing_recovery(peer_id).await;
                    self.inner.borrow_mut().restoring_outgoing = false;
                    return Ok(false);
                }
            }
            Ok(true)
        }

        pub async fn resume_outgoing_transfer(&self) -> Result<(), BrowserPlatformError> {
            let recovery = {
                let mut inner = self.inner.borrow_mut();
                if inner.restoring_outgoing {
                    return Err(BrowserPlatformError::Browser(
                        "source file recovery is already running".to_owned(),
                    ));
                }
                let recovery = inner.pending_outgoing_recovery.take().ok_or_else(|| {
                    BrowserPlatformError::Browser(
                        "saved source files are no longer available".to_owned(),
                    )
                })?;
                inner.restoring_outgoing = true;
                recovery
            };
            let handles = recovery
                .files
                .iter()
                .map(|file| file.handle.clone())
                .collect::<Vec<_>>();
            let permissions = source_file_permissions(&handles, true).await;
            if !matches!(
                permissions.as_deref(),
                Ok(values) if values.iter().all(|value| *value == SourceFilePermission::Granted)
            ) {
                let mut inner = self.inner.borrow_mut();
                inner.restoring_outgoing = false;
                inner.pending_outgoing_recovery = Some(recovery);
                return match permissions {
                    Ok(_) => Err(BrowserPlatformError::Browser(
                        "未获得原文件的读取权限".to_owned(),
                    )),
                    Err(error) => Err(error),
                };
            }
            if let Err(error) = self.restore_outgoing_recovery(recovery.clone()).await {
                let mut inner = self.inner.borrow_mut();
                inner.restoring_outgoing = false;
                inner.pending_outgoing_recovery = Some(recovery);
                return Err(error);
            }
            Ok(())
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

        async fn restore_outgoing_recovery(
            &self,
            recovery: OutgoingRecoveryRecord,
        ) -> Result<(), BrowserPlatformError> {
            let transfer_bytes =
                parse_binary_id(&recovery.transfer_id, "transfer").ok_or_else(|| {
                    BrowserPlatformError::Browser(
                        "saved outgoing transfer id is invalid".to_owned(),
                    )
                })?;
            if recovery.segment_bytes == 0
                || recovery.files.is_empty()
                || recovery.files.len() > MAX_FILES_PER_MANIFEST
            {
                return Err(BrowserPlatformError::Browser(
                    "saved outgoing manifest is invalid".to_owned(),
                ));
            }
            let mut total_bytes = 0_u64;
            let mut incomplete_seen = false;
            let mut files = Vec::with_capacity(recovery.files.len());
            for saved in &recovery.files {
                let file_bytes = parse_binary_id(&saved.file_id, "file").ok_or_else(|| {
                    BrowserPlatformError::Browser("saved outgoing file id is invalid".to_owned())
                })?;
                let checkpoint_valid = saved.committed_bytes <= saved.size_bytes
                    && (saved.committed_bytes == saved.size_bytes
                        || saved.committed_bytes % u64::from(recovery.segment_bytes) == 0)
                    && (!incomplete_seen || saved.committed_bytes == 0);
                let hash_valid = (saved.committed_bytes == 0
                    && saved.last_segment_blake3.is_none())
                    || (saved.committed_bytes > 0
                        && saved
                            .last_segment_blake3
                            .as_deref()
                            .is_some_and(valid_blake3));
                if !checkpoint_valid || !hash_valid {
                    return Err(BrowserPlatformError::Browser(
                        "saved outgoing checkpoint is invalid".to_owned(),
                    ));
                }
                if saved.committed_bytes < saved.size_bytes {
                    incomplete_seen = true;
                }
                let recovered = recover_source_file(
                    saved.handle.clone(),
                    &saved.name,
                    saved.mime.as_deref(),
                    saved.size_bytes,
                    saved.last_modified_ms,
                    saved.committed_bytes,
                    recovery.segment_bytes,
                )
                .await?;
                if recovered.last_segment_blake3 != saved.last_segment_blake3 {
                    return Err(BrowserPlatformError::Browser(
                        "source file no longer matches the saved checkpoint".to_owned(),
                    ));
                }
                total_bytes = total_bytes.checked_add(saved.size_bytes).ok_or_else(|| {
                    BrowserPlatformError::Browser("saved transfer size overflow".to_owned())
                })?;
                files.push(OutgoingFileState {
                    file_bytes,
                    file: TransferFile {
                        name: saved.name.clone(),
                        mime: saved.mime.clone(),
                        size_bytes: saved.size_bytes,
                    },
                    browser_file: recovered.file,
                    source_handle: Some(saved.handle.clone()),
                    last_modified_ms: saved.last_modified_ms,
                    expected_hash: None,
                    committed_bytes: saved.committed_bytes,
                    committed_hasher: Box::new(recovered.hasher),
                    last_segment_blake3: recovered.last_segment_blake3,
                });
            }
            if total_bytes > MAX_TRANSFER_BYTES {
                return Err(BrowserPlatformError::Browser(
                    "saved transfer exceeds the transfer limit".to_owned(),
                ));
            }
            let metadata = files
                .iter()
                .map(|file| file.file.clone())
                .collect::<Vec<_>>();
            let outgoing = OutgoingState {
                transfer_id: recovery.transfer_id.clone(),
                transfer_bytes,
                mode: TransferMode::Streamed {
                    segment_bytes: recovery.segment_bytes,
                },
                sent_bytes: files.iter().map(|file| file.committed_bytes).sum(),
                files,
                total_bytes,
                expected_digests: Vec::new(),
                accepted: false,
                stream_ready: None,
                pending_ack: None,
                generation: 0,
                sending: false,
                cancelled: false,
                last_progress_ms: 0.0,
                max_buffered_bytes: 0,
                recovery_peer_id: Some(recovery.peer_id),
                restored_from_disk: true,
                reconciling_resume: false,
            };
            manifest_from_outgoing(&outgoing)
                .validate()
                .map_err(protocol_error)?;
            {
                let mut inner = self.inner.borrow_mut();
                if inner.outgoing.is_some() || inner.incoming.is_some() || inner.receive.is_some() {
                    return Err(BrowserPlatformError::Browser(
                        "another transfer is already active".to_owned(),
                    ));
                }
                inner.restoring_outgoing = false;
                inner.pending_outgoing_recovery = None;
                inner.outgoing = Some(outgoing);
            }
            self.emit(RtcEvent::OutgoingOffered {
                transfer_id: recovery.transfer_id,
                file: summarize_transfer_files(&metadata),
                files: metadata,
            });
            if self.data_channel_ready() {
                self.data_channel_opened();
            }
            Ok(())
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
                    file: summarize_incoming_files(&offer.files),
                    files: incoming_transfer_files(&offer.files),
                });
                let transfer_id = transfer_id.to_owned();
                spawn_local(async move {
                    let _ = delete_stream_recovery(&transfer_id).await;
                });
            }
            Ok(())
        }

        pub async fn accept_stream_transfer(
            &self,
            transfer_id: &str,
            writers: Vec<StreamingFileWriter>,
        ) -> Result<(), BrowserPlatformError> {
            let channel = self.current_data_channel()?;
            let (offer, peer_id) = {
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
                if !matches!(offer.mode, TransferMode::Streamed { .. }) {
                    inner.incoming = Some(offer);
                    return Err(BrowserPlatformError::Browser(
                        "incoming transfer does not use streaming mode".to_owned(),
                    ));
                }
                let peer_id = inner.target_peer.clone().ok_or_else(|| {
                    BrowserPlatformError::Browser("receiver peer is unavailable".to_owned())
                })?;
                inner.pending_recovery = None;
                inner.paused_receive_reason = None;
                (offer, peer_id)
            };
            if writers.len() != offer.files.len() {
                self.inner.borrow_mut().incoming = Some(offer);
                return Err(BrowserPlatformError::Browser(
                    "streaming destination count does not match the manifest".to_owned(),
                ));
            }
            let TransferMode::Streamed { segment_bytes } = offer.mode else {
                unreachable!("streaming mode was checked");
            };
            let current_file_index = offer
                .files
                .iter()
                .position(|file| file.file.size_bytes > 0)
                .unwrap_or(offer.files.len());
            let recovery_record = recovery_record_from_writers(&offer, &peer_id, &writers);
            let recovery_persisted = save_stream_recovery(&recovery_record).await.is_ok();
            if !recovery_persisted {
                let _ = delete_stream_recovery(transfer_id).await;
            }
            send_control_on(
                &channel,
                &ControlMessage::Decision {
                    version: CURRENT_PROTOCOL,
                    transfer_id: transfer_id.to_owned(),
                    accepted: true,
                },
            )?;
            send_control_on(
                &channel,
                &ControlMessage::StreamReady {
                    version: CURRENT_PROTOCOL,
                    transfer_id: transfer_id.to_owned(),
                    max_chunk_bytes: DEFAULT_STREAM_CHUNK_BYTES as u32,
                    ack_window_bytes: DEFAULT_STREAM_ACK_WINDOW_BYTES.min(u64::from(segment_bytes)),
                    resume: Vec::<ResumeCursor>::new(),
                },
            )?;
            self.inner.borrow_mut().receive = Some(ReceiveState {
                offer,
                started: false,
                received_bytes: 0,
                payload: ReceivePayload::Streamed {
                    segment_bytes,
                    current_file_index,
                    files: writers
                        .into_iter()
                        .map(|writer| ReceiveFileState {
                            writer: Some(writer),
                            active_abort: None,
                            received_bytes: 0,
                            hasher: Box::new(Hasher::new()),
                            segment_index: 0,
                            segment_offset: 0,
                            chunks: Vec::new(),
                            segment_hasher: Box::new(Hasher::new()),
                            committed_hasher: Box::new(Hasher::new()),
                            last_segment_blake3: None,
                            writing: false,
                        })
                        .collect(),
                },
                hasher: Hasher::new(),
                resume_requested: false,
                last_progress_ms: 0.0,
                recovery_persisted,
                generation: 0,
            });
            Ok(())
        }

        pub async fn resume_stream_transfer(
            &self,
            transfer_id: &str,
        ) -> Result<(), BrowserPlatformError> {
            let (offer, recovery) = {
                let mut inner = self.inner.borrow_mut();
                if inner.restoring_transfer.as_deref() == Some(transfer_id) {
                    return Ok(());
                }
                let offer = inner.incoming.take().ok_or_else(|| {
                    BrowserPlatformError::Browser(
                        "incoming recovery offer is no longer available".to_owned(),
                    )
                })?;
                let recovery = inner.pending_recovery.take().ok_or_else(|| {
                    inner.incoming = Some(offer.clone());
                    BrowserPlatformError::Browser(
                        "saved streaming recovery is no longer available".to_owned(),
                    )
                })?;
                if offer.transfer_id != transfer_id || recovery.transfer_id != transfer_id {
                    inner.incoming = Some(offer);
                    inner.pending_recovery = Some(recovery);
                    return Err(BrowserPlatformError::Browser(
                        "streaming recovery id does not match".to_owned(),
                    ));
                }
                inner.restoring_transfer = Some(transfer_id.to_owned());
                (offer, recovery)
            };
            let handles = recovery
                .files
                .iter()
                .map(|file| file.handle.clone())
                .collect::<Vec<_>>();
            let permissions = stream_file_permissions(&handles, true).await;
            if !matches!(
                permissions.as_deref(),
                Ok(values) if values.iter().all(|value| *value == StreamFilePermission::Granted)
            ) {
                let mut inner = self.inner.borrow_mut();
                inner.restoring_transfer = None;
                inner.incoming = Some(offer);
                inner.pending_recovery = Some(recovery);
                return match permissions {
                    Ok(_) => Err(BrowserPlatformError::Browser(
                        "未获得原保存位置的写入权限".to_owned(),
                    )),
                    Err(error) => Err(error),
                };
            }
            if let Err(error) = self
                .restore_stream_recovery(offer.clone(), recovery.clone())
                .await
            {
                let mut inner = self.inner.borrow_mut();
                inner.restoring_transfer = None;
                inner.incoming = Some(offer);
                inner.pending_recovery = Some(recovery);
                return Err(error);
            }
            Ok(())
        }

        pub async fn cancel_transfer(
            &self,
            reason: CancelReason,
        ) -> Result<(), BrowserPlatformError> {
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
                        prepare_receive_reconnect(receive);
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
                prepare_receive_reconnect(receive);
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
            let on_data_channel = Closure::<dyn FnMut(RtcDataChannelEvent)>::new(
                move |event: RtcDataChannelEvent| {
                    channel_peer.install_data_channel(event.channel());
                },
            );
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

        fn data_channel_opened(&self) {
            self.emit(RtcEvent::DataChannelReady);
            let manifest = {
                let inner = self.inner.borrow();
                inner.outgoing.as_ref().and_then(|outgoing| {
                    (matches!(outgoing.mode, TransferMode::Streamed { .. })
                        && !outgoing.accepted
                        && !outgoing.sending)
                        .then(|| ControlMessage::Manifest {
                            version: CURRENT_PROTOCOL,
                            transfer_id: outgoing.transfer_id.clone(),
                            mode: outgoing.mode,
                            files: outgoing
                                .files
                                .iter()
                                .map(|file| FileManifest {
                                    file_id: format!("file_{}", hex_bytes(&file.file_bytes)),
                                    name: file.file.name.clone(),
                                    mime: file.file.mime.clone(),
                                    size_bytes: file.file.size_bytes,
                                })
                                .collect(),
                        })
                })
            };
            if let Some(manifest) = manifest {
                let result = self
                    .current_data_channel()
                    .and_then(|channel| send_control_on(&channel, &manifest));
                if let Err(error) = result {
                    self.fail(None, error.to_string());
                }
            }
        }

        fn handle_control(&self, message: ControlMessage) {
            match message {
                ControlMessage::Manifest {
                    transfer_id,
                    mode,
                    files,
                    ..
                } => self.handle_manifest(transfer_id, mode, files),
                ControlMessage::Decision {
                    transfer_id,
                    accepted,
                    ..
                } => self.handle_decision(transfer_id, accepted),
                ControlMessage::Start { transfer_id, .. } => {
                    let (event, resumed_bytes, total_bytes) = {
                        let mut inner = self.inner.borrow_mut();
                        let Some(receive) = inner.receive.as_mut() else {
                            drop(inner);
                            self.fail(
                                Some(transfer_id),
                                "transfer started before acceptance".to_owned(),
                            );
                            return;
                        };
                        if receive.offer.transfer_id != transfer_id {
                            drop(inner);
                            self.fail(
                                Some(transfer_id),
                                "transfer start id does not match".to_owned(),
                            );
                            return;
                        }
                        receive.started = true;
                        let files = incoming_transfer_files(&receive.offer.files);
                        let summary = summarize_transfer_files(&files);
                        (
                            RtcEvent::TransferStarted {
                                transfer_id: transfer_id.clone(),
                                direction: TransferDirection::Receive,
                                mode: receive.offer.mode,
                                file: summary,
                                files,
                            },
                            receive.received_bytes,
                            incoming_total_bytes(&receive.offer.files),
                        )
                    };
                    self.emit(event);
                    if resumed_bytes > 0 {
                        self.emit(RtcEvent::TransferProgress {
                            transfer_id,
                            direction: TransferDirection::Receive,
                            completed_bytes: resumed_bytes,
                            total_bytes,
                        });
                    }
                }
                ControlMessage::StreamReady {
                    transfer_id,
                    max_chunk_bytes,
                    ack_window_bytes,
                    resume,
                    ..
                } => {
                    self.handle_stream_ready(transfer_id, max_chunk_bytes, ack_window_bytes, resume)
                }
                ControlMessage::SegmentCommit {
                    transfer_id,
                    file_id,
                    segment_index,
                    offset,
                    bytes,
                    blake3,
                    ..
                } => self.handle_segment_commit(
                    transfer_id,
                    file_id,
                    segment_index,
                    offset,
                    bytes,
                    blake3,
                ),
                ControlMessage::SegmentAck {
                    transfer_id,
                    file_id,
                    segment_index,
                    committed_bytes,
                    blake3,
                    ..
                } => self.handle_segment_ack(
                    transfer_id,
                    file_id,
                    segment_index,
                    committed_bytes,
                    blake3,
                ),
                ControlMessage::StreamPaused {
                    transfer_id,
                    reason,
                    ..
                } => self.handle_stream_paused(transfer_id, reason),
                ControlMessage::StreamComplete {
                    transfer_id,
                    total_bytes,
                    files,
                    ..
                } => self.handle_stream_complete(transfer_id, total_bytes, files),
                ControlMessage::Cancel {
                    transfer_id,
                    reason,
                    ..
                } => {
                    self.clear_transfer(&transfer_id);
                    self.emit(RtcEvent::TransferCancelled {
                        transfer_id,
                        reason,
                    });
                }
                ControlMessage::Complete {
                    transfer_id,
                    bytes,
                    blake3,
                    ..
                } => self.handle_complete(transfer_id, bytes, blake3),
                ControlMessage::Error {
                    transfer_id,
                    message,
                    ..
                } => {
                    self.clear_transfer(&transfer_id);
                    self.fail(Some(transfer_id), message);
                }
            }
        }

        fn handle_manifest(
            &self,
            transfer_id: String,
            mode: TransferMode,
            files: Vec<FileManifest>,
        ) {
            let Some(transfer_bytes) = parse_binary_id(&transfer_id, "transfer") else {
                self.send_transfer_error(&transfer_id, "invalid_id", "invalid transfer id");
                return;
            };
            let incoming_files = files
                .iter()
                .map(|file| {
                    parse_binary_id(&file.file_id, "file").map(|file_bytes| IncomingFile {
                        file_bytes,
                        file: TransferFile {
                            name: file.name.clone(),
                            mime: file.mime.clone(),
                            size_bytes: file.size_bytes,
                        },
                    })
                })
                .collect::<Option<Vec<_>>>();
            let Some(incoming_files) = incoming_files else {
                self.send_transfer_error(&transfer_id, "invalid_id", "invalid file id");
                return;
            };
            if mode == TransferMode::Buffered && incoming_files.len() != 1 {
                self.send_transfer_error(
                    &transfer_id,
                    "buffered_batch_unsupported",
                    "batch manifests must use streaming mode",
                );
                return;
            }
            let offer = IncomingOffer {
                transfer_id: transfer_id.clone(),
                transfer_bytes,
                mode,
                files: incoming_files,
            };
            let mut resume_now = false;
            let mut resume_after_write = false;
            let mut busy = false;
            let mut invalid_resume = false;
            let mut restore_new = false;
            let mut paused_reason = None;
            {
                let mut inner = self.inner.borrow_mut();
                if let Some(receive) = inner.receive.as_mut() {
                    let matches_existing = incoming_offer_matches(&receive.offer, &offer)
                        && matches!(receive.offer.mode, TransferMode::Streamed { .. });
                    if !matches_existing {
                        invalid_resume = true;
                    } else if let ReceivePayload::Streamed { files, .. } = &receive.payload {
                        receive.started = false;
                        if files.iter().any(|file| file.writing) {
                            receive.resume_requested = true;
                            resume_after_write = true;
                        } else {
                            resume_now = true;
                        }
                    }
                } else if let Some(existing) = inner.incoming.as_ref()
                    && inner.pending_recovery.is_some()
                    && let Some(reason) = inner.paused_receive_reason
                {
                    if incoming_offer_matches(existing, &offer) {
                        paused_reason = Some(reason);
                    } else {
                        invalid_resume = true;
                    }
                } else if inner.outgoing.is_some()
                    || inner.incoming.is_some()
                    || inner.restoring_transfer.is_some()
                {
                    busy = true;
                } else {
                    inner.restoring_transfer = Some(transfer_id.clone());
                    restore_new = true;
                }
            }
            if invalid_resume {
                self.send_transfer_error(
                    &transfer_id,
                    "resume_mismatch",
                    "streaming resume manifest does not match the active transfer",
                );
            } else if busy {
                self.send_transfer_error(&transfer_id, "busy", "another transfer is active");
            } else if let Some(reason) = paused_reason {
                if let Ok(channel) = self.current_data_channel() {
                    let _ = send_control_on(
                        &channel,
                        &ControlMessage::StreamPaused {
                            version: CURRENT_PROTOCOL,
                            transfer_id,
                            reason,
                        },
                    );
                }
            } else if resume_now {
                if let Err(error) = self.send_stream_resume(&transfer_id) {
                    self.fail(Some(transfer_id), error.to_string());
                }
            } else if resume_after_write {
                // The writer task will answer once its current verified segment reaches disk.
            } else if restore_new {
                let peer = self.clone();
                spawn_local(async move {
                    peer.recover_or_offer_stream(offer).await;
                });
            }
        }

        async fn recover_or_offer_stream(&self, offer: IncomingOffer) {
            if !matches!(offer.mode, TransferMode::Streamed { .. }) {
                self.publish_incoming_offer(offer, None);
                return;
            }
            let peer_id = self.inner.borrow().target_peer.clone();
            let recovery = match load_stream_recovery(&offer.transfer_id).await {
                Ok(Some(recovery))
                    if peer_id.as_deref().is_some_and(|peer_id| {
                        stream_recovery_matches(&offer, peer_id, &recovery)
                    }) =>
                {
                    Some(recovery)
                }
                Ok(Some(_)) | Err(_) => {
                    let _ = delete_stream_recovery(&offer.transfer_id).await;
                    None
                }
                Ok(None) => None,
            };
            let Some(recovery) = recovery else {
                self.publish_incoming_offer(offer, None);
                return;
            };
            let handles = recovery
                .files
                .iter()
                .map(|file| file.handle.clone())
                .collect::<Vec<_>>();
            match stream_file_permissions(&handles, false).await {
                Ok(permissions)
                    if permissions
                        .iter()
                        .all(|permission| *permission == StreamFilePermission::Granted) =>
                {
                    if self
                        .restore_stream_recovery(offer.clone(), recovery)
                        .await
                        .is_err()
                    {
                        let _ = delete_stream_recovery(&offer.transfer_id).await;
                        self.publish_incoming_offer(offer, None);
                    }
                }
                Ok(permissions) if permissions.contains(&StreamFilePermission::Prompt) => {
                    self.publish_incoming_offer(offer, Some(recovery));
                }
                Ok(_) | Err(_) => {
                    let _ = delete_stream_recovery(&offer.transfer_id).await;
                    self.publish_incoming_offer(offer, None);
                }
            }
        }

        fn publish_incoming_offer(
            &self,
            offer: IncomingOffer,
            recovery: Option<StreamRecoveryRecord>,
        ) {
            let recovery_available = recovery.is_some();
            {
                let mut inner = self.inner.borrow_mut();
                if inner.restoring_transfer.as_deref() != Some(offer.transfer_id.as_str())
                    || inner.outgoing.is_some()
                    || inner.incoming.is_some()
                    || inner.receive.is_some()
                {
                    return;
                }
                inner.restoring_transfer = None;
                inner.pending_recovery = recovery;
                inner.paused_receive_reason = None;
                inner.incoming = Some(offer.clone());
            }
            let files = incoming_transfer_files(&offer.files);
            self.emit(RtcEvent::IncomingOffered {
                transfer_id: offer.transfer_id,
                mode: offer.mode,
                file: summarize_transfer_files(&files),
                files,
                recovery_available,
            });
        }

        async fn restore_stream_recovery(
            &self,
            offer: IncomingOffer,
            recovery: StreamRecoveryRecord,
        ) -> Result<(), BrowserPlatformError> {
            let TransferMode::Streamed { segment_bytes } = offer.mode else {
                return Err(BrowserPlatformError::Browser(
                    "saved recovery does not use streaming mode".to_owned(),
                ));
            };
            let mut files = Vec::with_capacity(recovery.files.len());
            for (offer_file, recovery_file) in offer.files.iter().zip(&recovery.files) {
                let committed_bytes = recovery_file.committed_bytes;
                if committed_bytes > offer_file.file.size_bytes
                    || (committed_bytes < offer_file.file.size_bytes
                        && committed_bytes % u64::from(segment_bytes) != 0)
                {
                    return Err(BrowserPlatformError::Browser(
                        "saved recovery checkpoint is outside a verified segment".to_owned(),
                    ));
                }
                let recovered = reopen_stream_file(
                    recovery_file.handle.clone(),
                    committed_bytes,
                    offer_file.file.size_bytes,
                    segment_bytes,
                )
                .await?;
                if recovered.last_segment_blake3 != recovery_file.last_segment_blake3 {
                    return Err(BrowserPlatformError::Browser(
                        "saved file no longer matches the recovery checkpoint".to_owned(),
                    ));
                }
                let segment_index = if committed_bytes == 0 {
                    0
                } else {
                    committed_bytes.div_ceil(u64::from(segment_bytes))
                };
                files.push(ReceiveFileState {
                    writer: Some(recovered.writer),
                    active_abort: None,
                    received_bytes: committed_bytes,
                    hasher: Box::new(recovered.hasher.clone()),
                    segment_index,
                    segment_offset: committed_bytes,
                    chunks: Vec::new(),
                    segment_hasher: Box::new(Hasher::new()),
                    committed_hasher: Box::new(recovered.hasher),
                    last_segment_blake3: recovered.last_segment_blake3,
                    writing: false,
                });
            }
            if files.len() != offer.files.len() {
                return Err(BrowserPlatformError::Browser(
                    "saved recovery file count does not match".to_owned(),
                ));
            }
            let received_bytes = files.iter().map(|file| file.received_bytes).sum();
            let current_file_index = offer
                .files
                .iter()
                .zip(&files)
                .position(|(offer, state)| state.segment_offset < offer.file.size_bytes)
                .unwrap_or(offer.files.len());
            {
                let mut inner = self.inner.borrow_mut();
                if inner.restoring_transfer.as_deref() != Some(offer.transfer_id.as_str())
                    || inner.outgoing.is_some()
                    || inner.receive.is_some()
                {
                    return Err(BrowserPlatformError::Browser(
                        "streaming recovery is no longer active".to_owned(),
                    ));
                }
                inner.restoring_transfer = None;
                inner.incoming = None;
                inner.pending_recovery = None;
                inner.paused_receive_reason = None;
                inner.receive = Some(ReceiveState {
                    offer: offer.clone(),
                    started: false,
                    received_bytes,
                    payload: ReceivePayload::Streamed {
                        segment_bytes,
                        current_file_index,
                        files,
                    },
                    hasher: Hasher::new(),
                    resume_requested: false,
                    last_progress_ms: 0.0,
                    recovery_persisted: true,
                    generation: 0,
                });
            }
            if let Err(error) = self.send_stream_resume(&offer.transfer_id) {
                let mut inner = self.inner.borrow_mut();
                if inner
                    .receive
                    .as_ref()
                    .is_some_and(|receive| receive.offer.transfer_id == offer.transfer_id)
                {
                    inner.receive = None;
                    inner.restoring_transfer = Some(offer.transfer_id.clone());
                }
                return Err(error);
            }
            Ok(())
        }

        fn send_stream_resume(&self, transfer_id: &str) -> Result<(), BrowserPlatformError> {
            let (segment_bytes, resume) = {
                let inner = self.inner.borrow();
                let receive = inner.receive.as_ref().ok_or_else(|| {
                    BrowserPlatformError::Browser("streaming receiver is unavailable".to_owned())
                })?;
                if receive.offer.transfer_id != transfer_id {
                    return Err(BrowserPlatformError::Browser(
                        "streaming receiver id does not match".to_owned(),
                    ));
                }
                let ReceivePayload::Streamed {
                    segment_bytes,
                    files,
                    ..
                } = &receive.payload
                else {
                    return Err(BrowserPlatformError::Browser(
                        "streaming receiver mode does not match".to_owned(),
                    ));
                };
                let resume = receive
                    .offer
                    .files
                    .iter()
                    .zip(files)
                    .map(|(offer, state)| ResumeCursor {
                        file_id: format!("file_{}", hex_bytes(&offer.file_bytes)),
                        committed_bytes: state.segment_offset,
                        last_segment_blake3: state.last_segment_blake3.clone(),
                    })
                    .collect();
                (*segment_bytes, resume)
            };
            let channel = self.current_data_channel()?;
            send_control_on(
                &channel,
                &ControlMessage::Decision {
                    version: CURRENT_PROTOCOL,
                    transfer_id: transfer_id.to_owned(),
                    accepted: true,
                },
            )?;
            send_control_on(
                &channel,
                &ControlMessage::StreamReady {
                    version: CURRENT_PROTOCOL,
                    transfer_id: transfer_id.to_owned(),
                    max_chunk_bytes: DEFAULT_STREAM_CHUNK_BYTES as u32,
                    ack_window_bytes: DEFAULT_STREAM_ACK_WINDOW_BYTES.min(u64::from(segment_bytes)),
                    resume,
                },
            )
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

        fn handle_stream_ready(
            &self,
            transfer_id: String,
            max_chunk_bytes: u32,
            ack_window_bytes: u64,
            resume: Vec<ResumeCursor>,
        ) {
            let needs_reconciliation = {
                let mut inner = self.inner.borrow_mut();
                if let Some(outgoing) = inner.outgoing.as_mut() {
                    if outgoing.transfer_id != transfer_id {
                        false
                    } else if let TransferMode::Streamed { segment_bytes } = outgoing.mode
                        && ack_window_bytes >= u64::from(segment_bytes)
                        && outgoing.restored_from_disk
                    {
                        if outgoing.reconciling_resume {
                            return;
                        }
                        if validate_resume_cursors(outgoing, segment_bytes, &resume).is_ok() {
                            outgoing.restored_from_disk = false;
                            false
                        } else {
                            outgoing.reconciling_resume = true;
                            true
                        }
                    } else {
                        false
                    }
                } else {
                    false
                }
            };
            if needs_reconciliation {
                let peer = self.clone();
                spawn_local(async move {
                    if let Err(error) = peer
                        .reconcile_outgoing_resume(
                            transfer_id.clone(),
                            max_chunk_bytes,
                            ack_window_bytes,
                            resume,
                        )
                        .await
                    {
                        peer.send_transfer_error(
                            &transfer_id,
                            "resume_mismatch",
                            "streaming resume cursor does not match the source files",
                        );
                        peer.clear_transfer(&transfer_id);
                        peer.fail(Some(transfer_id), error.to_string());
                    }
                });
                return;
            }
            let start_generation = {
                let mut inner = self.inner.borrow_mut();
                let Some(outgoing) = inner.outgoing.as_mut() else {
                    drop(inner);
                    self.fail(
                        Some(transfer_id),
                        "stream readiness has no outgoing transfer".to_owned(),
                    );
                    return;
                };
                let TransferMode::Streamed { segment_bytes } = outgoing.mode else {
                    drop(inner);
                    self.fail(
                        Some(transfer_id),
                        "stream readiness was sent for a buffered transfer".to_owned(),
                    );
                    return;
                };
                if outgoing.transfer_id != transfer_id
                    || ack_window_bytes < u64::from(segment_bytes)
                {
                    drop(inner);
                    self.fail(
                        Some(transfer_id),
                        "stream readiness does not match the transfer".to_owned(),
                    );
                    return;
                }
                let cursor_result = validate_resume_cursors(outgoing, segment_bytes, &resume);
                let Ok(promote_pending) = cursor_result else {
                    drop(inner);
                    self.send_transfer_error(
                        &transfer_id,
                        "resume_mismatch",
                        "streaming resume cursor is not a verified batch checkpoint",
                    );
                    return;
                };
                if promote_pending {
                    let mut pending = outgoing
                        .pending_ack
                        .take()
                        .expect("the pending checkpoint was validated");
                    pending.sender.take();
                    let file = &mut outgoing.files[pending.file_index];
                    file.committed_bytes = pending.committed_bytes;
                    file.committed_hasher = pending.file_hasher;
                    file.last_segment_blake3 = Some(pending.blake3);
                } else if let Some(mut pending) = outgoing.pending_ack.take() {
                    pending.sender.take();
                }
                outgoing.sent_bytes = outgoing.files.iter().map(|file| file.committed_bytes).sum();
                outgoing.stream_ready = Some(StreamReadyPlan {
                    max_chunk_bytes,
                    ack_window_bytes,
                });
                let should_start = outgoing.accepted && !outgoing.sending;
                if should_start {
                    outgoing.sending = true;
                }
                should_start.then_some(outgoing.generation)
            };
            if let Some(generation) = start_generation {
                self.spawn_outgoing(transfer_id, generation);
            }
        }

        async fn reconcile_outgoing_resume(
            &self,
            transfer_id: String,
            max_chunk_bytes: u32,
            ack_window_bytes: u64,
            resume: Vec<ResumeCursor>,
        ) -> Result<(), BrowserPlatformError> {
            let mut recovery = {
                let inner = self.inner.borrow();
                let outgoing = inner.outgoing.as_ref().ok_or_else(|| {
                    BrowserPlatformError::Browser("outgoing recovery disappeared".to_owned())
                })?;
                if outgoing.transfer_id != transfer_id
                    || !outgoing.restored_from_disk
                    || !outgoing.reconciling_resume
                {
                    return Err(BrowserPlatformError::Browser(
                        "outgoing recovery is no longer active".to_owned(),
                    ));
                }
                outgoing_recovery_record(outgoing).ok_or_else(|| {
                    BrowserPlatformError::Browser(
                        "outgoing source handles are unavailable".to_owned(),
                    )
                })?
            };
            apply_resume_to_recovery(&mut recovery, &resume)?;
            let mut recovered_files = Vec::with_capacity(recovery.files.len());
            for file in &recovery.files {
                let recovered = recover_source_file(
                    file.handle.clone(),
                    &file.name,
                    file.mime.as_deref(),
                    file.size_bytes,
                    file.last_modified_ms,
                    file.committed_bytes,
                    recovery.segment_bytes,
                )
                .await?;
                if recovered.last_segment_blake3 != file.last_segment_blake3 {
                    return Err(BrowserPlatformError::Browser(
                        "receiver checkpoint does not match the source file".to_owned(),
                    ));
                }
                recovered_files.push(recovered);
            }
            save_outgoing_recovery(&recovery).await?;
            {
                let mut inner = self.inner.borrow_mut();
                let outgoing = inner.outgoing.as_mut().ok_or_else(|| {
                    BrowserPlatformError::Browser("outgoing recovery disappeared".to_owned())
                })?;
                if outgoing.transfer_id != transfer_id
                    || !outgoing.restored_from_disk
                    || !outgoing.reconciling_resume
                    || outgoing.files.len() != recovered_files.len()
                {
                    return Err(BrowserPlatformError::Browser(
                        "outgoing recovery changed while validating files".to_owned(),
                    ));
                }
                for ((state, saved), recovered) in outgoing
                    .files
                    .iter_mut()
                    .zip(&recovery.files)
                    .zip(recovered_files)
                {
                    state.browser_file = recovered.file;
                    state.committed_bytes = saved.committed_bytes;
                    *state.committed_hasher = recovered.hasher;
                    state.last_segment_blake3 = recovered.last_segment_blake3;
                }
                outgoing.sent_bytes = outgoing.files.iter().map(|file| file.committed_bytes).sum();
                outgoing.restored_from_disk = false;
                outgoing.reconciling_resume = false;
            }
            self.handle_stream_ready(transfer_id, max_chunk_bytes, ack_window_bytes, resume);
            Ok(())
        }

        fn spawn_outgoing(&self, transfer_id: String, generation: u64) {
            let peer = self.clone();
            spawn_local(async move {
                if let Err(error) = peer.send_outgoing(transfer_id.clone(), generation).await
                    && peer.outgoing_generation_matches(&transfer_id, generation)
                {
                    if reconnectable_channel_error(&error) {
                        peer.suspend_stream_for_reconnect();
                        peer.emit(RtcEvent::ConnectionState(RtcConnectionPhase::Closed));
                    } else {
                        peer.clear_transfer(&transfer_id);
                        peer.fail(Some(transfer_id), error.to_string());
                    }
                }
            });
        }

        async fn send_outgoing(
            &self,
            transfer_id: String,
            generation: u64,
        ) -> Result<(), BrowserPlatformError> {
            let mode = self
                .inner
                .borrow()
                .outgoing
                .as_ref()
                .ok_or_else(|| {
                    BrowserPlatformError::Browser("outgoing transfer disappeared".to_owned())
                })?
                .mode;
            match mode {
                TransferMode::Buffered => self.send_buffered_outgoing(transfer_id).await,
                TransferMode::Streamed { segment_bytes } => {
                    self.send_streamed_outgoing(transfer_id, segment_bytes, generation)
                        .await
                }
            }
        }

        async fn send_buffered_outgoing(
            &self,
            transfer_id: String,
        ) -> Result<(), BrowserPlatformError> {
            let (browser_file, file, transfer_bytes, file_bytes) = {
                let inner = self.inner.borrow();
                let outgoing = inner.outgoing.as_ref().ok_or_else(|| {
                    BrowserPlatformError::Browser("outgoing transfer disappeared".to_owned())
                })?;
                let outgoing_file = outgoing.files.first().ok_or_else(|| {
                    BrowserPlatformError::Browser("outgoing file disappeared".to_owned())
                })?;
                (
                    outgoing_file.browser_file.clone(),
                    outgoing_file.file.clone(),
                    outgoing.transfer_bytes,
                    outgoing_file.file_bytes,
                )
            };
            let channel = self.current_data_channel()?;
            send_control_on(
                &channel,
                &ControlMessage::Start {
                    version: CURRENT_PROTOCOL,
                    transfer_id: transfer_id.clone(),
                },
            )?;
            self.emit(RtcEvent::TransferStarted {
                transfer_id: transfer_id.clone(),
                direction: TransferDirection::Send,
                mode: TransferMode::Buffered,
                file: file.clone(),
                files: vec![file.clone()],
            });
            TimeoutFuture::new(20).await;

            let policy = BackpressurePolicy::default();
            let plan = ChunkPlan::new(file.size_bytes, policy.chunk_bytes as u32)
                .map_err(|error| BrowserPlatformError::Browser(format!("{error:?}")))?;
            let mut hasher = Hasher::new();
            for index in 0..plan.chunk_count() {
                if self.outgoing_cancelled(&transfer_id) {
                    return Ok(());
                }
                if policy.should_pause(u64::from(channel.buffered_amount())) {
                    wait_for_buffer_low(&channel, policy).await;
                    if self.outgoing_cancelled(&transfer_id) {
                        return Ok(());
                    }
                }
                let descriptor = plan.chunk(index).ok_or_else(|| {
                    BrowserPlatformError::Browser("chunk plan ended early".to_owned())
                })?;
                let end = descriptor.offset + u64::from(descriptor.length);
                let blob = browser_file
                    .slice_with_f64_and_f64(descriptor.offset as f64, end as f64)
                    .map_err(browser_error)?;
                let array_buffer = JsFuture::from(blob.array_buffer())
                    .await
                    .map_err(browser_error)?
                    .dyn_into::<ArrayBuffer>()
                    .map_err(browser_error)?;
                let bytes = Uint8Array::new(&array_buffer).to_vec();
                hasher.update(&bytes);
                let mut frame = BinaryChunkHeader {
                    version: CURRENT_PROTOCOL,
                    transfer_id: transfer_bytes,
                    file_id: file_bytes,
                    offset: descriptor.offset,
                    payload_len: descriptor.length,
                }
                .encode()
                .to_vec();
                frame.extend_from_slice(&bytes);
                channel.send_with_u8_array(&frame).map_err(browser_error)?;
                let now = Date::now();
                let emit_progress = {
                    let mut inner = self.inner.borrow_mut();
                    let outgoing = inner.outgoing.as_mut().ok_or_else(|| {
                        BrowserPlatformError::Browser("outgoing transfer disappeared".to_owned())
                    })?;
                    outgoing.sent_bytes = end;
                    outgoing.max_buffered_bytes = outgoing
                        .max_buffered_bytes
                        .max(u64::from(channel.buffered_amount()));
                    if now - outgoing.last_progress_ms >= PROGRESS_INTERVAL_MS
                        || end == file.size_bytes
                    {
                        outgoing.last_progress_ms = now;
                        true
                    } else {
                        false
                    }
                };
                if emit_progress {
                    self.emit(RtcEvent::TransferProgress {
                        transfer_id: transfer_id.clone(),
                        direction: TransferDirection::Send,
                        completed_bytes: end,
                        total_bytes: file.size_bytes,
                    });
                }
            }
            let digest = hasher.finalize().to_hex().to_string();
            {
                let mut inner = self.inner.borrow_mut();
                let outgoing = inner.outgoing.as_mut().ok_or_else(|| {
                    BrowserPlatformError::Browser("outgoing transfer disappeared".to_owned())
                })?;
                let outgoing_file = outgoing.files.first_mut().ok_or_else(|| {
                    BrowserPlatformError::Browser("outgoing file disappeared".to_owned())
                })?;
                outgoing_file.expected_hash = Some(digest.clone());
            }
            send_control_on(
                &channel,
                &ControlMessage::Complete {
                    version: CURRENT_PROTOCOL,
                    transfer_id: transfer_id.clone(),
                    bytes: file.size_bytes,
                    blake3: digest,
                },
            )?;
            self.emit(RtcEvent::AwaitingVerification {
                transfer_id,
                file: file.clone(),
                files: vec![file],
            });
            Ok(())
        }

        async fn send_streamed_outgoing(
            &self,
            transfer_id: String,
            segment_bytes: u32,
            generation: u64,
        ) -> Result<(), BrowserPlatformError> {
            let (transfer_bytes, ready, total_bytes, sent_bytes, transfer_files) = {
                let inner = self.inner.borrow();
                let outgoing = inner.outgoing.as_ref().ok_or_else(|| {
                    BrowserPlatformError::Browser("outgoing transfer disappeared".to_owned())
                })?;
                if outgoing.generation != generation {
                    return Ok(());
                }
                let ready = outgoing.stream_ready.ok_or_else(|| {
                    BrowserPlatformError::Browser("streaming receiver is not ready".to_owned())
                })?;
                (
                    outgoing.transfer_bytes,
                    ready,
                    outgoing.total_bytes,
                    outgoing.sent_bytes,
                    outgoing
                        .files
                        .iter()
                        .map(|file| file.file.clone())
                        .collect::<Vec<_>>(),
                )
            };
            if ready.ack_window_bytes < u64::from(segment_bytes) {
                return Err(BrowserPlatformError::Browser(
                    "streaming acknowledgement window is too small".to_owned(),
                ));
            }
            let channel = self.current_data_channel()?;
            send_control_on(
                &channel,
                &ControlMessage::Start {
                    version: CURRENT_PROTOCOL,
                    transfer_id: transfer_id.clone(),
                },
            )?;
            self.emit(RtcEvent::TransferStarted {
                transfer_id: transfer_id.clone(),
                direction: TransferDirection::Send,
                mode: TransferMode::Streamed { segment_bytes },
                file: summarize_transfer_files(&transfer_files),
                files: transfer_files.clone(),
            });
            if sent_bytes > 0 {
                self.emit(RtcEvent::TransferProgress {
                    transfer_id: transfer_id.clone(),
                    direction: TransferDirection::Send,
                    completed_bytes: sent_bytes,
                    total_bytes,
                });
            }
            TimeoutFuture::new(20).await;

            let policy = BackpressurePolicy {
                chunk_bytes: ready.max_chunk_bytes as usize,
                ..BackpressurePolicy::default()
            };
            let mut digests = Vec::with_capacity(transfer_files.len());
            let mut preceding_bytes = 0_u64;
            for file_index in 0..transfer_files.len() {
                let (browser_file, file, file_bytes, committed_bytes, mut file_hasher) = {
                    let inner = self.inner.borrow();
                    let outgoing = inner.outgoing.as_ref().ok_or_else(|| {
                        BrowserPlatformError::Browser("outgoing transfer disappeared".to_owned())
                    })?;
                    if outgoing.generation != generation {
                        return Ok(());
                    }
                    let file = outgoing.files.get(file_index).ok_or_else(|| {
                        BrowserPlatformError::Browser("outgoing file disappeared".to_owned())
                    })?;
                    (
                        file.browser_file.clone(),
                        file.file.clone(),
                        file.file_bytes,
                        file.committed_bytes,
                        file.committed_hasher.as_ref().clone(),
                    )
                };
                let segments = SegmentPlan::new(file.size_bytes, segment_bytes)
                    .map_err(|error| BrowserPlatformError::Browser(format!("{error:?}")))?;
                let start_segment = if committed_bytes == file.size_bytes {
                    segments.segment_count()
                } else {
                    committed_bytes / u64::from(segment_bytes)
                };
                for segment_index in start_segment..segments.segment_count() {
                    let segment = segments.segment(segment_index).ok_or_else(|| {
                        BrowserPlatformError::Browser("segment plan ended early".to_owned())
                    })?;
                    let mut segment_hasher = Hasher::new();
                    let mut segment_sent = 0_u64;
                    while segment_sent < u64::from(segment.length) {
                        if !self.outgoing_generation_matches(&transfer_id, generation)
                            || self.outgoing_cancelled(&transfer_id)
                        {
                            return Ok(());
                        }
                        if policy.should_pause(u64::from(channel.buffered_amount())) {
                            wait_for_buffer_low(&channel, policy).await;
                            if !self.outgoing_generation_matches(&transfer_id, generation)
                                || self.outgoing_cancelled(&transfer_id)
                            {
                                return Ok(());
                            }
                        }
                        let remaining = u64::from(segment.length) - segment_sent;
                        let chunk_length = remaining.min(ready.max_chunk_bytes as u64) as u32;
                        let offset = segment.offset + segment_sent;
                        let end = offset + u64::from(chunk_length);
                        let blob = browser_file
                            .slice_with_f64_and_f64(offset as f64, end as f64)
                            .map_err(browser_error)?;
                        let array_buffer = JsFuture::from(blob.array_buffer())
                            .await
                            .map_err(browser_error)?
                            .dyn_into::<ArrayBuffer>()
                            .map_err(browser_error)?;
                        let bytes = Uint8Array::new(&array_buffer).to_vec();
                        file_hasher.update(&bytes);
                        segment_hasher.update(&bytes);
                        let mut frame = BinaryChunkHeader {
                            version: CURRENT_PROTOCOL,
                            transfer_id: transfer_bytes,
                            file_id: file_bytes,
                            offset,
                            payload_len: chunk_length,
                        }
                        .encode()
                        .to_vec();
                        frame.extend_from_slice(&bytes);
                        channel.send_with_u8_array(&frame).map_err(browser_error)?;
                        segment_sent += u64::from(chunk_length);
                        let completed_bytes = preceding_bytes + end;
                        let now = Date::now();
                        let emit_progress = {
                            let mut inner = self.inner.borrow_mut();
                            let outgoing = inner.outgoing.as_mut().ok_or_else(|| {
                                BrowserPlatformError::Browser(
                                    "outgoing transfer disappeared".to_owned(),
                                )
                            })?;
                            outgoing.sent_bytes = completed_bytes;
                            outgoing.max_buffered_bytes = outgoing
                                .max_buffered_bytes
                                .max(u64::from(channel.buffered_amount()));
                            if now - outgoing.last_progress_ms >= PROGRESS_INTERVAL_MS
                                || completed_bytes == total_bytes
                            {
                                outgoing.last_progress_ms = now;
                                true
                            } else {
                                false
                            }
                        };
                        if emit_progress {
                            self.emit(RtcEvent::TransferProgress {
                                transfer_id: transfer_id.clone(),
                                direction: TransferDirection::Send,
                                completed_bytes,
                                total_bytes,
                            });
                        }
                    }

                    let segment_blake3 = segment_hasher.finalize().to_hex().to_string();
                    let committed_bytes = segment.offset + u64::from(segment.length);
                    let (ack_sender, ack_receiver) = oneshot::channel();
                    {
                        let mut inner = self.inner.borrow_mut();
                        let outgoing = inner.outgoing.as_mut().ok_or_else(|| {
                            BrowserPlatformError::Browser(
                                "outgoing transfer disappeared".to_owned(),
                            )
                        })?;
                        outgoing.pending_ack = Some(PendingSegmentAck {
                            file_index,
                            segment_index,
                            committed_bytes,
                            blake3: segment_blake3.clone(),
                            file_hasher: Box::new(file_hasher.clone()),
                            sender: Some(ack_sender),
                        });
                    }
                    send_control_on(
                        &channel,
                        &ControlMessage::SegmentCommit {
                            version: CURRENT_PROTOCOL,
                            transfer_id: transfer_id.clone(),
                            file_id: format!("file_{}", hex_bytes(&file_bytes)),
                            segment_index,
                            offset: segment.offset,
                            bytes: segment.length,
                            blake3: segment_blake3,
                        },
                    )?;
                    let acknowledgement = ack_receiver.map(|result| {
                        result.unwrap_or_else(|_| {
                            Err("streaming acknowledgement was dropped".to_owned())
                        })
                    });
                    let timeout = TimeoutFuture::new(30_000)
                        .map(|_| Err("streaming acknowledgement timed out".to_owned()));
                    pin_mut!(acknowledgement, timeout);
                    let result = match select(acknowledgement, timeout).await {
                        Either::Left((result, _)) | Either::Right((result, _)) => result,
                    };
                    result.map_err(BrowserPlatformError::Browser)?;
                }
                let digest = file_hasher.finalize().to_hex().to_string();
                {
                    let mut inner = self.inner.borrow_mut();
                    let outgoing = inner.outgoing.as_mut().ok_or_else(|| {
                        BrowserPlatformError::Browser("outgoing transfer disappeared".to_owned())
                    })?;
                    let outgoing_file = outgoing.files.get_mut(file_index).ok_or_else(|| {
                        BrowserPlatformError::Browser("outgoing file disappeared".to_owned())
                    })?;
                    outgoing_file.expected_hash = Some(digest.clone());
                }
                digests.push(FileDigest {
                    file_id: format!("file_{}", hex_bytes(&file_bytes)),
                    size_bytes: file.size_bytes,
                    blake3: digest,
                });
                preceding_bytes += file.size_bytes;
            }

            if !self.outgoing_generation_matches(&transfer_id, generation) {
                return Ok(());
            }

            {
                let mut inner = self.inner.borrow_mut();
                let outgoing = inner.outgoing.as_mut().ok_or_else(|| {
                    BrowserPlatformError::Browser("outgoing transfer disappeared".to_owned())
                })?;
                outgoing.expected_digests = digests.clone();
                outgoing.sent_bytes = total_bytes;
            }
            send_control_on(
                &channel,
                &ControlMessage::StreamComplete {
                    version: CURRENT_PROTOCOL,
                    transfer_id: transfer_id.clone(),
                    total_bytes,
                    files: digests,
                },
            )?;
            self.emit(RtcEvent::AwaitingVerification {
                transfer_id,
                file: summarize_transfer_files(&transfer_files),
                files: transfer_files,
            });
            Ok(())
        }

        fn handle_binary(&self, frame: Vec<u8>) {
            let Ok((header, payload)) = decode_binary_frame(&frame) else {
                self.fail(None, "invalid binary transfer frame".to_owned());
                return;
            };
            let progress = {
                let mut inner = self.inner.borrow_mut();
                let Some(receive) = inner.receive.as_mut() else {
                    let paused = inner
                        .incoming
                        .as_ref()
                        .is_some_and(|offer| offer.transfer_bytes == header.transfer_id)
                        && inner.pending_recovery.is_some();
                    drop(inner);
                    if paused {
                        return;
                    }
                    self.fail(
                        None,
                        "binary frame arrived without an accepted transfer".to_owned(),
                    );
                    return;
                };
                let transfer_valid =
                    receive.started && header.transfer_id == receive.offer.transfer_bytes;
                let payload_valid = if transfer_valid {
                    match &mut receive.payload {
                        ReceivePayload::Buffered { chunks } => {
                            if let Some(offer_file) = receive.offer.files.first() {
                                let next = receive.received_bytes.checked_add(payload.len() as u64);
                                if header.file_id == offer_file.file_bytes
                                    && header.offset == receive.received_bytes
                                    && next.is_some_and(|next| next <= offer_file.file.size_bytes)
                                {
                                    receive.hasher.update(payload);
                                    receive.received_bytes =
                                        next.expect("next receive offset was checked");
                                    chunks.push(payload.to_vec());
                                    true
                                } else {
                                    false
                                }
                            } else {
                                false
                            }
                        }
                        ReceivePayload::Streamed {
                            segment_bytes,
                            current_file_index,
                            files,
                        } => match receive
                            .offer
                            .files
                            .get(*current_file_index)
                            .zip(files.get_mut(*current_file_index))
                        {
                            Some((offer_file, file)) => {
                                let next = file.received_bytes.checked_add(payload.len() as u64);
                                let segment_end = file
                                    .segment_offset
                                    .saturating_add(u64::from(*segment_bytes))
                                    .min(offer_file.file.size_bytes);
                                if !file.writing
                                    && header.file_id == offer_file.file_bytes
                                    && header.offset == file.received_bytes
                                    && next.is_some_and(|next| {
                                        next <= segment_end && next <= offer_file.file.size_bytes
                                    })
                                {
                                    file.hasher.update(payload);
                                    file.segment_hasher.update(payload);
                                    file.received_bytes =
                                        next.expect("next streaming offset was checked");
                                    file.chunks.push(payload.to_vec());
                                    receive.received_bytes += payload.len() as u64;
                                    true
                                } else {
                                    false
                                }
                            }
                            None => false,
                        },
                    }
                } else {
                    false
                };
                if !payload_valid {
                    let transfer_id = receive.offer.transfer_id.clone();
                    drop(inner);
                    self.clear_transfer(&transfer_id);
                    self.send_transfer_error(
                        &transfer_id,
                        "invalid_chunk",
                        "binary chunk order or bounds are invalid",
                    );
                    self.fail(Some(transfer_id), "文件分块顺序或长度无效".to_owned());
                    return;
                }
                let total_bytes = incoming_total_bytes(&receive.offer.files);
                let now = Date::now();
                if now - receive.last_progress_ms >= PROGRESS_INTERVAL_MS
                    || receive.received_bytes == total_bytes
                {
                    receive.last_progress_ms = now;
                    Some((
                        receive.offer.transfer_id.clone(),
                        receive.received_bytes,
                        total_bytes,
                    ))
                } else {
                    None
                }
            };
            if let Some((transfer_id, completed_bytes, total_bytes)) = progress {
                self.emit(RtcEvent::TransferProgress {
                    transfer_id,
                    direction: TransferDirection::Receive,
                    completed_bytes,
                    total_bytes,
                });
            }
        }

        fn handle_segment_commit(
            &self,
            transfer_id: String,
            file_id: String,
            segment_index: u64,
            offset: u64,
            bytes: u32,
            blake3: String,
        ) {
            let prepared = (|| -> Result<_, String> {
                let mut inner = self.inner.borrow_mut();
                let receive = inner
                    .receive
                    .as_mut()
                    .ok_or_else(|| "segment commit has no active receiver".to_owned())?;
                if receive.offer.transfer_id != transfer_id {
                    Err("segment commit id does not match".to_owned())
                } else {
                    match &mut receive.payload {
                        ReceivePayload::Buffered { .. } => {
                            Err("segment commit was sent for a buffered transfer".to_owned())
                        }
                        ReceivePayload::Streamed {
                            segment_bytes,
                            current_file_index,
                            files,
                        } => {
                            let file_index = *current_file_index;
                            let offer_file =
                                receive.offer.files.get(file_index).ok_or_else(|| {
                                    "segment commit file is unavailable".to_owned()
                                })?;
                            let file = files
                                .get_mut(file_index)
                                .ok_or_else(|| "segment receiver is unavailable".to_owned())?;
                            let expected_end = file
                                .segment_offset
                                .saturating_add(u64::from(*segment_bytes))
                                .min(offer_file.file.size_bytes);
                            let actual_hash = file.segment_hasher.finalize().to_hex().to_string();
                            if parse_binary_id(&file_id, "file") != Some(offer_file.file_bytes)
                                || file.writing
                                || file.segment_index != segment_index
                                || file.segment_offset != offset
                                || file.received_bytes != expected_end
                                || u64::from(bytes) != file.received_bytes - file.segment_offset
                                || actual_hash != blake3
                            {
                                Err("segment commit bounds or hash do not match".to_owned())
                            } else {
                                let writer = file
                                    .writer
                                    .take()
                                    .ok_or_else(|| "streaming writer is unavailable".to_owned())?;
                                file.active_abort = writer.abort_handle();
                                let chunks = std::mem::take(&mut file.chunks);
                                *file.segment_hasher = Hasher::new();
                                file.writing = true;
                                Ok((
                                    writer,
                                    chunks,
                                    expected_end,
                                    file_index,
                                    receive.recovery_persisted,
                                    receive.generation,
                                ))
                            }
                        }
                    }
                }
            })();
            let (mut writer, chunks, committed_bytes, file_index, recovery_persisted, generation) =
                match prepared {
                    Ok(prepared) => prepared,
                    Err(message) => {
                        self.clear_transfer(&transfer_id);
                        self.send_transfer_error(&transfer_id, "invalid_segment", &message);
                        self.fail(Some(transfer_id), "文件分段校验失败".to_owned());
                        return;
                    }
                };
            let peer = self.clone();
            spawn_local(async move {
                let segment_len = chunks.iter().map(Vec::len).sum();
                let mut segment_data = Vec::with_capacity(segment_len);
                for chunk in chunks {
                    segment_data.extend_from_slice(&chunk);
                }
                if let Err(error) = writer.write_at(offset, &segment_data).await {
                    if !peer.receive_generation_matches(&transfer_id, generation) {
                        return;
                    }
                    if let Some(reason) = recoverable_stream_pause_reason(&error) {
                        peer.pause_stream_receive(transfer_id, writer, generation, reason)
                            .await;
                        return;
                    }
                    peer.clear_transfer(&transfer_id);
                    peer.send_transfer_error(
                        &transfer_id,
                        "storage_write_failed",
                        "receiver could not write the streaming file",
                    );
                    peer.fail(Some(transfer_id), error.to_string());
                    return;
                }
                if !peer.receive_generation_matches(&transfer_id, generation) {
                    let _ = writer.abort().await;
                    return;
                }
                if recovery_persisted && let Err(error) = writer.commit_checkpoint().await {
                    if !peer.receive_generation_matches(&transfer_id, generation) {
                        return;
                    }
                    if let Some(reason) = recoverable_stream_pause_reason(&error) {
                        peer.pause_stream_receive(transfer_id, writer, generation, reason)
                            .await;
                        return;
                    }
                    peer.clear_transfer(&transfer_id);
                    peer.send_transfer_error(
                        &transfer_id,
                        "storage_checkpoint_failed",
                        "receiver could not commit the streaming checkpoint",
                    );
                    peer.fail(Some(transfer_id), error.to_string());
                    return;
                }
                if !peer.receive_generation_matches(&transfer_id, generation) {
                    let _ = writer.abort().await;
                    return;
                }
                if recovery_persisted && let Err(error) = writer.reopen_after_checkpoint().await {
                    if !peer.receive_generation_matches(&transfer_id, generation) {
                        return;
                    }
                    if let Some(reason) = recoverable_stream_pause_reason(&error) {
                        peer.pause_stream_receive(transfer_id, writer, generation, reason)
                            .await;
                        return;
                    }
                    peer.clear_transfer(&transfer_id);
                    peer.send_transfer_error(
                        &transfer_id,
                        "storage_reopen_failed",
                        "receiver could not reopen the streaming destination",
                    );
                    peer.fail(Some(transfer_id), error.to_string());
                    return;
                }
                if !peer.receive_generation_matches(&transfer_id, generation) {
                    let _ = writer.abort().await;
                    return;
                }
                let restored = {
                    let mut inner = peer.inner.borrow_mut();
                    let peer_id = inner.target_peer.clone();
                    let Some(receive) = inner.receive.as_mut() else {
                        return;
                    };
                    if receive.offer.transfer_id != transfer_id || receive.generation != generation
                    {
                        None
                    } else if let ReceivePayload::Streamed {
                        current_file_index,
                        files,
                        ..
                    } = &mut receive.payload
                    {
                        let Some(file) = files.get_mut(file_index) else {
                            return;
                        };
                        if file.segment_index != segment_index || !file.writing {
                            None
                        } else {
                            file.writer = Some(writer);
                            file.active_abort = None;
                            file.segment_index += 1;
                            file.segment_offset = committed_bytes;
                            *file.committed_hasher = file.hasher.as_ref().clone();
                            file.last_segment_blake3 = Some(blake3.clone());
                            file.writing = false;
                            if committed_bytes == receive.offer.files[file_index].file.size_bytes {
                                *current_file_index = receive
                                    .offer
                                    .files
                                    .iter()
                                    .enumerate()
                                    .skip(file_index + 1)
                                    .find_map(|(index, file)| {
                                        (file.file.size_bytes > 0).then_some(index)
                                    })
                                    .unwrap_or(receive.offer.files.len());
                            }
                            let resume = receive.resume_requested;
                            receive.resume_requested = false;
                            let recovery = receive
                                .recovery_persisted
                                .then(|| {
                                    peer_id.as_deref().and_then(|peer_id| {
                                        recovery_record_from_receive(receive, peer_id)
                                    })
                                })
                                .flatten();
                            Some((resume, recovery))
                        }
                    } else {
                        None
                    }
                };
                let Some((resume_requested, recovery)) = restored else {
                    peer.clear_transfer(&transfer_id);
                    peer.fail(
                        Some(transfer_id),
                        "streaming receiver state changed while writing".to_owned(),
                    );
                    return;
                };
                if let Some(recovery) = recovery
                    && let Err(error) = save_stream_recovery(&recovery).await
                {
                    if !peer.receive_generation_matches(&transfer_id, generation) {
                        return;
                    }
                    let _ = delete_stream_recovery(&transfer_id).await;
                    peer.clear_transfer(&transfer_id);
                    peer.send_transfer_error(
                        &transfer_id,
                        "recovery_checkpoint_failed",
                        "receiver could not persist the verified checkpoint",
                    );
                    peer.fail(Some(transfer_id), error.to_string());
                    return;
                }
                if !peer.receive_generation_matches(&transfer_id, generation) {
                    return;
                }
                if resume_requested {
                    if let Err(error) = peer.send_stream_resume(&transfer_id) {
                        peer.fail(Some(transfer_id), error.to_string());
                    }
                    return;
                }
                let result = peer.current_data_channel().and_then(|channel| {
                    send_control_on(
                        &channel,
                        &ControlMessage::SegmentAck {
                            version: CURRENT_PROTOCOL,
                            transfer_id: transfer_id.clone(),
                            file_id,
                            segment_index,
                            committed_bytes,
                            blake3,
                        },
                    )
                });
                if let Err(error) = result {
                    if reconnectable_channel_error(&error) {
                        peer.suspend_stream_for_reconnect();
                        peer.emit(RtcEvent::ConnectionState(RtcConnectionPhase::Closed));
                    } else {
                        peer.fail(Some(transfer_id), error.to_string());
                    }
                }
            });
        }

        async fn pause_stream_receive(
            &self,
            transfer_id: String,
            writer: StreamingFileWriter,
            generation: u64,
            reason: StreamPauseReason,
        ) {
            let _ = writer.abort().await;
            if !self.receive_generation_matches(&transfer_id, generation) {
                return;
            }
            let recovery = match load_stream_recovery(&transfer_id).await {
                Ok(Some(recovery)) => recovery,
                Ok(None) | Err(_) => {
                    self.clear_transfer(&transfer_id);
                    self.send_transfer_error(
                        &transfer_id,
                        "recovery_checkpoint_missing",
                        "receiver could not preserve the last durable checkpoint",
                    );
                    self.fail(Some(transfer_id), "无法保留已校验的磁盘检查点".to_owned());
                    return;
                }
            };
            if !self.receive_generation_matches(&transfer_id, generation) {
                return;
            }
            let paused = {
                let mut inner = self.inner.borrow_mut();
                let peer_id = inner.target_peer.clone();
                let Some(receive) = inner.receive.take() else {
                    return;
                };
                if receive.offer.transfer_id != transfer_id
                    || receive.generation != generation
                    || !peer_id.as_deref().is_some_and(|peer_id| {
                        stream_recovery_matches(&receive.offer, peer_id, &recovery)
                    })
                {
                    inner.receive = Some(receive);
                    return;
                }
                let offer = receive.offer.clone();
                let total_bytes = incoming_total_bytes(&offer.files);
                let completed_bytes = recovery.files.iter().map(|file| file.committed_bytes).sum();
                let idle_writers = match receive.payload {
                    ReceivePayload::Streamed { files, .. } => files
                        .into_iter()
                        .filter_map(|file| file.writer)
                        .collect::<Vec<_>>(),
                    ReceivePayload::Buffered { .. } => Vec::new(),
                };
                inner.incoming = Some(offer);
                inner.pending_recovery = Some(recovery);
                inner.paused_receive_reason = Some(reason);
                Some((completed_bytes, total_bytes, idle_writers))
            };
            let Some((completed_bytes, total_bytes, idle_writers)) = paused else {
                return;
            };
            for writer in idle_writers {
                let _ = writer.abort().await;
            }
            let still_paused = {
                let inner = self.inner.borrow();
                inner
                    .incoming
                    .as_ref()
                    .is_some_and(|offer| offer.transfer_id == transfer_id)
                    && inner
                        .pending_recovery
                        .as_ref()
                        .is_some_and(|recovery| recovery.transfer_id == transfer_id)
            };
            if !still_paused {
                return;
            }
            if let Ok(channel) = self.current_data_channel() {
                let _ = send_control_on(
                    &channel,
                    &ControlMessage::StreamPaused {
                        version: CURRENT_PROTOCOL,
                        transfer_id: transfer_id.clone(),
                        reason,
                    },
                );
            }
            self.emit(RtcEvent::TransferPaused {
                transfer_id,
                direction: TransferDirection::Receive,
                reason,
                completed_bytes,
                total_bytes,
            });
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

        fn handle_segment_ack(
            &self,
            transfer_id: String,
            file_id: String,
            segment_index: u64,
            committed_bytes: u64,
            blake3: String,
        ) {
            let acknowledgement =
                (|| -> Result<_, String> {
                    let mut inner = self.inner.borrow_mut();
                    let outgoing = inner.outgoing.as_mut().ok_or_else(|| {
                        "segment acknowledgement has no outgoing transfer".to_owned()
                    })?;
                    if outgoing.transfer_id != transfer_id {
                        return Err("segment acknowledgement id does not match".to_owned());
                    }
                    let Some(mut pending) = outgoing.pending_ack.take() else {
                        return Err("segment acknowledgement was not expected".to_owned());
                    };
                    let file_matches = outgoing.files.get(pending.file_index).is_some_and(|file| {
                        parse_binary_id(&file_id, "file") == Some(file.file_bytes)
                    });
                    let result = if file_matches
                        && pending.segment_index == segment_index
                        && pending.committed_bytes == committed_bytes
                        && pending.blake3 == blake3
                    {
                        let file = &mut outgoing.files[pending.file_index];
                        file.committed_bytes = pending.committed_bytes;
                        file.committed_hasher = pending.file_hasher;
                        file.last_segment_blake3 = Some(pending.blake3);
                        Ok(())
                    } else {
                        Err("segment acknowledgement does not match".to_owned())
                    };
                    let recovery = result
                        .is_ok()
                        .then(|| outgoing_recovery_record(outgoing))
                        .flatten();
                    Ok((pending.sender.take(), result, recovery))
                })();
            let (sender, result, recovery) = match acknowledgement {
                Ok(acknowledgement) => acknowledgement,
                Err(message) => {
                    self.fail(Some(transfer_id), message);
                    return;
                }
            };
            if let Some(recovery) = recovery {
                spawn_local(async move {
                    let result = match save_outgoing_recovery(&recovery).await {
                        Ok(()) => result,
                        Err(error) => Err(format!(
                            "failed to save the outgoing transfer checkpoint: {error}"
                        )),
                    };
                    if let Some(sender) = sender {
                        let _ = sender.send(result);
                    }
                });
            } else if let Some(sender) = sender {
                let _ = sender.send(result);
            }
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

        fn finish_stream_receive(
            &self,
            transfer_id: String,
            total_bytes: u64,
            files: Vec<FileDigest>,
        ) {
            let receive = self.inner.borrow_mut().receive.take();
            let Some(receive) = receive else {
                return;
            };
            let base_valid = receive.offer.transfer_id == transfer_id
                && matches!(receive.offer.mode, TransferMode::Streamed { .. })
                && files.len() == receive.offer.files.len()
                && total_bytes == incoming_total_bytes(&receive.offer.files)
                && receive.received_bytes == total_bytes
                && !files.is_empty();
            let (writers, committed) = match receive.payload {
                ReceivePayload::Streamed {
                    files: receive_files,
                    ..
                } => {
                    let committed = base_valid
                        && receive
                            .offer
                            .files
                            .iter()
                            .zip(&receive_files)
                            .zip(&files)
                            .all(|((offer, state), digest)| {
                                state.received_bytes == offer.file.size_bytes
                                    && state.segment_offset == offer.file.size_bytes
                                    && state.chunks.is_empty()
                                    && !state.writing
                                    && parse_binary_id(&digest.file_id, "file")
                                        == Some(offer.file_bytes)
                                    && digest.size_bytes == offer.file.size_bytes
                                    && digest.blake3 == state.hasher.finalize().to_hex().to_string()
                            });
                    (
                        receive_files
                            .into_iter()
                            .filter_map(|file| file.writer)
                            .collect::<Vec<_>>(),
                        committed,
                    )
                }
                ReceivePayload::Buffered { .. } => (Vec::new(), false),
            };
            if !committed || writers.len() != receive.offer.files.len() {
                self.send_transfer_error(
                    &transfer_id,
                    "integrity_mismatch",
                    "streamed bytes failed integrity verification",
                );
                self.fail(Some(transfer_id), "文件完整性校验失败".to_owned());
                return;
            }
            let transfer_files = incoming_transfer_files(&receive.offer.files);
            let summary = summarize_transfer_files(&transfer_files);
            let batch_hash = batch_blake3(&files);
            let peer = self.clone();
            spawn_local(async move {
                for writer in writers {
                    if let Err(error) = writer.close().await {
                        peer.send_transfer_error(
                            &transfer_id,
                            "storage_close_failed",
                            "receiver could not finish the streaming files",
                        );
                        peer.fail(Some(transfer_id), error.to_string());
                        return;
                    }
                }
                let _ = delete_stream_recovery(&transfer_id).await;
                if let Ok(channel) = peer.current_data_channel() {
                    let _ = send_control_on(
                        &channel,
                        &ControlMessage::StreamComplete {
                            version: CURRENT_PROTOCOL,
                            transfer_id: transfer_id.clone(),
                            total_bytes,
                            files: files.clone(),
                        },
                    );
                }
                peer.emit(RtcEvent::TransferCompleted {
                    transfer_id,
                    direction: TransferDirection::Receive,
                    file: summary,
                    files: transfer_files,
                    blake3: batch_hash,
                    download_url: None,
                });
            });
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

        fn finish_receive(&self, transfer_id: String, bytes: u64, blake3: String) {
            let receive = {
                let mut inner = self.inner.borrow_mut();
                let Some(receive) = inner.receive.take() else {
                    return;
                };
                receive
            };
            let actual_hash = receive.hasher.finalize().to_hex().to_string();
            let Some(offer_file) = receive.offer.files.first() else {
                self.fail(Some(transfer_id), "接收文件信息缺失".to_owned());
                return;
            };
            if receive.offer.transfer_id != transfer_id
                || receive.offer.mode != TransferMode::Buffered
                || receive.received_bytes != bytes
                || receive.offer.files.len() != 1
                || bytes != offer_file.file.size_bytes
                || actual_hash != blake3
            {
                self.send_transfer_error(
                    &transfer_id,
                    "integrity_mismatch",
                    "received bytes failed integrity verification",
                );
                self.fail(Some(transfer_id), "文件完整性校验失败".to_owned());
                return;
            }
            let ReceivePayload::Buffered { chunks } = receive.payload else {
                self.fail(Some(transfer_id), "接收模式不匹配".to_owned());
                return;
            };

            let parts = Array::new();
            for chunk in &chunks {
                let array = Uint8Array::from(chunk.as_slice());
                parts.push(&array.buffer());
            }
            let options = BlobPropertyBag::new();
            options.set_type(
                receive.offer.files[0]
                    .file
                    .mime
                    .as_deref()
                    .unwrap_or("application/octet-stream"),
            );
            let Ok(blob) = Blob::new_with_u8_array_sequence_and_options(&parts, &options) else {
                self.fail(Some(transfer_id), "无法创建接收文件".to_owned());
                return;
            };
            let Ok(url) = Url::create_object_url_with_blob(&blob) else {
                self.fail(Some(transfer_id), "无法创建文件下载地址".to_owned());
                return;
            };
            {
                let mut inner = self.inner.borrow_mut();
                if let Some(previous) = inner.object_url.replace(url.clone()) {
                    let _ = Url::revoke_object_url(&previous);
                }
            }
            if let Ok(channel) = self.current_data_channel() {
                let _ = send_control_on(
                    &channel,
                    &ControlMessage::Complete {
                        version: CURRENT_PROTOCOL,
                        transfer_id: transfer_id.clone(),
                        bytes,
                        blake3: blake3.clone(),
                    },
                );
            }
            self.emit(RtcEvent::TransferCompleted {
                transfer_id,
                direction: TransferDirection::Receive,
                file: offer_file.file.clone(),
                files: vec![offer_file.file.clone()],
                blake3,
                download_url: Some(url),
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

        fn outgoing_cancelled(&self, transfer_id: &str) -> bool {
            self.inner
                .borrow()
                .outgoing
                .as_ref()
                .is_none_or(|outgoing| outgoing.transfer_id != transfer_id || outgoing.cancelled)
        }

        fn outgoing_generation_matches(&self, transfer_id: &str, generation: u64) -> bool {
            self.inner
                .borrow()
                .outgoing
                .as_ref()
                .is_some_and(|outgoing| {
                    outgoing.transfer_id == transfer_id
                        && outgoing.generation == generation
                        && !outgoing.cancelled
                })
        }

        fn receive_generation_matches(&self, transfer_id: &str, generation: u64) -> bool {
            self.inner.borrow().receive.as_ref().is_some_and(|receive| {
                receive.offer.transfer_id == transfer_id && receive.generation == generation
            })
        }

        fn current_peer_connection(&self) -> Result<RtcPeerConnection, BrowserPlatformError> {
            self.inner.borrow().peer_connection.clone().ok_or_else(|| {
                BrowserPlatformError::Browser("PeerConnection is not ready".to_owned())
            })
        }

        fn current_data_channel(&self) -> Result<RtcDataChannel, BrowserPlatformError> {
            let channel = self.inner.borrow().data_channel.clone().ok_or_else(|| {
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

    async fn wait_for_buffer_low(channel: &RtcDataChannel, policy: BackpressurePolicy) {
        while !policy.can_resume(u64::from(channel.buffered_amount())) {
            let (sender, receiver) = oneshot::channel::<()>();
            let sender = Rc::new(RefCell::new(Some(sender)));
            let event_sender = Rc::clone(&sender);
            let on_low = Closure::<dyn FnMut(Event)>::new(move |_| {
                if let Some(sender) = event_sender.borrow_mut().take() {
                    let _ = sender.send(());
                }
            });
            channel.set_onbufferedamountlow(Some(on_low.as_ref().unchecked_ref()));
            if policy.can_resume(u64::from(channel.buffered_amount()))
                && let Some(sender) = sender.borrow_mut().take()
            {
                let _ = sender.send(());
            }
            let event = receiver.map(|_| ());
            let timeout = TimeoutFuture::new(BACKPRESSURE_TIMEOUT_MS);
            pin_mut!(event, timeout);
            let _ = select(event, timeout).await;
            channel.set_onbufferedamountlow(None);
        }
    }

    fn send_control_on(
        channel: &RtcDataChannel,
        message: &ControlMessage,
    ) -> Result<(), BrowserPlatformError> {
        message.validate().map_err(protocol_error)?;
        let json = serde_json::to_string(message)
            .map_err(|error| BrowserPlatformError::Decode(error.to_string()))?;
        channel.send_with_str(&json).map_err(browser_error)
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
        (format!("{prefix}_{}", hex_bytes(&bytes)), bytes)
    }

    fn parse_binary_id(value: &str, prefix: &str) -> Option<[u8; 16]> {
        let hex = value.strip_prefix(&format!("{prefix}_"))?;
        if hex.len() != 32 {
            return None;
        }
        let mut bytes = [0_u8; 16];
        for (index, byte) in bytes.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&hex[index * 2..index * 2 + 2], 16).ok()?;
        }
        Some(bytes)
    }

    fn hex_bytes(bytes: &[u8]) -> String {
        const HEX: &[u8; 16] = b"0123456789abcdef";
        let mut result = String::with_capacity(bytes.len() * 2);
        for byte in bytes {
            result.push(char::from(HEX[(byte >> 4) as usize]));
            result.push(char::from(HEX[(byte & 0x0f) as usize]));
        }
        result
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

    fn recoverable_stream_pause_reason(error: &BrowserPlatformError) -> Option<StreamPauseReason> {
        match error {
            BrowserPlatformError::Storage {
                kind: BrowserStorageErrorKind::QuotaExceeded,
                ..
            } => Some(StreamPauseReason::DestinationQuotaExceeded),
            BrowserPlatformError::Storage {
                kind: BrowserStorageErrorKind::PermissionDenied,
                ..
            } => Some(StreamPauseReason::DestinationPermissionDenied),
            _ => None,
        }
    }

    fn prepare_outgoing(
        files: Vec<BrowserFile>,
        recovery_peer_id: Option<String>,
    ) -> Result<(OutgoingState, ControlMessage, Vec<TransferFile>), BrowserPlatformError> {
        if files.is_empty() || files.len() > MAX_FILES_PER_MANIFEST {
            return Err(BrowserPlatformError::Browser(format!(
                "select between 1 and {MAX_FILES_PER_MANIFEST} files"
            )));
        }
        let metadata = files.iter().map(BrowserFile::metadata).collect::<Vec<_>>();
        let total_bytes = metadata.iter().try_fold(0_u64, |total, file| {
            total
                .checked_add(file.size_bytes)
                .ok_or_else(|| BrowserPlatformError::Browser("transfer size overflow".to_owned()))
        })?;
        if total_bytes > MAX_TRANSFER_BYTES {
            return Err(BrowserPlatformError::Browser(format!(
                "files exceed the {} byte transfer limit",
                MAX_TRANSFER_BYTES
            )));
        }
        let mode = if files.len() == 1 && total_bytes <= MAX_BUFFERED_TRANSFER_BYTES {
            TransferMode::Buffered
        } else {
            TransferMode::Streamed {
                segment_bytes: DEFAULT_STREAM_SEGMENT_BYTES,
            }
        };
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

    fn manifest_from_outgoing(outgoing: &OutgoingState) -> ControlMessage {
        ControlMessage::Manifest {
            version: CURRENT_PROTOCOL,
            transfer_id: outgoing.transfer_id.clone(),
            mode: outgoing.mode,
            files: outgoing
                .files
                .iter()
                .map(|file| FileManifest {
                    file_id: format!("file_{}", hex_bytes(&file.file_bytes)),
                    name: file.file.name.clone(),
                    mime: file.file.mime.clone(),
                    size_bytes: file.file.size_bytes,
                })
                .collect(),
        }
    }

    fn outgoing_recovery_record(outgoing: &OutgoingState) -> Option<OutgoingRecoveryRecord> {
        let TransferMode::Streamed { segment_bytes } = outgoing.mode else {
            return None;
        };
        let peer_id = outgoing.recovery_peer_id.clone()?;
        let files = outgoing
            .files
            .iter()
            .map(|file| {
                Some(OutgoingRecoveryFile {
                    file_id: format!("file_{}", hex_bytes(&file.file_bytes)),
                    name: file.file.name.clone(),
                    mime: file.file.mime.clone(),
                    size_bytes: file.file.size_bytes,
                    last_modified_ms: file.last_modified_ms,
                    handle: file.source_handle.clone()?,
                    committed_bytes: file.committed_bytes,
                    last_segment_blake3: file.last_segment_blake3.clone(),
                })
            })
            .collect::<Option<Vec<_>>>()?;
        Some(OutgoingRecoveryRecord {
            transfer_id: outgoing.transfer_id.clone(),
            peer_id,
            segment_bytes,
            files,
        })
    }

    fn recovery_transfer_files(recovery: &OutgoingRecoveryRecord) -> Vec<TransferFile> {
        recovery
            .files
            .iter()
            .map(|file| TransferFile {
                name: file.name.clone(),
                mime: file.mime.clone(),
                size_bytes: file.size_bytes,
            })
            .collect()
    }

    fn summarize_transfer_files(files: &[TransferFile]) -> TransferFile {
        if let [file] = files {
            return file.clone();
        }
        TransferFile {
            name: format!("{} 个文件", files.len()),
            mime: None,
            size_bytes: files.iter().map(|file| file.size_bytes).sum(),
        }
    }

    fn incoming_transfer_files(files: &[IncomingFile]) -> Vec<TransferFile> {
        files.iter().map(|file| file.file.clone()).collect()
    }

    fn summarize_incoming_files(files: &[IncomingFile]) -> TransferFile {
        summarize_transfer_files(&incoming_transfer_files(files))
    }

    fn incoming_total_bytes(files: &[IncomingFile]) -> u64 {
        files.iter().map(|file| file.file.size_bytes).sum()
    }

    fn incoming_offer_matches(left: &IncomingOffer, right: &IncomingOffer) -> bool {
        left.transfer_id == right.transfer_id
            && left.transfer_bytes == right.transfer_bytes
            && left.mode == right.mode
            && left.files.len() == right.files.len()
            && left
                .files
                .iter()
                .zip(&right.files)
                .all(|(left, right)| left.file_bytes == right.file_bytes && left.file == right.file)
    }

    fn recovery_record_from_writers(
        offer: &IncomingOffer,
        peer_id: &str,
        writers: &[StreamingFileWriter],
    ) -> StreamRecoveryRecord {
        let TransferMode::Streamed { segment_bytes } = offer.mode else {
            unreachable!("recovery records are only created for streaming transfers");
        };
        StreamRecoveryRecord {
            transfer_id: offer.transfer_id.clone(),
            peer_id: peer_id.to_owned(),
            segment_bytes,
            files: offer
                .files
                .iter()
                .zip(writers)
                .map(|(offer, writer)| StreamRecoveryFile {
                    file_id: format!("file_{}", hex_bytes(&offer.file_bytes)),
                    name: offer.file.name.clone(),
                    mime: offer.file.mime.clone(),
                    size_bytes: offer.file.size_bytes,
                    handle: writer.recovery_handle(),
                    committed_bytes: 0,
                    last_segment_blake3: None,
                })
                .collect(),
        }
    }

    fn recovery_record_from_receive(
        receive: &ReceiveState,
        peer_id: &str,
    ) -> Option<StreamRecoveryRecord> {
        let ReceivePayload::Streamed {
            segment_bytes,
            files,
            ..
        } = &receive.payload
        else {
            return None;
        };
        let recovery_files = receive
            .offer
            .files
            .iter()
            .zip(files)
            .map(|(offer, state)| {
                state.writer.as_ref().map(|writer| StreamRecoveryFile {
                    file_id: format!("file_{}", hex_bytes(&offer.file_bytes)),
                    name: offer.file.name.clone(),
                    mime: offer.file.mime.clone(),
                    size_bytes: offer.file.size_bytes,
                    handle: writer.recovery_handle(),
                    committed_bytes: state.segment_offset,
                    last_segment_blake3: state.last_segment_blake3.clone(),
                })
            })
            .collect::<Option<Vec<_>>>()?;
        Some(StreamRecoveryRecord {
            transfer_id: receive.offer.transfer_id.clone(),
            peer_id: peer_id.to_owned(),
            segment_bytes: *segment_bytes,
            files: recovery_files,
        })
    }

    fn stream_recovery_matches(
        offer: &IncomingOffer,
        peer_id: &str,
        recovery: &StreamRecoveryRecord,
    ) -> bool {
        let TransferMode::Streamed { segment_bytes } = offer.mode else {
            return false;
        };
        if recovery.transfer_id != offer.transfer_id
            || recovery.peer_id != peer_id
            || recovery.segment_bytes != segment_bytes
            || recovery.files.len() != offer.files.len()
        {
            return false;
        }
        let mut incomplete_seen = false;
        for (offer, recovery) in offer.files.iter().zip(&recovery.files) {
            let checkpoint_valid = recovery.committed_bytes <= recovery.size_bytes
                && (recovery.committed_bytes == recovery.size_bytes
                    || recovery.committed_bytes % u64::from(segment_bytes) == 0)
                && (!incomplete_seen || recovery.committed_bytes == 0);
            let hash_valid = (recovery.committed_bytes == 0
                && recovery.last_segment_blake3.is_none())
                || (recovery.committed_bytes > 0
                    && recovery
                        .last_segment_blake3
                        .as_deref()
                        .is_some_and(valid_blake3));
            if recovery.file_id != format!("file_{}", hex_bytes(&offer.file_bytes))
                || recovery.name != offer.file.name
                || recovery.mime != offer.file.mime
                || recovery.size_bytes != offer.file.size_bytes
                || !checkpoint_valid
                || !hash_valid
            {
                return false;
            }
            if recovery.committed_bytes < recovery.size_bytes {
                incomplete_seen = true;
            }
        }
        true
    }

    fn valid_blake3(value: &str) -> bool {
        value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
    }

    fn apply_resume_to_recovery(
        recovery: &mut OutgoingRecoveryRecord,
        resume: &[ResumeCursor],
    ) -> Result<(), BrowserPlatformError> {
        if !resume.is_empty() && resume.len() != recovery.files.len() {
            return Err(BrowserPlatformError::Browser(
                "receiver checkpoint file count does not match".to_owned(),
            ));
        }
        let mut incomplete_seen = false;
        for (index, file) in recovery.files.iter_mut().enumerate() {
            let cursor = resume.get(index);
            if let Some(cursor) = cursor
                && cursor.file_id != file.file_id
            {
                return Err(BrowserPlatformError::Browser(
                    "receiver checkpoint file order does not match".to_owned(),
                ));
            }
            let committed_bytes = cursor.map_or(0, |cursor| cursor.committed_bytes);
            let last_segment_blake3 = cursor.and_then(|cursor| cursor.last_segment_blake3.clone());
            let checkpoint_valid = committed_bytes <= file.size_bytes
                && (committed_bytes == file.size_bytes
                    || committed_bytes % u64::from(recovery.segment_bytes) == 0)
                && (!incomplete_seen || committed_bytes == 0);
            let hash_valid = (committed_bytes == 0 && last_segment_blake3.is_none())
                || (committed_bytes > 0
                    && last_segment_blake3.as_deref().is_some_and(valid_blake3));
            if !checkpoint_valid || !hash_valid {
                return Err(BrowserPlatformError::Browser(
                    "receiver checkpoint is not a verified segment boundary".to_owned(),
                ));
            }
            if committed_bytes < file.size_bytes {
                incomplete_seen = true;
            }
            file.committed_bytes = committed_bytes;
            file.last_segment_blake3 = last_segment_blake3;
        }
        Ok(())
    }

    fn prepare_receive_reconnect(receive: &mut ReceiveState) {
        receive.started = false;
        let ReceivePayload::Streamed {
            current_file_index,
            files,
            ..
        } = &mut receive.payload
        else {
            return;
        };
        for file in files.iter_mut().filter(|file| !file.writing) {
            file.received_bytes = file.segment_offset;
            *file.hasher = file.committed_hasher.as_ref().clone();
            file.chunks.clear();
            *file.segment_hasher = Hasher::new();
        }
        receive.received_bytes = files.iter().map(|file| file.received_bytes).sum();
        *current_file_index = files
            .iter()
            .position(|file| file.writing)
            .or_else(|| {
                files
                    .iter()
                    .zip(&receive.offer.files)
                    .position(|(state, offer)| state.received_bytes < offer.file.size_bytes)
            })
            .unwrap_or(files.len());
    }

    fn validate_resume_cursors(
        outgoing: &OutgoingState,
        segment_bytes: u32,
        resume: &[ResumeCursor],
    ) -> Result<bool, ()> {
        if !resume.is_empty() && resume.len() != outgoing.files.len() {
            return Err(());
        }
        let mut promote_pending = false;
        let mut incomplete_seen = false;
        for (file_index, file) in outgoing.files.iter().enumerate() {
            let expected_file_id = format!("file_{}", hex_bytes(&file.file_bytes));
            let cursor = if resume.is_empty() {
                None
            } else {
                Some(
                    resume
                        .iter()
                        .find(|cursor| cursor.file_id == expected_file_id)
                        .ok_or(())?,
                )
            };
            let committed_bytes = cursor.map_or(0, |cursor| cursor.committed_bytes);
            let last_segment_blake3 = cursor.and_then(|cursor| cursor.last_segment_blake3.as_ref());
            let aligned = committed_bytes <= file.file.size_bytes
                && (committed_bytes == file.file.size_bytes
                    || committed_bytes % u64::from(segment_bytes) == 0);
            if !aligned || incomplete_seen && committed_bytes > 0 {
                return Err(());
            }
            if committed_bytes < file.file.size_bytes {
                incomplete_seen = true;
            }
            let current_matches = committed_bytes == file.committed_bytes
                && if committed_bytes == 0 {
                    last_segment_blake3.is_none()
                } else {
                    last_segment_blake3 == file.last_segment_blake3.as_ref()
                };
            let pending_matches = outgoing.pending_ack.as_ref().is_some_and(|pending| {
                pending.file_index == file_index
                    && pending.committed_bytes == committed_bytes
                    && Some(pending.blake3.as_str()) == last_segment_blake3.map(String::as_str)
            });
            if !current_matches && !pending_matches {
                return Err(());
            }
            if pending_matches && committed_bytes != file.committed_bytes {
                if promote_pending {
                    return Err(());
                }
                promote_pending = true;
            }
        }
        Ok(promote_pending)
    }

    fn batch_blake3(files: &[FileDigest]) -> String {
        if let [file] = files {
            return file.blake3.clone();
        }
        let mut hasher = Hasher::new();
        for file in files {
            hasher.update(file.file_id.as_bytes());
            hasher.update(&file.size_bytes.to_be_bytes());
            hasher.update(file.blake3.as_bytes());
        }
        hasher.finalize().to_hex().to_string()
    }
}

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
