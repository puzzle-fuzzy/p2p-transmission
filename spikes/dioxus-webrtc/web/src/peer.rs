use std::{cell::RefCell, rc::Rc};

use blake3::Hasher;
use gloo_timers::future::TimeoutFuture;
use js_sys::{Array, ArrayBuffer, Date, Math, Reflect, Uint8Array};
use p2p_spike_protocol::{ClientMessage, DataControlFrame, ServerMessage, Signal};
use wasm_bindgen::{JsCast, JsValue, closure::Closure};
use wasm_bindgen_futures::{JsFuture, spawn_local};
use web_sys::{
    Blob, Event, File, MessageEvent, RtcDataChannel, RtcDataChannelEvent, RtcDataChannelType,
    RtcIceCandidate, RtcIceCandidateInit, RtcPeerConnection, RtcPeerConnectionIceEvent, RtcSdpType,
    RtcSessionDescriptionInit, Url, WebSocket,
};

const SIGNALING_ORIGIN: &str = "ws://127.0.0.1:3340";
const CHUNK_BYTES: u64 = 64 * 1024;
const BUFFER_HIGH_WATERMARK: u32 = 4 * 1024 * 1024;
const BUFFER_LOW_WATERMARK: u32 = 1024 * 1024;
const MAX_RECEIVE_BYTES: u64 = 128 * 1024 * 1024;

pub type StringCallback = Rc<RefCell<Box<dyn FnMut(String)>>>;
pub type StringsCallback = Rc<RefCell<Box<dyn FnMut(Vec<String>)>>>;
pub type ProgressCallback = Rc<RefCell<Box<dyn FnMut(f64, String)>>>;
pub type DownloadCallback = Rc<RefCell<Box<dyn FnMut(String, String)>>>;

#[derive(Clone)]
pub struct ClientCallbacks {
    pub on_status: StringCallback,
    pub on_peers: StringsCallback,
    pub on_text: StringCallback,
    pub on_progress: ProgressCallback,
    pub on_download: DownloadCallback,
    pub on_log: StringCallback,
}

#[derive(Clone)]
pub struct SpikeClient {
    inner: Rc<RefCell<Inner>>,
}

struct Inner {
    peer_id: String,
    peers: Vec<String>,
    callbacks: ClientCallbacks,
    websocket: WebSocket,
    peer_connection: Option<RtcPeerConnection>,
    data_channel: Option<RtcDataChannel>,
    target_peer: Option<String>,
    receive: Option<ReceiveState>,
    object_url: Option<String>,
    websocket_open: Option<Closure<dyn FnMut(Event)>>,
    websocket_message: Option<Closure<dyn FnMut(MessageEvent)>>,
    websocket_close: Option<Closure<dyn FnMut(Event)>>,
    peer_ice: Option<Closure<dyn FnMut(RtcPeerConnectionIceEvent)>>,
    peer_state: Option<Closure<dyn FnMut(Event)>>,
    peer_data_channel: Option<Closure<dyn FnMut(RtcDataChannelEvent)>>,
    data_open: Option<Closure<dyn FnMut(Event)>>,
    data_message: Option<Closure<dyn FnMut(MessageEvent)>>,
    data_close: Option<Closure<dyn FnMut(Event)>>,
}

struct ReceiveState {
    transfer_id: String,
    name: String,
    mime_type: String,
    size: u64,
    received: u64,
    chunks: Vec<Vec<u8>>,
    hasher: Hasher,
}

#[derive(Debug, thiserror::Error)]
pub enum ClientError {
    #[error("浏览器 API 错误：{0}")]
    Browser(String),
    #[error("协议错误：{0}")]
    Protocol(String),
    #[error("DataChannel 尚未打开")]
    DataChannelNotReady,
}

