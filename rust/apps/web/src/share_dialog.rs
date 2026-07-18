use std::fmt::Write as _;

use dioxus::prelude::*;
use p2p_browser_platform::{
    BrowserPlatformError, NativeShareOutcome, build_invite_url, close_modal_dialog, copy_text,
    native_share_supported, share_url, show_modal_dialog,
};

use crate::app_state::AppModel;

const QR_QUIET_ZONE_MODULES: usize = 4;

#[derive(Clone, Debug, Eq, PartialEq)]
struct InviteQrCode {
    view_box: String,
    path: String,
}

fn invite_qr_code(url: &str) -> Option<InviteQrCode> {
    let code = qrcode::QrCode::new(url.as_bytes()).ok()?;
    let width = code.width();
    let mut path = String::new();

    for (index, color) in code.into_colors().into_iter().enumerate() {
        if color == qrcode::Color::Dark {
            let x = index % width + QR_QUIET_ZONE_MODULES;
            let y = index / width + QR_QUIET_ZONE_MODULES;
            write!(&mut path, "M{x} {y}h1v1h-1z").ok()?;
        }
    }

    let size = width + QR_QUIET_ZONE_MODULES * 2;
    Some(InviteQrCode {
        view_box: format!("0 0 {size} {size}"),
        path,
    })
}

#[component]
pub(super) fn ShareDialog(
    mut model: Signal<AppModel>,
    mut share_open: Signal<bool>,
    room_code: String,
    capability: String,
) -> Element {
    let mut share_error = use_signal(|| None::<String>);
    let invite_url = build_invite_url(&room_code, &capability).ok();
    let qr_code = invite_url.as_deref().and_then(invite_qr_code);
    let has_native_share = native_share_supported();
    use_effect(|| {
        let _ = show_modal_dialog("share-dialog");
    });
    rsx! {
        dialog {
            id: "share-dialog",
            class: "share-dialog",
            aria_labelledby: "share-title",
            oncancel: move |event| {
                event.prevent_default();
                let _ = close_modal_dialog("share-dialog");
                share_open.set(false);
            },
                h2 { id: "share-title", "分享房间" }
                p { "使用手机扫描二维码，或复制邀请链接加入；房间码可用于核对。" }
                if let Some(qr_code) = qr_code {
                    div {
                        class: "share-qr",
                        role: "img",
                        aria_label: "房间 {room_code} 的二维码",
                        svg {
                            class: "share-qr-code",
                            view_box: "{qr_code.view_box}",
                            role: "presentation",
                            path { d: "{qr_code.path}", fill: "currentColor" }
                        }
                    }
                } else {
                    p { class: "share-qr-error", role: "status", "暂时无法生成二维码，请复制邀请链接。" }
                }
                div { class: "share-code",
                    span { "房间码" }
                    strong { "{room_code}" }
                }
                button {
                    class: "primary-button",
                    r#type: "button",
                    onclick: move |_| {
                        share_error.set(None);
                        let room_code = room_code.clone();
                        let capability = capability.clone();
                        spawn(async move {
                            let result = async {
                                let url = build_invite_url(&room_code, &capability)?;
                                match share_url(
                                    "P2P Transmission 房间邀请",
                                    "打开邀请链接加入临时点对点传输房间",
                                    &url,
                                ).await {
                                    Ok(NativeShareOutcome::Shared) => {
                                        Ok::<_, BrowserPlatformError>(Some("邀请链接已分享"))
                                    }
                                    Ok(NativeShareOutcome::Cancelled) => {
                                        Ok::<_, BrowserPlatformError>(None)
                                    }
                                    Ok(NativeShareOutcome::Unsupported) | Err(_) => {
                                        copy_text(&url).await?;
                                        Ok(Some("邀请链接已复制"))
                                    }
                                }
                            }.await;
                            match result {
                                Ok(Some(notice)) => {
                                    model.write().notice = Some(notice.to_owned());
                                    let _ = close_modal_dialog("share-dialog");
                                    share_open.set(false);
                                }
                                Ok(None) => {}
                                Err(_) => {
                                    if let Ok(mut error) = share_error.try_write() {
                                        *error = Some("无法自动分享，请改用房间码加入".to_owned());
                                    }
                                }
                            }
                        });
                    },
                    if has_native_share { "分享邀请链接" } else { "复制邀请链接" }
                }
                if let Some(error) = share_error() {
                    p { class: "dialog-error", role: "alert", "{error}" }
                }
                button {
                    class: "dialog-close",
                    r#type: "button",
                    onclick: move |_| {
                        let _ = close_modal_dialog("share-dialog");
                        share_open.set(false);
                    },
                    "关闭"
                }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invite_qr_code_is_deterministic_and_keeps_a_quiet_zone() {
        let url = "https://p2p.yxswy.com/#room=ABC234&capability=test-capability";
        let first = invite_qr_code(url).expect("invite URL should fit in a QR code");
        let second = invite_qr_code(url).expect("same invite URL should remain encodable");

        assert_eq!(first, second);
        assert!(first.view_box.starts_with("0 0 "));
        assert!(first.path.starts_with("M4 4"));
        assert!(!first.path.contains('<'));
    }
}
