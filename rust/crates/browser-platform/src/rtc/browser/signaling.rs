use js_sys::{ArrayBuffer, Uint8Array};
use p2p_protocol::parse_control_message;
use p2p_transfer::BackpressurePolicy;
use wasm_bindgen::{JsCast, JsValue, closure::Closure};
use wasm_bindgen_futures::{JsFuture, spawn_local};
use web_sys::{
    Event, MessageEvent, RtcDataChannel, RtcDataChannelEvent, RtcDataChannelState,
    RtcDataChannelType, RtcIceCandidate, RtcIceCandidateInit, RtcPeerConnection,
    RtcPeerConnectionIceEvent, RtcSdpType, RtcSessionDescriptionInit,
};

use super::super::{
    BrowserPlatformError, OfferStart, RtcConnectionPhase, RtcEvent, Signal, SignalAcceptance,
};
use super::{
    RtcPeer, browser_error,
    connection::{local_description_sdp, map_connection_state, rtc_configuration},
};

const NEGOTIATION_SIGNAL_LIMIT: usize = 64;

enum PendingSignalTask {
    Offer {
        peer_connection: RtcPeerConnection,
        connection_epoch: u64,
        negotiation_id: String,
        from_peer: String,
        sdp: String,
    },
    Answer {
        peer_connection: RtcPeerConnection,
        connection_epoch: u64,
        negotiation_id: String,
        sdp: String,
    },
    IceCandidate {
        peer_connection: RtcPeerConnection,
        connection_epoch: u64,
        negotiation_id: String,
        signal: Signal,
    },
}

enum PreparedSignal {
    Task(PendingSignalTask),
    Deferred,
    Ignored,
}

impl PendingSignalTask {
    fn connection_epoch(&self) -> u64 {
        match self {
            Self::Offer {
                connection_epoch, ..
            }
            | Self::Answer {
                connection_epoch, ..
            }
            | Self::IceCandidate {
                connection_epoch, ..
            } => *connection_epoch,
        }
    }

    fn negotiation_id(&self) -> &str {
        match self {
            Self::Offer { negotiation_id, .. }
            | Self::Answer { negotiation_id, .. }
            | Self::IceCandidate { negotiation_id, .. } => negotiation_id,
        }
    }
}

impl RtcPeer {
    pub fn start_offer(&self, target_peer: String) -> Result<OfferStart, BrowserPlatformError> {
        {
            let inner = self.inner.borrow();
            if inner.negotiating
                || inner.target_peer.as_ref() == Some(&target_peer)
                    && inner.peer_connection.is_some()
            {
                return Ok(OfferStart::AlreadyActive);
            }
        }
        let negotiation_id = generate_negotiation_id()?;
        let (peer_connection, connection_epoch) =
            self.ensure_peer_connection(&target_peer, &negotiation_id)?;
        {
            let mut inner = self.inner.borrow_mut();
            if inner.connection_epoch != connection_epoch {
                return Ok(OfferStart::AlreadyActive);
            }
            inner.negotiating = true;
        }
        let channel = peer_connection.create_data_channel("p2p-transfer");
        self.install_data_channel(channel, connection_epoch);
        let peer = self.clone();
        spawn_local(async move {
            if let Err(error) = peer
                .create_offer(
                    peer_connection,
                    connection_epoch,
                    negotiation_id.clone(),
                    target_peer,
                )
                .await
                && peer.negotiation_is_current(connection_epoch, &negotiation_id)
            {
                peer.finish_negotiating(connection_epoch);
                peer.negotiation_failed(error.to_string());
            }
        });
        Ok(OfferStart::Started)
    }