impl SpikeClient {
    pub fn connect(room: &str, callbacks: ClientCallbacks) -> Result<Self, ClientError> {
        let peer_id = format!(
            "peer-{:x}-{:06x}",
            Date::now() as u64,
            (Math::random() * 0xff_ffff as f64) as u32,
        );
        let url = format!("{SIGNALING_ORIGIN}/ws/{room}/{peer_id}");
        let websocket = WebSocket::new(&url).map_err(browser_error)?;
        let client = Self {
            inner: Rc::new(RefCell::new(Inner {
                peer_id,
                peers: Vec::new(),
                callbacks,
                websocket,
                peer_connection: None,
                data_channel: None,
                target_peer: None,
                receive: None,
                object_url: None,
                websocket_open: None,
                websocket_message: None,
                websocket_close: None,
                peer_ice: None,
                peer_state: None,
                peer_data_channel: None,
                data_open: None,
                data_message: None,
                data_close: None,
            })),
        };
        client.install_websocket_handlers();
        Ok(client)
    }

    pub fn peer_id(&self) -> String {
        self.inner.borrow().peer_id.clone()
    }

    pub fn data_channel_ready(&self) -> bool {
        self.inner
            .borrow()
            .data_channel
            .as_ref()
            .is_some_and(|channel| channel.ready_state() == web_sys::RtcDataChannelState::Open)
    }

    pub fn send_text(&self, text: &str) -> Result<(), ClientError> {
        let frame = DataControlFrame::Text {
            text: text.to_owned(),
        };
        self.send_control(&frame)
    }

    pub fn send_file(&self, file: File) {
        let client = self.clone();
        spawn_local(async move {
            if let Err(error) = client.send_file_inner(file).await {
                client.status(format!("文件发送失败：{error}"));
            }
        });
    }

    pub fn close(self) {
        let mut inner = self.inner.borrow_mut();
        if let Some(channel) = inner.data_channel.take() {
            channel.close();
        }
        if let Some(peer_connection) = inner.peer_connection.take() {
            peer_connection.close();
        }
        let _ = inner.websocket.close();
        if let Some(url) = inner.object_url.take() {
            let _ = Url::revoke_object_url(&url);
        }
        inner.receive = None;
    }

    fn install_websocket_handlers(&self) {
        let websocket = self.inner.borrow().websocket.clone();

        let open_client = self.clone();
        let on_open = Closure::<dyn FnMut(Event)>::new(move |_| {
            open_client.status("signaling 已连接，等待另一个 peer".to_owned());
            open_client.log("WebSocket open".to_owned());
        });
        websocket.set_onopen(Some(on_open.as_ref().unchecked_ref()));

        let message_client = self.clone();
        let on_message = Closure::<dyn FnMut(MessageEvent)>::new(move |event: MessageEvent| {
            let Some(text) = event.data().as_string() else {
                message_client.log("忽略非文本 signaling frame".to_owned());
                return;
            };
            match serde_json::from_str::<ServerMessage>(&text) {
                Ok(message) => message_client.handle_server_message(message),
                Err(error) => message_client.status(format!("signaling 解析失败：{error}")),
            }
        });
        websocket.set_onmessage(Some(on_message.as_ref().unchecked_ref()));

        let close_client = self.clone();
        let on_close = Closure::<dyn FnMut(Event)>::new(move |_| {
            close_client.status("signaling 已关闭".to_owned());
            close_client.log("WebSocket close".to_owned());
        });
        websocket.set_onclose(Some(on_close.as_ref().unchecked_ref()));

        let mut inner = self.inner.borrow_mut();
        inner.websocket_open = Some(on_open);
        inner.websocket_message = Some(on_message);
        inner.websocket_close = Some(on_close);
    }

    fn handle_server_message(&self, message: ServerMessage) {
        match message {
            ServerMessage::Peers { peers } => self.replace_peers(peers),
            ServerMessage::PeerJoined { peer_id } => {
                self.add_peer(peer_id.clone());
                if self.inner.borrow().peer_connection.is_none() {
                    let client = self.clone();
                    spawn_local(async move {
                        if let Err(error) = client.create_offer(peer_id).await {
                            client.status(format!("创建 offer 失败：{error}"));
                        }
                    });
                }
            }
            ServerMessage::PeerLeft { peer_id } => {
                self.remove_peer(&peer_id);
                self.status(format!("peer {peer_id} 已离开"));
            }
            ServerMessage::Signal { from, signal } => {
                let client = self.clone();
                spawn_local(async move {
                    if let Err(error) = client.accept_signal(from, signal).await {
                        client.status(format!("处理 signaling 失败：{error}"));
                    }
                });
            }
            ServerMessage::Error { message } => self.status(format!("服务端：{message}")),
        }
    }

