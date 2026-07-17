use crate::BrowserPlatformError;

#[cfg(target_arch = "wasm32")]
thread_local! {
    static APP_INTERACTIVE_SCHEDULED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

#[cfg(target_arch = "wasm32")]
fn modal_dialog(id: &str) -> Result<web_sys::HtmlDialogElement, BrowserPlatformError> {
    use wasm_bindgen::JsCast;

    web_sys::window()
        .ok_or(BrowserPlatformError::MissingWindow)?
        .document()
        .ok_or_else(|| BrowserPlatformError::Browser("browser document is unavailable".to_owned()))?
        .get_element_by_id(id)
        .ok_or_else(|| BrowserPlatformError::Browser(format!("dialog #{id} is unavailable")))?
        .dyn_into::<web_sys::HtmlDialogElement>()
        .map_err(|_| BrowserPlatformError::Browser(format!("element #{id} is not a dialog")))
}

#[cfg(target_arch = "wasm32")]
pub fn focus_text_input(id: &str) -> Result<(), BrowserPlatformError> {
    use wasm_bindgen::JsCast;

    let input = web_sys::window()
        .ok_or(BrowserPlatformError::MissingWindow)?
        .document()
        .ok_or_else(|| BrowserPlatformError::Browser("browser document is unavailable".to_owned()))?
        .get_element_by_id(id)
        .ok_or_else(|| BrowserPlatformError::Browser(format!("input #{id} is unavailable")))?
        .dyn_into::<web_sys::HtmlInputElement>()
        .map_err(|_| BrowserPlatformError::Browser(format!("element #{id} is not an input")))?;
    input
        .focus()
        .map_err(|error| BrowserPlatformError::Browser(format!("{error:?}")))?;
    Ok(())
}

#[cfg(not(target_arch = "wasm32"))]
pub fn focus_text_input(_id: &str) -> Result<(), BrowserPlatformError> {
    Err(BrowserPlatformError::UnsupportedTarget)
}

#[cfg(target_arch = "wasm32")]
pub fn show_modal_dialog(id: &str) -> Result<(), BrowserPlatformError> {
    let dialog = modal_dialog(id)?;
    if !dialog.open() {
        dialog
            .show_modal()
            .map_err(|error| BrowserPlatformError::Browser(format!("{error:?}")))?;
    }
    Ok(())
}

#[cfg(not(target_arch = "wasm32"))]
pub fn show_modal_dialog(_id: &str) -> Result<(), BrowserPlatformError> {
    Err(BrowserPlatformError::UnsupportedTarget)
}

#[cfg(target_arch = "wasm32")]
pub fn close_modal_dialog(id: &str) -> Result<(), BrowserPlatformError> {
    let dialog = modal_dialog(id)?;
    if dialog.open() {
        dialog.close();
    }
    Ok(())
}

#[cfg(not(target_arch = "wasm32"))]
pub fn close_modal_dialog(_id: &str) -> Result<(), BrowserPlatformError> {
    Err(BrowserPlatformError::UnsupportedTarget)
}

#[cfg(target_arch = "wasm32")]
pub fn activate_app_mount() {
    let Some(document) = web_sys::window().and_then(|window| window.document()) else {
        return;
    };
    if let Some(mount) = document.get_element_by_id("main") {
        let _ = mount.remove_attribute("hidden");
        let _ = mount.remove_attribute("inert");
        let _ = mount.remove_attribute("aria-hidden");
    }
    if let Some(fallback) = document.get_element_by_id("boot-fallback") {
        fallback.remove();
    }
    if let Some(root) = document.document_element() {
        let _ = root.remove_attribute("data-p2p-room-restore");
    }
}

#[cfg(not(target_arch = "wasm32"))]
pub fn activate_app_mount() {}

#[cfg(target_arch = "wasm32")]
pub fn mark_app_interactive() {
    use wasm_bindgen::{JsCast, closure::Closure};

    let Some(window) = web_sys::window() else {
        return;
    };
    APP_INTERACTIVE_SCHEDULED.with(|scheduled| {
        if scheduled.get() {
            return;
        }

        // The first callback runs before paint. The second records that the live
        // Dioxus root has survived a complete browser frame after the shell swap.
        let second_frame: js_sys::Function = Closure::once_into_js(move || {
            let marked = web_sys::window()
                .and_then(|window| window.performance())
                .is_some_and(|performance| performance.mark("p2p-app-interactive").is_ok());
            if !marked {
                APP_INTERACTIVE_SCHEDULED.with(|scheduled| scheduled.set(false));
            }
        })
        .unchecked_into();
        let first_frame: js_sys::Function = Closure::once_into_js(move || {
            let scheduled_second_frame = web_sys::window()
                .is_some_and(|window| window.request_animation_frame(&second_frame).is_ok());
            if !scheduled_second_frame {
                APP_INTERACTIVE_SCHEDULED.with(|scheduled| scheduled.set(false));
            }
        })
        .unchecked_into();

        if window.request_animation_frame(&first_frame).is_ok() {
            scheduled.set(true);
        }
    });
}

#[cfg(not(target_arch = "wasm32"))]
pub fn mark_app_interactive() {}
