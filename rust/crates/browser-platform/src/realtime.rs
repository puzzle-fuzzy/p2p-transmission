#[cfg(target_arch = "wasm32")]
use p2p_protocol::CURRENT_PROTOCOL;
use p2p_protocol::ClientRealtimeMessage;
#[cfg(any(target_arch = "wasm32", test))]
use p2p_protocol::{ServerRealtimeMessage, Validate};

use crate::{BrowserPlatformError, RealtimeEvent};

#[cfg(any(target_arch = "wasm32", test))]
fn decode_server_message(text: &str) -> Result<ServerRealtimeMessage, BrowserPlatformError> {
    let message = serde_json::from_str::<ServerRealtimeMessage>(text)
        .map_err(|error| BrowserPlatformError::Decode(error.to_string()))?;
    message
        .validate()
        .map_err(|error| BrowserPlatformError::Decode(error.to_string()))?;
    Ok(message)
}

#[cfg(target_arch = "wasm32")]
pub struct RealtimeConnection {
    socket: web_sys::WebSocket,
    _heartbeat: gloo_timers::callback::Interval,
    _open: wasm_bindgen::closure::Closure<dyn FnMut(web_sys::Event)>,
    _message: wasm_bindgen::closure::Closure<dyn FnMut(web_sys::MessageEvent)>,
    _error: wasm_bindgen::closure::Closure<dyn FnMut(web_sys::Event)>,
    _close: wasm_bindgen::closure::Closure<dyn FnMut(web_sys::CloseEvent)>,
}

#[cfg(target_arch = "wasm32")]
impl RealtimeConnection {
    pub fn send(&self, message: &ClientRealtimeMessage) -> Result<(), BrowserPlatformError> {
        let json = serde_json::to_string(message)
            .map_err(|error| BrowserPlatformError::RealtimeEncode(error.to_string()))?;
        self.socket
            .send_with_str(&json)
            .map_err(|error| BrowserPlatformError::Browser(format!("{error:?}")))
    }
}

#[cfg(target_arch = "wasm32")]
impl Drop for RealtimeConnection {
    fn drop(&mut self) {
        self.socket.set_onopen(None);
        self.socket.set_onmessage(None);
        self.socket.set_onerror(None);
        self.socket.set_onclose(None);
        let _ = self.socket.close();
    }
}

#[cfg(not(target_arch = "wasm32"))]
pub struct RealtimeConnection;

#[cfg(not(target_arch = "wasm32"))]
impl RealtimeConnection {
    pub fn send(&self, _message: &ClientRealtimeMessage) -> Result<(), BrowserPlatformError> {
        Err(BrowserPlatformError::UnsupportedTarget)
    }
}

