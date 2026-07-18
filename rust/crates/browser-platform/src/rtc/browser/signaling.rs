use js_sys::{ArrayBuffer, Uint8Array};
use p2p_protocol::parse_control_message;
use p2p_transfer::BackpressurePolicy;
use wasm_bindgen::{JsCast, closure::Closure};
use wasm_bindgen_futures::{JsFuture, spawn_local};
use web_sys::{
    Event, MessageEvent, RtcDataChannel, RtcDataChannelEvent, RtcDataChannelState,
    RtcDataChannelType, RtcIceCandidate, RtcIceCandidateInit, RtcPeerConnection,
    RtcPeerConnectionIceEvent, RtcSdpType, RtcSessionDescriptionInit,
};

use super::super::{BrowserPlatformError, RtcConnectionPhase, RtcEvent, Signal};
use super::{
    RtcPeer, browser_error,
    connection::{description_sdp, map_connection_state, rtc_configuration},
};

const NEGOTIATION_SIGNAL_LIMIT: usize = 64;

impl RtcPeer {
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

    pub fn accept_signal(&self, from_peer: String, signal: Signal) {
        let peer = self.clone();
        spawn_local(async move {
            if let Err(error) = peer.accept_signal_inner(from_peer, signal).await {
                peer.fail(None, error.to_string());
            }
        });
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
}
