use dioxus::prelude::*;
use p2p_ui_shell::ROOM_CODE_LENGTH;

#[cfg(target_arch = "wasm32")]
use dioxus::web::WebEventExt;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen::JsCast;

#[component]
pub fn RoomCodeInput(
    value: String,
    disabled: bool,
    invalid: bool,
    on_change: EventHandler<String>,
) -> Element {
    rsx! {
        input {
            id: "room-code-input",
            class: "join-field mono",
            r#type: "text",
            name: "room_code",
            value,
            maxlength: ROOM_CODE_LENGTH,
            inputmode: "text",
            autocomplete: "one-time-code",
            autocapitalize: "characters",
            spellcheck: "false",
            disabled,
            aria_label: "输入 6 位房间码",
            aria_invalid: invalid,
            aria_describedby: invalid.then_some("room-code-error"),
            placeholder: "000000",
            oninput: move |event| {
                on_change.call(normalize_room_code(&event.value()));
            },
            onpaste: move |event| {
                let Some(code) = pasted_room_code(&event) else {
                    return;
                };
                event.prevent_default();
                on_change.call(code);
            },
        }
    }
}

fn normalize_room_code(value: &str) -> String {
    value
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .take(ROOM_CODE_LENGTH)
        .collect::<String>()
        .to_ascii_uppercase()
}

#[cfg(target_arch = "wasm32")]
fn pasted_room_code(event: &ClipboardEvent) -> Option<String> {
    let raw_event = event
        .data()
        .as_web_event()
        .unchecked_into::<web_sys::ClipboardEvent>();
    let value = raw_event.clipboard_data()?.get_data("text").ok()?;
    let code = normalize_room_code(&value);
    (!code.is_empty()).then_some(code)
}

#[cfg(not(target_arch = "wasm32"))]
fn pasted_room_code(_event: &ClipboardEvent) -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn room_code_normalization_keeps_supported_characters() {
        assert_eq!(normalize_room_code("a-b 23cd7"), "AB23CD");
    }

    #[test]
    fn room_code_normalization_caps_single_input_at_six_characters() {
        assert_eq!(normalize_room_code("ab23cd7"), "AB23CD");
    }

    #[test]
    fn room_code_normalization_is_empty_for_punctuation_only_input() {
        assert_eq!(normalize_room_code("- _"), "");
    }
}