    pub fn accept_signal(
        &self,
        from_peer: String,
        negotiation_id: String,
        signal: Signal,
    ) -> Result<SignalAcceptance, BrowserPlatformError> {
        let task = match self.prepare_signal_task(from_peer, negotiation_id, signal)? {
            PreparedSignal::Task(task) => task,
            PreparedSignal::Deferred => return Ok(SignalAcceptance::Deferred),
            PreparedSignal::Ignored => return Ok(SignalAcceptance::Ignored),
        };
        let connection_epoch = task.connection_epoch();
        let negotiation_id = task.negotiation_id().to_owned();
        let peer = self.clone();
        spawn_local(async move {
            if let Err(error) = peer.accept_signal_task(task).await
                && peer.negotiation_is_current(connection_epoch, &negotiation_id)
            {
                peer.clear_remote_description_pending(connection_epoch, &negotiation_id);
                peer.negotiation_failed(error.to_string());
            }
        });
        Ok(SignalAcceptance::Scheduled)
    }

    async fn create_offer(
        &self,
        peer_connection: RtcPeerConnection,
        connection_epoch: u64,
        negotiation_id: String,
        target_peer: String,
    ) -> Result<(), BrowserPlatformError> {
        let Some(offer_value) = self.current_promise_result(
            connection_epoch,
            JsFuture::from(peer_connection.create_offer()).await,
        )?
        else {
            return Ok(());
        };
        let offer = offer_value.unchecked_into::<RtcSessionDescriptionInit>();
        if self
            .current_promise_result(
                connection_epoch,
                JsFuture::from(peer_connection.set_local_description(&offer)).await,
            )?
            .is_none()
        {
            return Ok(());
        }
        let offer_sdp = local_description_sdp(&peer_connection)?;
        self.finish_negotiating(connection_epoch);
        self.announce_local_description(
            connection_epoch,
            &negotiation_id,
            target_peer,
            Signal::Offer { sdp: offer_sdp },
        );
        Ok(())
    }

    fn prepare_signal_task(
        &self,
        from_peer: String,
        negotiation_id: String,
        signal: Signal,
    ) -> Result<PreparedSignal, BrowserPlatformError> {
        match signal {
            Signal::Offer { sdp } => {
                let (same_negotiation, should_replace) = {
                    let inner = self.inner.borrow();
                    let has_connection = inner.peer_connection.is_some();
                    (
                        has_connection
                            && inner.target_peer.as_deref() == Some(from_peer.as_str())
                            && inner.negotiation_id.as_deref() == Some(negotiation_id.as_str()),
                        has_connection,
                    )
                };
                if same_negotiation {
                    return Ok(PreparedSignal::Ignored);
                }
                if should_replace {
                    self.prepare_reconnect();
                }
                let (peer_connection, connection_epoch) =
                    self.ensure_peer_connection(&from_peer, &negotiation_id)?;
                Ok(PreparedSignal::Task(PendingSignalTask::Offer {
                    peer_connection,
                    connection_epoch,
                    negotiation_id,
                    from_peer,
                    sdp,
                }))
            }
            Signal::Answer { sdp } => {
                let mut inner = self.inner.borrow_mut();
                if inner.target_peer.as_deref() != Some(from_peer.as_str()) {
                    return Ok(PreparedSignal::Ignored);
                }
                if inner.negotiation_id.as_deref() != Some(negotiation_id.as_str()) {
                    return Ok(PreparedSignal::Ignored);
                }
                let Some(peer_connection) = inner.peer_connection.clone() else {
                    return Ok(PreparedSignal::Ignored);
                };
                if !inner.local_description_announced
                    || inner.remote_description_pending
                    || inner.remote_description_set
                {
                    return Ok(PreparedSignal::Ignored);
                }
                inner.remote_description_pending = true;
                Ok(PreparedSignal::Task(PendingSignalTask::Answer {
                    peer_connection,
                    connection_epoch: inner.connection_epoch,
                    negotiation_id,
                    sdp,
                }))
            }
            candidate @ Signal::IceCandidate { .. } => {
                let mut inner = self.inner.borrow_mut();
                if inner
                    .target_peer
                    .as_deref()
                    .is_some_and(|target| target != from_peer)
                {
                    return Ok(PreparedSignal::Ignored);
                }
                if inner
                    .negotiation_id
                    .as_deref()
                    .is_some_and(|current| current != negotiation_id)
                {
                    return Ok(PreparedSignal::Ignored);
                }
                if inner.remote_description_set
                    && let Some(peer_connection) = inner.peer_connection.clone()
                {
                    return Ok(PreparedSignal::Task(PendingSignalTask::IceCandidate {
                        peer_connection,
                        connection_epoch: inner.connection_epoch,
                        negotiation_id,
                        signal: candidate,
                    }));
                }
                if inner.pending_remote_candidates.len() >= NEGOTIATION_SIGNAL_LIMIT {
                    return Err(BrowserPlatformError::Browser(
                        "too many queued ICE candidates".to_owned(),
                    ));
                }
                inner
                    .pending_remote_candidates
                    .push((from_peer, negotiation_id, candidate));
                Ok(PreparedSignal::Deferred)
            }
        }
    }