    async fn create_offer(&self, target_peer: String) -> Result<(), ClientError> {
        self.log(format!("create offer for {target_peer}"));
        let peer_connection = self.ensure_peer_connection(&target_peer)?;
        self.log("PeerConnection created".to_owned());
        let data_channel = peer_connection.create_data_channel("transfer");
        self.install_data_channel(data_channel);
        self.log("DataChannel created; awaiting createOffer".to_owned());

        let offer_value = JsFuture::from(peer_connection.create_offer())
            .await
            .map_err(browser_error)?;
        self.log("createOffer resolved".to_owned());
        let offer_sdp = description_sdp(&offer_value)?;
        let offer = offer_value.unchecked_into::<RtcSessionDescriptionInit>();
        JsFuture::from(peer_connection.set_local_description(&offer))
            .await
            .map_err(browser_error)?;
        self.log("setLocalDescription resolved".to_owned());
        self.send_signal(&target_peer, Signal::Offer { sdp: offer_sdp })?;
        self.log("offer sent through signaling".to_owned());
        self.status(format!("已向 {target_peer} 发送 offer"));
        Ok(())
    }

    async fn accept_signal(&self, from: String, signal: Signal) -> Result<(), ClientError> {
        match signal {
            Signal::Offer { sdp } => {
                self.log(format!("received offer from {from}"));
                let peer_connection = self.ensure_peer_connection(&from)?;
                let remote = RtcSessionDescriptionInit::new(RtcSdpType::Offer);
                remote.set_sdp(&sdp);
                JsFuture::from(peer_connection.set_remote_description(&remote))
                    .await
                    .map_err(browser_error)?;
                self.log("remote offer applied".to_owned());
                let answer_value = JsFuture::from(peer_connection.create_answer())
                    .await
                    .map_err(browser_error)?;
                let answer_sdp = description_sdp(&answer_value)?;
                let answer = answer_value.unchecked_into::<RtcSessionDescriptionInit>();
                JsFuture::from(peer_connection.set_local_description(&answer))
                    .await
                    .map_err(browser_error)?;
                self.log("local answer applied".to_owned());
                self.send_signal(&from, Signal::Answer { sdp: answer_sdp })?;
                self.log("answer sent through signaling".to_owned());
                self.status(format!("已向 {from} 返回 answer"));
            }
            Signal::Answer { sdp } => {
                let peer_connection = self.current_peer_connection()?;
                let remote = RtcSessionDescriptionInit::new(RtcSdpType::Answer);
                remote.set_sdp(&sdp);
                JsFuture::from(peer_connection.set_remote_description(&remote))
                    .await
                    .map_err(browser_error)?;
                self.status(format!("已接受 {from} 的 answer"));
            }
            Signal::IceCandidate {
                candidate,
                sdp_mid,
                sdp_m_line_index,
            } => {
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
            }
        }
        Ok(())
    }

