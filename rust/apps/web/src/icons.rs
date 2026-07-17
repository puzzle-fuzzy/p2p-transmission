//! The small, shared application icon set.
//!
//! The `LogOut` and `Share2` geometry is adapted from the Lucide icon library.
//! Source and license attribution are recorded in the repository's
//! `THIRD_PARTY_NOTICES.md`. Keeping only the icons used by the application
//! avoids enabling a third-party Dioxus crate's default runtime features in
//! the browser bundle.

use dioxus::prelude::*;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum UiIconKind {
    LogOut,
    Share2,
}

#[component]
pub(super) fn UiIcon(kind: UiIconKind) -> Element {
    rsx! {
        svg {
            class: "button-icon",
            "xmlns": "http://www.w3.org/2000/svg",
            width: "18",
            height: "18",
            view_box: "0 0 24 24",
            fill: "none",
            stroke: "currentColor",
            stroke_width: "2",
            stroke_linecap: "round",
            stroke_linejoin: "round",
            role: "presentation",
            "aria-hidden": "true",
            "focusable": "false",
            match kind {
                UiIconKind::LogOut => rsx! {
                    path { d: "m16 17 5-5-5-5" }
                    path { d: "M21 12H9" }
                    path { d: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" }
                },
                UiIconKind::Share2 => rsx! {
                    circle { cx: "18", cy: "5", r: "3" }
                    circle { cx: "6", cy: "12", r: "3" }
                    circle { cx: "18", cy: "19", r: "3" }
                    line { x1: "8.59", x2: "15.42", y1: "13.51", y2: "17.49" }
                    line { x1: "15.41", x2: "8.59", y1: "6.51", y2: "10.49" }
                },
            }
        }
    }
}