    async fn accept_signal_task(
        &self,
        task: PendingSignalTask,
    ) -> Result<(), BrowserPlatformError> {
        match task {
            PendingSignalTask::Offer {
                peer_connection,
                connection_epoch,
                negotiation_id,
                from_peer,
                sdp,
            } => {
                let remote = RtcSessionDescriptionInit::new(RtcSdpType::Offer);
                remote.set_sdp(&sdp);
                if self
                    .current_promise_result(
                        connection_epoch,
                        JsFuture::from(peer_connection.set_remote_description(&remote)).await,
                    )?
                    .is_none()
                {
                    return Ok(());
                }
                if !self.mark_remote_description_set(connection_epoch) {
                    return Ok(());
                }
                self.apply_pending_candidates(
                    peer_connection.clone(),
                    connection_epoch,
                    &negotiation_id,
                )
                .await?;
                let Some(answer_value) = self.current_promise_result(
                    connection_epoch,
                    JsFuture::from(peer_connection.create_answer()).await,
                )?
                else {
                    return Ok(());
                };
                let answer = answer_value.unchecked_into::<RtcSessionDescriptionInit>();
                if self
                    .current_promise_result(
                        connection_epoch,
                        JsFuture::from(peer_connection.set_local_description(&answer)).await,
                    )?
                    .is_none()
                {
                    return Ok(());
                }
                let answer_sdp = local_description_sdp(&peer_connection)?;
                self.announce_local_description(
                    connection_epoch,
                    &negotiation_id,
                    from_peer,
                    Signal::Answer { sdp: answer_sdp },
                );
            }
            PendingSignalTask::Answer {
                peer_connection,
                connection_epoch,
                negotiation_id,
                sdp,
            } => {
                let remote = RtcSessionDescriptionInit::new(RtcSdpType::Answer);
                remote.set_sdp(&sdp);
                if self
                    .current_promise_result(
                        connection_epoch,
                        JsFuture::from(peer_connection.set_remote_description(&remote)).await,
                    )?
                    .is_none()
                {
                    return Ok(());
                }
                if !self.mark_remote_description_set(connection_epoch) {
                    return Ok(());
                }
                self.apply_pending_candidates(peer_connection, connection_epoch, &negotiation_id)
                    .await?;
            }
            PendingSignalTask::IceCandidate {
                peer_connection,
                connection_epoch,
                negotiation_id,
                signal,
            } => {
                self.apply_ice_candidate(
                    peer_connection,
                    connection_epoch,
                    &negotiation_id,
                    signal,
                )
                .await?;
            }
        }
        Ok(())
    }