#[cfg(target_arch = "wasm32")]
pub fn connect_realtime(
    initial_message: ClientRealtimeMessage,
    on_event: impl FnMut(RealtimeEvent) + 'static,
) -> Result<RealtimeConnection, BrowserPlatformError> {
    use std::{
        cell::{Cell, RefCell},
        rc::Rc,
    };

    use wasm_bindgen::{JsCast, closure::Closure};

    let window = web_sys::window().ok_or(BrowserPlatformError::MissingWindow)?;
    let location = window.location();
    let scheme = if location
        .protocol()
        .map_err(|error| BrowserPlatformError::Browser(format!("{error:?}")))?
        == "https:"
    {
        "wss"
    } else {
        "ws"
    };
    let host = location
        .host()
        .map_err(|error| BrowserPlatformError::Browser(format!("{error:?}")))?;
    let socket = web_sys::WebSocket::new(&format!("{scheme}://{host}/realtime"))
        .map_err(|error| BrowserPlatformError::Browser(format!("{error:?}")))?;
    let callback = Rc::new(RefCell::new(on_event));
    let initial_json = serde_json::to_string(&initial_message)
        .map_err(|error| BrowserPlatformError::RealtimeEncode(error.to_string()))?;

    let open_socket = socket.clone();
    let open_callback = Rc::clone(&callback);
    let open = Closure::wrap(Box::new(move |_event: web_sys::Event| {
        if let Err(error) = open_socket.send_with_str(&initial_json) {
            open_callback.borrow_mut()(RealtimeEvent::Error(format!("{error:?}")));
            return;
        }
        open_callback.borrow_mut()(RealtimeEvent::Open);
    }) as Box<dyn FnMut(_)>);
    socket.set_onopen(Some(open.as_ref().unchecked_ref()));

    let message_callback = Rc::clone(&callback);
    let message = Closure::wrap(Box::new(move |event: web_sys::MessageEvent| {
        let Some(text) = event.data().as_string() else {
            message_callback.borrow_mut()(RealtimeEvent::Error(
                "realtime server sent a non-text frame".to_owned(),
            ));
            return;
        };
        match decode_server_message(&text) {
            Ok(message) => message_callback.borrow_mut()(RealtimeEvent::Message(message)),
            Err(error) => message_callback.borrow_mut()(RealtimeEvent::Error(error.to_string())),
        }
    }) as Box<dyn FnMut(_)>);
    socket.set_onmessage(Some(message.as_ref().unchecked_ref()));

    let error_callback = Rc::clone(&callback);
    let error = Closure::wrap(Box::new(move |_event: web_sys::Event| {
        error_callback.borrow_mut()(RealtimeEvent::Error(
            "realtime connection failed".to_owned(),
        ));
    }) as Box<dyn FnMut(_)>);
    socket.set_onerror(Some(error.as_ref().unchecked_ref()));

    let close_callback = callback;
    let close = Closure::wrap(Box::new(move |event: web_sys::CloseEvent| {
        close_callback.borrow_mut()(RealtimeEvent::Closed {
            code: event.code(),
            reason: event.reason(),
        });
    }) as Box<dyn FnMut(_)>);
    socket.set_onclose(Some(close.as_ref().unchecked_ref()));

    let heartbeat_socket = socket.clone();
    let heartbeat_sequence = Rc::new(Cell::new(0_u64));
    let heartbeat = gloo_timers::callback::Interval::new(30_000, move || {
        if heartbeat_socket.ready_state() != web_sys::WebSocket::OPEN {
            return;
        }
        let sequence = heartbeat_sequence.get().saturating_add(1);
        heartbeat_sequence.set(sequence);
        let message = ClientRealtimeMessage::Heartbeat {
            version: CURRENT_PROTOCOL,
            nonce: format!("heartbeat_{sequence:x}"),
        };
        if let Ok(json) = serde_json::to_string(&message) {
            let _ = heartbeat_socket.send_with_str(&json);
        }
    });

    Ok(RealtimeConnection {
        socket,
        _heartbeat: heartbeat,
        _open: open,
        _message: message,
        _error: error,
        _close: close,
    })
}

#[cfg(not(target_arch = "wasm32"))]
pub fn connect_realtime(
    _initial_message: ClientRealtimeMessage,
    _on_event: impl FnMut(RealtimeEvent) + 'static,
) -> Result<RealtimeConnection, BrowserPlatformError> {
    Err(BrowserPlatformError::UnsupportedTarget)
}

#[cfg(target_arch = "wasm32")]
pub fn new_client_id(prefix: &str) -> String {
    let timestamp = js_sys::Date::now() as u64;
    let random = (js_sys::Math::random() * u32::MAX as f64) as u32;
    format!("{prefix}_{timestamp:x}{random:08x}")
}

#[cfg(not(target_arch = "wasm32"))]
pub fn new_client_id(prefix: &str) -> String {
    format!("{prefix}_unsupported")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_realtime_messages_require_the_current_protocol() {
        let current = r#"{"type":"error","version":{"major":5,"minor":0},"code":"unavailable","message":"Try again","retryable":true}"#;
        assert!(decode_server_message(current).is_ok());

        let previous = current.replace(r#""major":5"#, r#""major":4"#);
        assert!(matches!(
            decode_server_message(&previous),
            Err(BrowserPlatformError::Decode(message))
                if message == "protocol version 4.0 is unsupported"
        ));
    }
}