    fn ensure_peer_connection(&self, target_peer: &str) -> Result<RtcPeerConnection, ClientError> {
        if let Some(existing) = self.inner.borrow().peer_connection.as_ref() {
            return Ok(existing.clone());
        }

        let peer_connection = RtcPeerConnection::new().map_err(browser_error)?;
        self.inner.borrow_mut().target_peer = Some(target_peer.to_owned());

        let ice_client = self.clone();
        let on_ice = Closure::<dyn FnMut(RtcPeerConnectionIceEvent)>::new(
            move |event: RtcPeerConnectionIceEvent| {
                let Some(candidate) = event.candidate() else {
                    ice_client.log("ICE gathering complete".to_owned());
                    return;
                };
                let target = ice_client.inner.borrow().target_peer.clone();
                if let Some(target) = target {
                    let signal = Signal::IceCandidate {
                        candidate: candidate.candidate(),
                        sdp_mid: candidate.sdp_mid(),
                        sdp_m_line_index: candidate.sdp_m_line_index(),
                    };
                    if let Err(error) = ice_client.send_signal(&target, signal) {
                        ice_client.status(format!("发送 ICE 失败：{error}"));
                    }
                }
            },
        );
        peer_connection.set_onicecandidate(Some(on_ice.as_ref().unchecked_ref()));

        let state_client = self.clone();
        let state_connection = peer_connection.clone();
        let on_state = Closure::<dyn FnMut(Event)>::new(move |_| {
            let state = format!("{:?}", state_connection.connection_state());
            state_client.status(format!("PeerConnection {state}"));
            state_client.log(format!("connection state: {state}"));
        });
        peer_connection.set_onconnectionstatechange(Some(on_state.as_ref().unchecked_ref()));

        let channel_client = self.clone();
        let on_data_channel =
            Closure::<dyn FnMut(RtcDataChannelEvent)>::new(move |event: RtcDataChannelEvent| {
                channel_client.install_data_channel(event.channel());
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
        channel.set_buffered_amount_low_threshold(BUFFER_LOW_WATERMARK);

        let open_client = self.clone();
        let on_open = Closure::<dyn FnMut(Event)>::new(move |_| {
            open_client.status("DataChannel 已打开".to_owned());
            open_client.log("DataChannel open".to_owned());
        });
        channel.set_onopen(Some(on_open.as_ref().unchecked_ref()));

        let message_client = self.clone();
        let on_message = Closure::<dyn FnMut(MessageEvent)>::new(move |event: MessageEvent| {
            if let Some(text) = event.data().as_string() {
                match serde_json::from_str::<DataControlFrame>(&text) {
                    Ok(frame) => message_client.handle_control_frame(frame),
                    Err(error) => message_client.status(format!("DataChannel 控制帧无效：{error}")),
                }
                return;
            }

            if event.data().is_instance_of::<ArrayBuffer>() {
                let bytes = Uint8Array::new(&event.data()).to_vec();
                message_client.handle_binary_chunk(bytes);
            }
        });
        channel.set_onmessage(Some(on_message.as_ref().unchecked_ref()));

        let close_client = self.clone();
        let on_close = Closure::<dyn FnMut(Event)>::new(move |_| {
            close_client.status("DataChannel 已关闭".to_owned());
            close_client.log("DataChannel close".to_owned());
        });
        channel.set_onclose(Some(on_close.as_ref().unchecked_ref()));

        let mut inner = self.inner.borrow_mut();
        inner.data_channel = Some(channel);
        inner.data_open = Some(on_open);
        inner.data_message = Some(on_message);
        inner.data_close = Some(on_close);
    }

    fn handle_control_frame(&self, frame: DataControlFrame) {
        match frame {
            DataControlFrame::Text { text } => {
                let callback = self.inner.borrow().callbacks.on_text.clone();
                (callback.borrow_mut())(text);
            }
            DataControlFrame::FileStart {
                transfer_id,
                name,
                mime_type,
                size,
            } => {
                if size > MAX_RECEIVE_BYTES {
                    self.status(format!("拒绝超过 128 MiB 的 spike 文件：{name}"));
                    let _ = self.send_control(&DataControlFrame::Cancel {
                        transfer_id,
                        reason: "receive_limit".to_owned(),
                    });
                    return;
                }
                self.inner.borrow_mut().receive = Some(ReceiveState {
                    transfer_id,
                    name: name.clone(),
                    mime_type,
                    size,
                    received: 0,
                    chunks: Vec::new(),
                    hasher: Hasher::new(),
                });
                self.progress(0.0, format!("准备接收 {name}"));
            }
            DataControlFrame::FileEnd {
                transfer_id,
                blake3,
            } => self.finish_receive(&transfer_id, &blake3),
            DataControlFrame::Cancel {
                transfer_id,
                reason,
            } => {
                self.inner.borrow_mut().receive = None;
                self.status(format!("传输 {transfer_id} 已取消：{reason}"));
            }
        }
    }

    fn handle_binary_chunk(&self, bytes: Vec<u8>) {
        let mut inner = self.inner.borrow_mut();
        let Some(receive) = inner.receive.as_mut() else {
            drop(inner);
            self.status("收到没有 FileStart 的二进制 chunk".to_owned());
            return;
        };
        receive.hasher.update(&bytes);
        receive.received += bytes.len() as u64;
        receive.chunks.push(bytes);
        let ratio = if receive.size == 0 {
            1.0
        } else {
            receive.received as f64 / receive.size as f64
        };
        let label = format!(
            "接收 {}：{} / {} bytes",
            receive.name, receive.received, receive.size
        );
        drop(inner);
        self.progress(ratio * 100.0, label);
    }

    fn finish_receive(&self, transfer_id: &str, expected_hash: &str) {
        let mut inner = self.inner.borrow_mut();
        let Some(receive) = inner.receive.take() else {
            drop(inner);
            self.status("收到没有活动文件的 FileEnd".to_owned());
            return;
        };
        if receive.transfer_id != transfer_id {
            drop(inner);
            self.status("FileEnd transfer id 不匹配".to_owned());
            return;
        }
        let actual_hash = receive.hasher.finalize().to_hex().to_string();
        if receive.received != receive.size || actual_hash != expected_hash {
            drop(inner);
            self.status(format!(
                "完整性失败：bytes {} / {}，hash {} / {}",
                receive.received, receive.size, actual_hash, expected_hash
            ));
            return;
        }

        if let Some(previous) = inner.object_url.take() {
            let _ = Url::revoke_object_url(&previous);
        }

        let parts = Array::new();
        for chunk in &receive.chunks {
            let array = Uint8Array::from(chunk.as_slice());
            parts.push(&array.buffer());
        }
        let options = web_sys::BlobPropertyBag::new();
        options.set_type(&receive.mime_type);
        let Ok(blob) = Blob::new_with_u8_array_sequence_and_options(&parts, &options) else {
            drop(inner);
            self.status("创建下载 Blob 失败".to_owned());
            return;
        };
        let Ok(url) = Url::create_object_url_with_blob(&blob) else {
            drop(inner);
            self.status("创建下载 URL 失败".to_owned());
            return;
        };
        inner.object_url = Some(url.clone());
        let callback = inner.callbacks.on_download.clone();
        let name = receive.name.clone();
        drop(inner);
        (callback.borrow_mut())(name.clone(), url);
        self.progress(100.0, format!("{name} 完整性校验通过"));
    }

    async fn send_file_inner(&self, file: File) -> Result<(), ClientError> {
        let size = file.size() as u64;
        if size > MAX_RECEIVE_BYTES {
            return Err(ClientError::Protocol("spike 文件上限为 128 MiB".to_owned()));
        }
        let transfer_id = format!("transfer-{:x}", Date::now() as u64);
        self.send_control(&DataControlFrame::FileStart {
            transfer_id: transfer_id.clone(),
            name: file.name(),
            mime_type: file.type_(),
            size,
        })?;

        let channel = self.current_data_channel()?;
        let mut hasher = Hasher::new();
        let mut offset = 0_u64;
        let mut max_buffered = 0_u32;

        while offset < size {
            while channel.buffered_amount() > BUFFER_HIGH_WATERMARK {
                max_buffered = max_buffered.max(channel.buffered_amount());
                TimeoutFuture::new(12).await;
            }

            let end = (offset + CHUNK_BYTES).min(size);
            let blob = file
                .slice_with_f64_and_f64(offset as f64, end as f64)
                .map_err(browser_error)?;
            let array_buffer = JsFuture::from(blob.array_buffer())
                .await
                .map_err(browser_error)?
                .dyn_into::<ArrayBuffer>()
                .map_err(browser_error)?;
            let bytes = Uint8Array::new(&array_buffer).to_vec();
            hasher.update(&bytes);
            channel
                .send_with_array_buffer(&array_buffer)
                .map_err(browser_error)?;
            max_buffered = max_buffered.max(channel.buffered_amount());
            offset = end;
            let ratio = if size == 0 {
                1.0
            } else {
                offset as f64 / size as f64
            };
            self.progress(
                ratio * 100.0,
                format!("发送 {}：{} / {} bytes", file.name(), offset, size),
            );
        }

        self.send_control(&DataControlFrame::FileEnd {
            transfer_id,
            blake3: hasher.finalize().to_hex().to_string(),
        })?;
        self.log(format!(
            "send complete; max buffered_amount={max_buffered} bytes"
        ));
        Ok(())
    }

    fn send_control(&self, frame: &DataControlFrame) -> Result<(), ClientError> {
        let channel = self.current_data_channel()?;
        let json = serde_json::to_string(frame)
            .map_err(|error| ClientError::Protocol(error.to_string()))?;
        channel.send_with_str(&json).map_err(browser_error)
    }

    fn send_signal(&self, target: &str, signal: Signal) -> Result<(), ClientError> {
        let message = ClientMessage::Signal {
            to: target.to_owned(),
            signal,
        };
        let json = serde_json::to_string(&message)
            .map_err(|error| ClientError::Protocol(error.to_string()))?;
        self.inner
            .borrow()
            .websocket
            .send_with_str(&json)
            .map_err(browser_error)
    }

    fn current_peer_connection(&self) -> Result<RtcPeerConnection, ClientError> {
        self.inner
            .borrow()
            .peer_connection
            .clone()
            .ok_or_else(|| ClientError::Protocol("PeerConnection 尚未创建".to_owned()))
    }

    fn current_data_channel(&self) -> Result<RtcDataChannel, ClientError> {
        let channel = self
            .inner
            .borrow()
            .data_channel
            .clone()
            .ok_or(ClientError::DataChannelNotReady)?;
        if channel.ready_state() != web_sys::RtcDataChannelState::Open {
            return Err(ClientError::DataChannelNotReady);
        }
        Ok(channel)
    }

    fn replace_peers(&self, peers: Vec<String>) {
        self.inner.borrow_mut().peers = peers.clone();
        let callback = self.inner.borrow().callbacks.on_peers.clone();
        (callback.borrow_mut())(peers);
    }

    fn add_peer(&self, peer_id: String) {
        let peers = {
            let mut inner = self.inner.borrow_mut();
            if !inner.peers.contains(&peer_id) {
                inner.peers.push(peer_id);
            }
            inner.peers.clone()
        };
        let callback = self.inner.borrow().callbacks.on_peers.clone();
        (callback.borrow_mut())(peers);
    }

    fn remove_peer(&self, peer_id: &str) {
        let peers = {
            let mut inner = self.inner.borrow_mut();
            inner.peers.retain(|peer| peer != peer_id);
            inner.peers.clone()
        };
        let callback = self.inner.borrow().callbacks.on_peers.clone();
        (callback.borrow_mut())(peers);
    }

    fn status(&self, message: String) {
        let callback = self.inner.borrow().callbacks.on_status.clone();
        (callback.borrow_mut())(message);
    }

    fn progress(&self, value: f64, label: String) {
        let callback = self.inner.borrow().callbacks.on_progress.clone();
        (callback.borrow_mut())(value, label);
    }

    fn log(&self, message: String) {
        let callback = self.inner.borrow().callbacks.on_log.clone();
        (callback.borrow_mut())(message);
    }
}

fn browser_error(value: JsValue) -> ClientError {
    ClientError::Browser(value.as_string().unwrap_or_else(|| format!("{value:?}")))
}

fn description_sdp(value: &JsValue) -> Result<String, ClientError> {
    Reflect::get(value, &JsValue::from_str("sdp"))
        .map_err(browser_error)?
        .as_string()
        .ok_or_else(|| ClientError::Protocol("RTC description 缺少 sdp".to_owned()))
}