    async fn apply_pending_candidates(
        &self,
        peer_connection: RtcPeerConnection,
        connection_epoch: u64,
        negotiation_id: &str,
    ) -> Result<(), BrowserPlatformError> {
        let pending = {
            let mut inner = self.inner.borrow_mut();
            if inner.connection_epoch != connection_epoch
                || inner.negotiation_id.as_deref() != Some(negotiation_id)
                || inner.peer_connection.is_none()
            {
                return Ok(());
            }
            let target_peer = inner.target_peer.clone();
            std::mem::take(&mut inner.pending_remote_candidates)
                .into_iter()
                .filter(|(from_peer, candidate_negotiation_id, _)| {
                    target_peer.as_ref() == Some(from_peer)
                        && candidate_negotiation_id == negotiation_id
                })
                .map(|(_, _, signal)| signal)
                .collect::<Vec<_>>()
        };
        for signal in pending {
            self.apply_ice_candidate(
                peer_connection.clone(),
                connection_epoch,
                negotiation_id,
                signal,
            )
            .await?;
            if !self.negotiation_is_current(connection_epoch, negotiation_id) {
                return Ok(());
            }
        }
        Ok(())
    }

    async fn apply_ice_candidate(
        &self,
        peer_connection: RtcPeerConnection,
        connection_epoch: u64,
        negotiation_id: &str,
        signal: Signal,
    ) -> Result<(), BrowserPlatformError> {
        let Signal::IceCandidate {
            candidate,
            sdp_mid,
            sdp_m_line_index,
        } = signal
        else {
            return Ok(());
        };
        let candidate_init = RtcIceCandidateInit::new(&candidate);
        candidate_init.set_sdp_mid(sdp_mid.as_deref());
        candidate_init.set_sdp_m_line_index(sdp_m_line_index);
        let candidate = RtcIceCandidate::new(&candidate_init).map_err(browser_error)?;
        if !self.negotiation_is_current(connection_epoch, negotiation_id) {
            return Ok(());
        }
        self.current_promise_result(
            connection_epoch,
            JsFuture::from(
                peer_connection.add_ice_candidate_with_opt_rtc_ice_candidate(Some(&candidate)),
            )
            .await,
        )?;
        Ok(())
    }

    fn ensure_peer_connection(
        &self,
        target_peer: &str,
        negotiation_id: &str,
    ) -> Result<(RtcPeerConnection, u64), BrowserPlatformError> {
        let existing = {
            let inner = self.inner.borrow();
            inner
                .peer_connection
                .clone()
                .zip(inner.target_peer.clone())
                .zip(inner.negotiation_id.clone())
                .map(|((connection, target), existing_negotiation_id)| {
                    (
                        connection,
                        target,
                        existing_negotiation_id,
                        inner.connection_epoch,
                    )
                })
        };
        let replacing_existing =
            if let Some((existing, existing_target, existing_negotiation_id, connection_epoch)) =
                existing
            {
                if existing_target == target_peer && existing_negotiation_id == negotiation_id {
                    return Ok((existing, connection_epoch));
                }
                true
            } else {
                false
            };

        let rtc_config = self.inner.borrow().rtc_config.clone();
        if !rtc_config.is_valid() {
            return Err(BrowserPlatformError::RtcConfigExpired);
        }
        if replacing_existing {
            self.reset();
        }

        let configuration = rtc_configuration(rtc_config.response());
        let peer_connection =
            RtcPeerConnection::new_with_configuration(&configuration).map_err(browser_error)?;
        let connection_epoch = {
            let mut inner = self.inner.borrow_mut();
            inner.connection_epoch = inner.connection_epoch.wrapping_add(1);
            inner.target_peer = Some(target_peer.to_owned());
            inner.negotiation_id = Some(negotiation_id.to_owned());
            inner.local_description_announced = false;
            inner.remote_description_pending = false;
            inner.remote_description_set = false;
            inner.pending_local_candidates.clear();
            inner
                .pending_remote_candidates
                .retain(|(from_peer, candidate_negotiation_id, _)| {
                    from_peer == target_peer && candidate_negotiation_id == negotiation_id
                });
            inner.connection_epoch
        };

        let ice_peer = self.clone();
        let ice_negotiation_id = negotiation_id.to_owned();
        let on_ice = Closure::<dyn FnMut(RtcPeerConnectionIceEvent)>::new(
            move |event: RtcPeerConnectionIceEvent| {
                if !ice_peer.negotiation_is_current(connection_epoch, &ice_negotiation_id) {
                    return;
                }
                let Some(candidate) = event.candidate() else {
                    return;
                };
                ice_peer.queue_or_emit_local_candidate(
                    connection_epoch,
                    &ice_negotiation_id,
                    Signal::IceCandidate {
                        candidate: candidate.candidate(),
                        sdp_mid: candidate.sdp_mid(),
                        sdp_m_line_index: candidate.sdp_m_line_index(),
                    },
                );
            },
        );
        peer_connection.set_onicecandidate(Some(on_ice.as_ref().unchecked_ref()));

        let state_peer = self.clone();
        let state_connection = peer_connection.clone();
        let on_state = Closure::<dyn FnMut(Event)>::new(move |_| {
            if !state_peer.connection_epoch_is_current(connection_epoch) {
                return;
            }
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
                if channel_peer.connection_epoch_is_current(connection_epoch) {
                    channel_peer.install_data_channel(event.channel(), connection_epoch);
                }
            });
        peer_connection.set_ondatachannel(Some(on_data_channel.as_ref().unchecked_ref()));

        let mut inner = self.inner.borrow_mut();
        inner.peer_connection = Some(peer_connection.clone());
        inner.peer_ice = Some(on_ice);
        inner.peer_state = Some(on_state);
        inner.peer_data_channel = Some(on_data_channel);
        Ok((peer_connection, connection_epoch))
    }

