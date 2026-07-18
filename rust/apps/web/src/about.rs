use dioxus::prelude::*;
use p2p_browser_platform::{close_modal_dialog, show_modal_dialog};
use p2p_ui_shell::{ABOUT_LABEL, GITHUB_LABEL, PRIVACY_COPY};

use crate::app_state::AppModel;

#[component]
pub(super) fn AboutDialog(mut model: Signal<AppModel>) -> Element {
    use_effect(|| {
        let _ = show_modal_dialog("about-dialog");
    });
    rsx! {
        dialog {
            id: "about-dialog",
            class: "about-dialog",
            aria_labelledby: "about-title",
            oncancel: move |event| {
                event.prevent_default();
                let _ = close_modal_dialog("about-dialog");
                model.write().about_open = false;
            },
            h2 { id: "about-title", {ABOUT_LABEL} }
            p { "当前版本使用 Axum SSR、Dioxus Web 交互岛与共享 Rust crates 构建。页面样式和用户功能保持产品体验基线。" }
            p { class: "about-privacy-copy", {PRIVACY_COPY} }
            dl {
                div { dt { "当前阶段" } dd { "正式版" } }
                div { dt { "前端" } dd { "Dioxus / WebAssembly" } }
                div { dt { "服务端" } dd { "Axum" } }
                div { dt { "数据通道" } dd { "WebRTC / BLAKE3" } }
            }
            button {
                class: "close-button",
                r#type: "button",
                onclick: move |_| {
                    let _ = close_modal_dialog("about-dialog");
                    model.write().about_open = false;
                },
                "关闭"
            }
        }
    }
}

#[component]
pub(super) fn FooterLinks(mut model: Signal<AppModel>) -> Element {
    rsx! {
        button {
            class: "text-link",
            r#type: "button",
            onclick: move |_| model.write().about_open = true,
            {ABOUT_LABEL}
        }
        a {
            class: "text-link",
            href: "https://github.com/puzzle-fuzzy/p2p-transmission",
            target: "_blank",
            rel: "noreferrer",
            {GITHUB_LABEL}
        }
    }
}
