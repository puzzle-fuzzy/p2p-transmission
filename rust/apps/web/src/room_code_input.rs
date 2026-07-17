use dioxus::prelude::*;
use p2p_browser_platform::focus_text_input;

#[cfg(target_arch = "wasm32")]
use dioxus::web::WebEventExt;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen::JsCast;

const ROOM_CODE_LENGTH: usize = 6;
type RoomCodeCells = [Option<char>; ROOM_CODE_LENGTH];

#[component]
pub fn RoomCodeInput(
    value: String,
    disabled: bool,
    invalid: bool,
    on_change: EventHandler<String>,
) -> Element {
    let mut cells = use_signal(|| room_code_cells(&value));
    let snapshot = *cells.read();

    rsx! {
        fieldset {
            class: "room-code",
            onpaste: move |event| {
                let Some(code) = pasted_room_code(&event) else {
                    return;
                };
                event.prevent_default();
                let next = room_code_cells(&code);
                cells.set(next);
                on_change.call(room_code_from_cells(&next));
                focus_cell(code.len().min(ROOM_CODE_LENGTH - 1));
            },
            legend { class: "sr-only", "输入 6 位房间码" }
            for index in 0..ROOM_CODE_LENGTH {
                input {
                    id: "room-code-{index}",
                    class: if snapshot[index].is_some() { "room-code-input filled" } else { "room-code-input" },
                    r#type: "text",
                    name: "room_code_{index}",
                    value: snapshot[index].map(|character| character.to_string()).unwrap_or_default(),
                    maxlength: 1,
                    inputmode: "text",
                    autocomplete: if index == 0 { "one-time-code" } else { "off" },
                    autocapitalize: "characters",
                    spellcheck: "false",
                    disabled,
                    aria_label: if index == 0 {
                        "输入 6 位房间码，房间码第 1 位".to_owned()
                    } else {
                        format!("房间码第 {} 位", index + 1)
                    },
                    aria_invalid: invalid,
                    aria_describedby: invalid.then_some("room-code-error"),
                    oninput: move |event| {
                        let (next, focus_index) = apply_input(*cells.read(), index, &event.value());
                        cells.set(next);
                        on_change.call(room_code_from_cells(&next));
                        if let Some(focus_index) = focus_index {
                            focus_cell(focus_index);
                        }
                    },
                    onkeydown: move |event| match event.key() {
                        Key::Character(value)
                            if cells.read()[index].is_some()
                                && !event.modifiers().intersects(
                                    Modifiers::CONTROL | Modifiers::META | Modifiers::ALT,
                                ) =>
                        {
                            event.prevent_default();
                            let replacement = normalize_room_code(&value);
                            if !replacement.is_empty() {
                                let (next, focus_index) =
                                    apply_input(*cells.read(), index, &replacement);
                                cells.set(next);
                                on_change.call(room_code_from_cells(&next));
                                if let Some(focus_index) = focus_index {
                                    focus_cell(focus_index);
                                }
                            }
                        }
                        Key::Backspace if cells.read()[index].is_none() && index > 0 => {
                            event.prevent_default();
                            focus_cell(index - 1);
                        }
                        Key::ArrowLeft if index > 0 => {
                            event.prevent_default();
                            focus_cell(index - 1);
                        }
                        Key::ArrowRight if index + 1 < ROOM_CODE_LENGTH => {
                            event.prevent_default();
                            focus_cell(index + 1);
                        }
                        Key::Home => {
                            event.prevent_default();
                            focus_cell(0);
                        }
                        Key::End => {
                            event.prevent_default();
                            focus_cell(ROOM_CODE_LENGTH - 1);
                        }
                        _ => {}
                    },
                }
            }
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

fn room_code_cells(value: &str) -> RoomCodeCells {
    let mut cells = [None; ROOM_CODE_LENGTH];
    for (index, character) in normalize_room_code(value).chars().enumerate() {
        cells[index] = Some(character);
    }
    cells
}

fn room_code_from_cells(cells: &RoomCodeCells) -> String {
    cells.iter().flatten().collect()
}

fn apply_input(
    mut cells: RoomCodeCells,
    index: usize,
    value: &str,
) -> (RoomCodeCells, Option<usize>) {
    let characters = normalize_room_code(value).chars().collect::<Vec<_>>();
    if characters.is_empty() {
        cells[index] = None;
        return (cells, None);
    }

    for (offset, character) in characters.iter().copied().enumerate() {
        let Some(cell) = cells.get_mut(index + offset) else {
            break;
        };
        *cell = Some(character);
    }
    let next_index = index + characters.len();
    let focus_index = (next_index < ROOM_CODE_LENGTH).then_some(next_index);
    (cells, focus_index)
}

fn focus_cell(index: usize) {
    let _ = focus_text_input(&format!("room-code-{index}"));
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
    fn complete_input_is_distributed_across_six_cells() {
        let (cells, focus_index) = apply_input([None; ROOM_CODE_LENGTH], 0, "ab23cd");

        assert_eq!(room_code_from_cells(&cells), "AB23CD");
        assert_eq!(focus_index, None);
    }

    #[test]
    fn clearing_a_cell_does_not_shift_later_cells() {
        let cells = room_code_cells("AB23CD");
        let (cells, focus_index) = apply_input(cells, 2, "-");

        assert_eq!(cells[2], None);
        assert_eq!(cells[3], Some('3'));
        assert_eq!(room_code_from_cells(&cells), "AB3CD");
        assert_eq!(focus_index, None);
    }
}