    fn install_data_channel(&self, channel: RtcDataChannel, connection_epoch: u64) {
        if !self.connection_epoch_is_current(connection_epoch) {
            channel.close();
            return;
        }
        channel.set_binary_type(RtcDataChannelType::Arraybuffer);
        channel.set_buffered_amount_low_threshold(
            BackpressurePolicy::default().low_watermark_bytes as u32,
        );

        let open_peer = self.clone();
        let on_open = Closure::<dyn FnMut(Event)>::new(move |_| {
            if open_peer.connection_epoch_is_current(connection_epoch) {
                open_peer.data_channel_opened();
            }
        });
        channel.set_onopen(Some(on_open.as_ref().unchecked_ref()));

        let message_peer = self.clone();
        let on_message = Closure::<dyn FnMut(MessageEvent)>::new(move |event: MessageEvent| {
            if !message_peer.connection_epoch_is_current(connection_epoch) {
                return;
            }
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
            if !close_peer.connection_epoch_is_current(connection_epoch) {
                return;
            }
            close_peer.suspend_stream_for_reconnect();
            close_peer.emit(RtcEvent::ConnectionState(RtcConnectionPhase::Closed));
        });
        channel.set_onclose(Some(on_close.as_ref().unchecked_ref()));

        let error_peer = self.clone();
        let on_error = Closure::<dyn FnMut(Event)>::new(move |_| {
            if !error_peer.connection_epoch_is_current(connection_epoch) {
                return;
            }
            error_peer.suspend_stream_for_reconnect();
            error_peer.emit(RtcEvent::ConnectionState(RtcConnectionPhase::Failed));
        });
        channel.set_onerror(Some(on_error.as_ref().unchecked_ref()));

        let already_open = channel.ready_state() == RtcDataChannelState::Open;
        let mut inner = self.inner.borrow_mut();
        if inner.connection_epoch != connection_epoch || inner.peer_connection.is_none() {
            drop(inner);
            channel.set_onopen(None);
            channel.set_onmessage(None);
            channel.set_onclose(None);
            channel.set_onerror(None);
            channel.set_onbufferedamountlow(None);
            channel.close();
            return;
        }
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
        if already_open && self.connection_epoch_is_current(connection_epoch) {
            self.data_channel_opened();
        }
    }

