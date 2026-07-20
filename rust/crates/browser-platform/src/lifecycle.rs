use crate::BrowserPlatformError;

pub const SLEEP_RESUME_GAP_MS: u64 = 15_000;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BrowserLifecycleEvent {
    Hidden,
    Visible { hidden_ms: u64 },
    Offline,
    Online,
    Resumed { gap_ms: u64 },
    AppUpdate,
}

#[cfg(target_arch = "wasm32")]
mod browser {
    use std::{
        cell::{Cell, RefCell},
        rc::Rc,
    };

    use gloo_timers::callback::Interval;
    use wasm_bindgen::{JsCast, closure::Closure};
    use web_sys::{Document, Event, VisibilityState, Window};

    use super::{BrowserLifecycleEvent, BrowserPlatformError, SLEEP_RESUME_GAP_MS};

    const WATCHDOG_INTERVAL_MS: u32 = 2_000;

    #[derive(Clone)]
    pub struct BrowserLifecycle {
        _inner: Rc<BrowserLifecycleInner>,
    }

    struct BrowserLifecycleInner {
        window: Window,
        document: Document,
        _watchdog: Interval,
        visibility: Closure<dyn FnMut(Event)>,
        network: Closure<dyn FnMut(Event)>,
        app_update: Closure<dyn FnMut(Event)>,
    }

    impl Drop for BrowserLifecycleInner {
        fn drop(&mut self) {
            let _ = self.document.remove_event_listener_with_callback(
                "visibilitychange",
                self.visibility.as_ref().unchecked_ref(),
            );
            let _ = self.window.remove_event_listener_with_callback(
                "online",
                self.network.as_ref().unchecked_ref(),
            );
            let _ = self.window.remove_event_listener_with_callback(
                "offline",
                self.network.as_ref().unchecked_ref(),
            );
            let _ = self.window.remove_event_listener_with_callback(
                "p2p-app-update",
                self.app_update.as_ref().unchecked_ref(),
            );
        }
    }

    pub fn connect_browser_lifecycle(
        on_event: impl FnMut(BrowserLifecycleEvent) + 'static,
    ) -> Result<BrowserLifecycle, BrowserPlatformError> {
        let window = web_sys::window().ok_or(BrowserPlatformError::MissingWindow)?;
        let document = window
            .document()
            .ok_or(BrowserPlatformError::MissingWindow)?;
        let callback = Rc::new(RefCell::new(on_event));
        let hidden_since = Rc::new(Cell::new(None::<f64>));
        let last_tick = Rc::new(Cell::new(js_sys::Date::now()));
        let last_online = Rc::new(Cell::new(window.navigator().on_line()));

        let visibility_document = document.clone();
        let visibility_callback = Rc::clone(&callback);
        let visibility_hidden_since = Rc::clone(&hidden_since);
        let visibility_last_tick = Rc::clone(&last_tick);
        let visibility = Closure::wrap(Box::new(move |_event: Event| {
            let now = js_sys::Date::now();
            visibility_last_tick.set(now);
            if visibility_document.visibility_state() == VisibilityState::Hidden {
                visibility_hidden_since.set(Some(now));
                visibility_callback.borrow_mut()(BrowserLifecycleEvent::Hidden);
                return;
            }
            let hidden_ms = visibility_hidden_since
                .take()
                .map_or(0, |started| elapsed_ms(started, now));
            visibility_callback.borrow_mut()(BrowserLifecycleEvent::Visible { hidden_ms });
        }) as Box<dyn FnMut(_)>);
        document
            .add_event_listener_with_callback(
                "visibilitychange",
                visibility.as_ref().unchecked_ref(),
            )
            .map_err(browser_error)?;

        let network_callback = Rc::clone(&callback);
        let network_last_online = Rc::clone(&last_online);
        let network = Closure::wrap(Box::new(move |event: Event| {
            let event = match event.type_().as_str() {
                "online" => BrowserLifecycleEvent::Online,
                _ => BrowserLifecycleEvent::Offline,
            };
            network_last_online.set(event == BrowserLifecycleEvent::Online);
            network_callback.borrow_mut()(event);
        }) as Box<dyn FnMut(_)>);
        window
            .add_event_listener_with_callback("online", network.as_ref().unchecked_ref())
            .map_err(browser_error)?;
        window
            .add_event_listener_with_callback("offline", network.as_ref().unchecked_ref())
            .map_err(browser_error)?;

        let update_callback = Rc::clone(&callback);
        let app_update = Closure::wrap(Box::new(move |_event: Event| {
            update_callback.borrow_mut()(BrowserLifecycleEvent::AppUpdate);
        }) as Box<dyn FnMut(_)>);
        window
            .add_event_listener_with_callback("p2p-app-update", app_update.as_ref().unchecked_ref())
            .map_err(browser_error)?;

        let update_already_pending = js_sys::Reflect::get(
            window.as_ref(),
            &wasm_bindgen::JsValue::from_str("__P2P_UPDATE_REQUIRED__"),
        )
        .ok()
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
        if update_already_pending {
            callback.borrow_mut()(BrowserLifecycleEvent::AppUpdate);
        }

        let watchdog_document = document.clone();
        let watchdog_window = window.clone();
        let watchdog_callback = callback;
        let watchdog_last_tick = last_tick;
        let watchdog_last_online = last_online;
        let watchdog = Interval::new(WATCHDOG_INTERVAL_MS, move || {
            let now = js_sys::Date::now();
            let gap_ms = elapsed_ms(watchdog_last_tick.replace(now), now);
            let online = watchdog_window.navigator().on_line();
            let was_online = watchdog_last_online.replace(online);
            if online != was_online {
                watchdog_callback.borrow_mut()(if online {
                    BrowserLifecycleEvent::Online
                } else {
                    BrowserLifecycleEvent::Offline
                });
            }
            if gap_ms >= SLEEP_RESUME_GAP_MS
                && watchdog_document.visibility_state() == VisibilityState::Visible
            {
                watchdog_callback.borrow_mut()(BrowserLifecycleEvent::Resumed { gap_ms });
            }
        });

        Ok(BrowserLifecycle {
            _inner: Rc::new(BrowserLifecycleInner {
                window,
                document,
                _watchdog: watchdog,
                visibility,
                network,
                app_update,
            }),
        })
    }

    fn elapsed_ms(started: f64, now: f64) -> u64 {
        (now - started).max(0.0).min(u64::MAX as f64) as u64
    }

    fn browser_error(value: wasm_bindgen::JsValue) -> BrowserPlatformError {
        BrowserPlatformError::Browser(value.as_string().unwrap_or_else(|| format!("{value:?}")))
    }
}

#[cfg(target_arch = "wasm32")]
pub use browser::{BrowserLifecycle, connect_browser_lifecycle};

#[cfg(not(target_arch = "wasm32"))]
#[derive(Clone)]
pub struct BrowserLifecycle;

#[cfg(not(target_arch = "wasm32"))]
pub fn connect_browser_lifecycle(
    _on_event: impl FnMut(BrowserLifecycleEvent) + 'static,
) -> Result<BrowserLifecycle, BrowserPlatformError> {
    Err(BrowserPlatformError::UnsupportedTarget)
}