    fn queue_or_emit_local_candidate(
        &self,
        connection_epoch: u64,
        negotiation_id: &str,
        signal: Signal,
    ) {
        let mut emit_to = None;
        let mut overflowed = false;
        {
            let mut inner = self.inner.borrow_mut();
            if inner.connection_epoch != connection_epoch
                || inner.negotiation_id.as_deref() != Some(negotiation_id)
                || inner.peer_connection.is_none()
            {
                return;
            }
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
            self.negotiation_failed("too many queued local ICE candidates".to_owned());
        } else if let Some(to_peer_id) = emit_to {
            self.emit(RtcEvent::OutboundSignal {
                to_peer_id,
                negotiation_id: negotiation_id.to_owned(),
                signal,
            });
        }
    }

    fn announce_local_description(
        &self,
        connection_epoch: u64,
        negotiation_id: &str,
        to_peer_id: String,
        signal: Signal,
    ) {
        let candidates = {
            let mut inner = self.inner.borrow_mut();
            if inner.connection_epoch != connection_epoch
                || inner.negotiation_id.as_deref() != Some(negotiation_id)
                || inner.peer_connection.is_none()
            {
                return;
            }
            inner.local_description_announced = true;
            std::mem::take(&mut inner.pending_local_candidates)
        };
        self.emit(RtcEvent::OutboundSignal {
            to_peer_id: to_peer_id.clone(),
            negotiation_id: negotiation_id.to_owned(),
            signal,
        });
        for signal in candidates {
            if !self.negotiation_is_current(connection_epoch, negotiation_id) {
                return;
            }
            self.emit(RtcEvent::OutboundSignal {
                to_peer_id: to_peer_id.clone(),
                negotiation_id: negotiation_id.to_owned(),
                signal,
            });
        }
    }

    fn current_promise_result<T>(
        &self,
        connection_epoch: u64,
        result: Result<T, JsValue>,
    ) -> Result<Option<T>, BrowserPlatformError> {
        if !self.connection_epoch_is_current(connection_epoch) {
            return Ok(None);
        }
        result.map(Some).map_err(browser_error)
    }

    fn finish_negotiating(&self, connection_epoch: u64) -> bool {
        let mut inner = self.inner.borrow_mut();
        if inner.connection_epoch != connection_epoch || inner.peer_connection.is_none() {
            return false;
        }
        inner.negotiating = false;
        true
    }

    fn negotiation_is_current(&self, connection_epoch: u64, negotiation_id: &str) -> bool {
        let inner = self.inner.borrow();
        inner.connection_epoch == connection_epoch
            && inner.negotiation_id.as_deref() == Some(negotiation_id)
            && inner.peer_connection.is_some()
    }

    fn mark_remote_description_set(&self, connection_epoch: u64) -> bool {
        let mut inner = self.inner.borrow_mut();
        if inner.connection_epoch != connection_epoch || inner.peer_connection.is_none() {
            return false;
        }
        inner.remote_description_pending = false;
        inner.remote_description_set = true;
        true
    }

    fn clear_remote_description_pending(&self, connection_epoch: u64, negotiation_id: &str) {
        let mut inner = self.inner.borrow_mut();
        if inner.connection_epoch == connection_epoch
            && inner.negotiation_id.as_deref() == Some(negotiation_id)
            && inner.peer_connection.is_some()
        {
            inner.remote_description_pending = false;
        }
    }
}

fn generate_negotiation_id() -> Result<String, BrowserPlatformError> {
    const HEX: &[u8; 16] = b"0123456789abcdef";

    let window = web_sys::window()
        .ok_or_else(|| BrowserPlatformError::Browser("Window is unavailable".to_owned()))?;
    let crypto = window.crypto().map_err(browser_error)?;
    let mut bytes = [0_u8; 16];
    crypto
        .get_random_values_with_u8_array(&mut bytes)
        .map_err(browser_error)?;

    let mut token = String::with_capacity(2 + bytes.len() * 2);
    token.push_str("n_");
    for byte in bytes {
        token.push(HEX[(byte >> 4) as usize] as char);
        token.push(HEX[(byte & 0x0f) as usize] as char);
    }
    Ok(token)
}
