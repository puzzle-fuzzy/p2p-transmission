//! Shared, platform-neutral presentation for the anonymous lobby.
//!
//! This crate deliberately owns no browser APIs, transport state, or server
//! routing. The same component tree can therefore be rendered by Dioxus Web or
//! by the server-side renderer.

use dioxus::prelude::*;

pub const ROOM_CODE_LENGTH: usize = 6;
pub const APP_TITLE: &str = "点对点传输";
pub const LOBBY_TITLE: &str = "加入房间";
pub const LOBBY_JOIN_COPY: &str = "输入对方提供的 6 位房间码。";
pub const INVITE_READY_COPY: &str = "已读取邀请链接，确认后加入房间";
pub const INITIALIZING_COPY: &str = "正在初始化安全会话，稍候即可使用";
pub const RESTORING_ROOM_COPY: &str = "正在恢复上次房间，请稍候";
pub const JOIN_REQUEST_LABEL: &str = "请求加入";
pub const CREATE_ROOM_LABEL: &str = "创建房间";
pub const ABOUT_LABEL: &str = "关于";
pub const GITHUB_LABEL: &str = "GitHub";
pub const PRIVACY_COPY: &str = "文件和文本正文通过加密的 WebRTC 通道传输，优先尝试设备直连，必要时经加密中继转发；应用服务器只协调连接，不保存传输内容。接收完成的文件会暂存在当前页面中，关闭结果或退出房间后释放。";
pub const NOSCRIPT_COPY: &str = "传输工作区需要浏览器启用 JavaScript 和 WebAssembly。";

#[component]
pub fn AppShell(
    content: Element,
    footer: Element,
    #[props(default = "workspace-card".to_owned())] card_class: String,
    #[props(default = true)] interactive: bool,
) -> Element {
    let is_room = card_class.contains("workspace-card-room");
    rsx! {
        div { class: "app-shell",
            div { class: "transfer-layout",
                div { class: "transfer-identity", aria_hidden: "true" }
                div { class: "transfer-console",
                    main { class: "page",
                        div { class: "shell",
                            header { class: "topbar mono", aria_label: "页面信息",
                                span { if is_room { "ACTIVE SESSION" } else { "P2P DELIVERY" } }
                                span { if is_room { "TRANSFER BOARD · 02 / 04" } else { "SECURE SESSION · 01 / 04" } }
                            }
                            div { class: "divider", aria_hidden: "true" }
                            div { class: "{card_class}", {content} }
                            if !is_room {
                                footer { class: "footerline mono",
                                    span { "P2P FILE TRANSFER / CREATE + JOIN / WEBRTC SESSION" }
                                    span { class: "footer-meta",
                                        span { class: "footer-inline-actions",
                                            if interactive {
                                                a {
                                                    class: "github-link",
                                                    href: "https://github.com/puzzle-fuzzy/p2p-transmission",
                                                    target: "_blank",
                                                    rel: "noreferrer",
                                                    "{GITHUB_LABEL} ↗"
                                                }
                                            } else {
                                                span { class: "github-link", aria_hidden: "true", "{GITHUB_LABEL} ↗" }
                                            }
                                            span { class: "footer-divider", aria_hidden: "true", "/" }
                                            {footer}
                                        }
                                        span { class: "footer-page-index", aria_label: "页面索引 02 × 01", "02 × 01" }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

/// Stable feedback content rendered in the lobby's reserved message row.
///
/// Keeping the row present even when it is empty prevents the controls below
/// it from moving when a status or validation error appears.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum LobbyFeedback {
    #[default]
    Empty,
    Status(String),
    JoinError(String),
    CreateError(String),
    Error(String),
}

impl LobbyFeedback {
    #[must_use]
    pub fn status(message: impl Into<String>) -> Self {
        Self::Status(message.into())
    }

    #[must_use]
    pub fn error(message: impl Into<String>) -> Self {
        Self::Error(message.into())
    }

    #[must_use]
    pub fn join_error(message: impl Into<String>) -> Self {
        Self::JoinError(message.into())
    }

    #[must_use]
    pub fn create_error(message: impl Into<String>) -> Self {
        Self::CreateError(message.into())
    }
}

/// The shared anonymous-lobby DOM used by both SSR and the interactive client.
///
/// `room_code` supplies either the interactive single input or the inert SSR
/// placeholder. `footer` supplies links/buttons while the shell retains the
/// stable footer layout. Event handlers use Dioxus' renderer-neutral event
/// types, so this crate does not depend on `web-sys`.
#[component]
pub fn LobbyShell(
    room_code: Element,
    footer: Element,
    #[props(default)] interactive: bool,
    #[props(default)] feedback: LobbyFeedback,
    #[props(default)] invite_ready: bool,
    #[props(default = JOIN_REQUEST_LABEL.to_owned())] primary_label: String,
    #[props(default)] primary_disabled: bool,
    #[props(default = CREATE_ROOM_LABEL.to_owned())] secondary_label: String,
    #[props(default)] secondary_disabled: bool,
    #[props(default)] on_submit: EventHandler<FormEvent>,
    #[props(default)] on_create: EventHandler<MouseEvent>,
) -> Element {
    rsx! {
        AppShell {
            footer,
            interactive,
            card_class: "workspace-card workspace-card-lobby".to_owned(),
            content: rsx! {
                LobbyPanel {
                    room_code,
                    feedback,
                    invite_ready,
                    primary_label,
                    primary_disabled,
                    secondary_label,
                    secondary_disabled,
                    on_submit,
                    on_create,
                }
            }
        }
    }
}

#[component]
pub fn LobbyPanel(
    room_code: Element,
    #[props(default)] feedback: LobbyFeedback,
    #[props(default)] invite_ready: bool,
    #[props(default = JOIN_REQUEST_LABEL.to_owned())] primary_label: String,
    #[props(default)] primary_disabled: bool,
    #[props(default = CREATE_ROOM_LABEL.to_owned())] secondary_label: String,
    #[props(default)] secondary_disabled: bool,
    #[props(default)] on_submit: EventHandler<FormEvent>,
    #[props(default)] on_create: EventHandler<MouseEvent>,
) -> Element {
    let (primary_description, secondary_description) = match &feedback {
        LobbyFeedback::JoinError(_) => (Some("room-code-error"), None),
        LobbyFeedback::CreateError(_) => (None, Some("create-room-error")),
        LobbyFeedback::Empty | LobbyFeedback::Status(_) | LobbyFeedback::Error(_) => (None, None),
    };

    rsx! {
        section { class: "lobby-panel", aria_labelledby: "landing-title",
            p { class: "eyebrow mono", "CREATE / JOIN TEMPORARY ROOM" }
            section { class: "hero", aria_labelledby: "landing-title",
                div {
                    h1 { id: "landing-title", class: "hero-title", "点对点", br {}, "文件传输" }
                    p { class: "hero-copy",
                        "无需注册，不经过长期云端存储。创建一个临时房间，或输入六位房间号加入另一台设备，适合电脑、手机与桌面端之间快速互传文件。"
                    }
                }
                aside { class: "hero-note",
                    p { class: "mini mono", "P2P / WEBRTC / ONE-TIME SESSION" }
                    p { class: "mini", "房间用于协调连接，文件和文本通过加密 WebRTC 通道在设备之间传输。" }
                }
            }
            section { class: "board", aria_label: "房间操作",
                article { class: "panel panel--blue create-panel", aria_labelledby: "create-title",
                    p { class: "panel-number", aria_hidden: "true", "01" }
                    p { class: "panel-label mono", "HOST SESSION" }
                    h2 { id: "create-title", class: "panel-title", "创建房间" }
                    p { class: "panel-desc", "点击创建后生成一次性六位房间号，再将它发送给另一台设备即可加入。" }
                    div { class: "actions",
                        button {
                            class: "btn btn--solid mono",
                            r#type: "button",
                            disabled: secondary_disabled,
                            onclick: move |event| {
                                if !secondary_disabled {
                                    on_create.call(event);
                                }
                            },
                            aria_describedby: secondary_description,
                            {secondary_label}
                        }
                    }
                    LobbyCreateFeedbackRow { feedback: feedback.clone() }
                }
                div { class: "board-right",
                    form {
                        class: "panel join-panel",
                        aria_labelledby: "join-title",
                        onsubmit: move |event| {
                            event.prevent_default();
                            if !primary_disabled {
                                on_submit.call(event);
                            }
                        },
                        p { class: "panel-number", aria_hidden: "true", "02" }
                        p { class: "panel-label mono", "JOIN SESSION" }
                        h2 { id: "join-title", class: "panel-title", {LOBBY_TITLE} }
                        p { class: "panel-desc", "输入另一台设备提供的六位房间号，建立临时连接后即可开始传输。" }
                        div { class: "lobby-guidance",
                            p {
                                class: if invite_ready {
                                    "join-copy invite-copy-spacer sr-only"
                                } else {
                                    "join-copy sr-only"
                                },
                                {LOBBY_JOIN_COPY}
                            }
                            if invite_ready {
                                div { class: "invite-notice", role: "status",
                                    span { class: "invite-mark", aria_hidden: "true", "✓" }
                                    span { {INVITE_READY_COPY} }
                                }
                            }
                        }
                        div { class: "stack",
                            label { class: "sr-only", for: "room-code-input", "输入 6 位房间码" }
                            div { class: "room-code-control", {room_code} }
                            LobbyJoinFeedbackRow { feedback: feedback.clone() }
                            div { class: "actions",
                                button {
                                    class: "btn btn--dark mono",
                                    r#type: "submit",
                                    disabled: primary_disabled,
                                    aria_describedby: primary_description,
                                    {primary_label}
                                }
                            }
                        }
                        p { class: "hint mono", "INPUT MUST BE 6 CHARACTERS" }
                    }
                    div { class: "grid-2", aria_label: "产品特点",
                        article { class: "panel info-card",
                            span { class: "info-big", aria_hidden: "true", "A" }
                            div {
                                p { class: "info-text", "直接连接" }
                                p { class: "hint mono", "PEER TO PEER / DIRECT" }
                            }
                        }
                        article { class: "panel info-card",
                            span { class: "info-big", aria_hidden: "true", "B" }
                            div {
                                p { class: "info-text", "临时会话" }
                                p { class: "hint mono", "ROOM CODE / ONE-TIME" }
                            }
                        }
                    }
                }
            }
            noscript { p { class: "boot-noscript", role: "alert", {NOSCRIPT_COPY} } }
        }
    }
}

/// A useful, non-interactive lobby for the first server response.
///
/// It has no input or link and both actions are disabled, so keyboard focus
/// cannot enter controls that are not ready yet.
#[component]
pub fn InitializingLobby() -> Element {
    rsx! {
        div { id: "boot-fallback",
            div { class: "boot-lobby-shell",
                LobbyShell {
                    room_code: rsx! { InitializingRoomCode {} },
                    footer: rsx! { InitializingFooter {} },
                    feedback: LobbyFeedback::status(INITIALIZING_COPY),
                    primary_disabled: true,
                    secondary_disabled: true,
                }
            }
            RoomRestoreFallback {}
        }
    }
}

/// Build the complete inert lobby root for a server renderer.
///
/// The returned element already contains the unique `#boot-fallback` root, so
/// callers must render it directly rather than wrapping it in another mount
/// element. Keeping the renderer outside this crate preserves the
/// platform-neutral dependency boundary.
pub fn initializing_lobby_element() -> Element {
    rsx! { InitializingLobby {} }
}

#[component]
fn LobbyJoinFeedbackRow(feedback: LobbyFeedback) -> Element {
    match feedback {
        LobbyFeedback::Empty => rsx! {
            div { id: "lobby-feedback", class: "form-message", aria_live: "polite" }
        },
        LobbyFeedback::Status(message) => rsx! {
            div {
                id: "lobby-feedback",
                class: "form-message boot-status",
                role: "status",
                aria_live: "polite",
                span { class: "service-dot", aria_hidden: "true" }
                p { {message} }
            }
        },
        LobbyFeedback::JoinError(message) => rsx! {
            div { id: "lobby-feedback", class: "form-message",
                p { id: "room-code-error", role: "alert", {message} }
            }
        },
        LobbyFeedback::CreateError(_) => rsx! {
            div { id: "lobby-feedback", class: "form-message", aria_live: "polite" }
        },
        LobbyFeedback::Error(message) => rsx! {
            div { id: "lobby-feedback", class: "form-message",
                p { id: "lobby-error", role: "alert", {message} }
            }
        },
    }
}

#[component]
fn LobbyCreateFeedbackRow(feedback: LobbyFeedback) -> Element {
    match feedback {
        LobbyFeedback::CreateError(message) => rsx! {
            div { id: "create-feedback", class: "form-message",
                p { id: "create-room-error", role: "alert", {message} }
            }
        },
        LobbyFeedback::Empty
        | LobbyFeedback::Status(_)
        | LobbyFeedback::JoinError(_)
        | LobbyFeedback::Error(_) => rsx! {
            div { id: "create-feedback", class: "form-message", aria_live: "polite" }
        },
    }
}

#[component]
fn InitializingRoomCode() -> Element {
    rsx! {
        div { class: "join-field mono boot-room-code", aria_hidden: "true", "000000" }
    }
}

#[component]
fn InitializingFooter() -> Element {
    rsx! {
        span { class: "footer-about-link", aria_hidden: "true", {ABOUT_LABEL} }
    }
}

#[component]
fn RoomRestoreFallback() -> Element {
    rsx! {
        div { class: "app-shell boot-room-restore",
            hidden: true,
            main { class: "lobby",
                div {
                    class: "boot-room-restore-status",
                    role: "status",
                    aria_live: "polite",
                    aria_atomic: "true",
                    span { class: "service-dot", aria_hidden: "true" }
                    p { {RESTORING_ROOM_COPY} }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initializing_lobby_is_useful_but_inert() {
        let html = render_initializing_lobby_for_test();

        assert!(html.contains(LOBBY_TITLE));
        assert!(html.contains("id=\"boot-fallback\""));
        assert!(!html.contains("aria-busy"));
        assert!(html.contains(LOBBY_JOIN_COPY));
        assert!(html.contains(INITIALIZING_COPY));
        assert!(html.contains(RESTORING_ROOM_COPY));
        assert!(html.contains(NOSCRIPT_COPY));
        assert_eq!(html.matches("boot-room-code").count(), 1);
        assert_eq!(html.matches(" disabled").count(), 2);
        assert!(!html.contains("<input"));
        assert!(!html.contains("<a "));
        assert!(!html.contains("tabindex"));
        assert!(!html.contains("Vault"));
        assert!(!html.contains("E2E Encrypted"));
        assert!(!html.contains("Privacy by design"));
        let restore_shell = html
            .split_once("boot-room-restore")
            .map(|(_, shell)| shell)
            .expect("room restore fallback should be rendered after the lobby");
        assert!(!restore_shell.contains("<button"));
        assert!(!restore_shell.contains("<input"));
    }

    #[test]
    fn feedback_constructors_preserve_copy() {
        assert_eq!(
            LobbyFeedback::status("正在连接"),
            LobbyFeedback::Status("正在连接".to_owned())
        );
        assert_eq!(
            LobbyFeedback::error("房间不存在"),
            LobbyFeedback::Error("房间不存在".to_owned())
        );
        assert_eq!(
            LobbyFeedback::join_error("房间不存在"),
            LobbyFeedback::JoinError("房间不存在".to_owned())
        );
        assert_eq!(
            LobbyFeedback::create_error("暂时无法创建房间"),
            LobbyFeedback::CreateError("暂时无法创建房间".to_owned())
        );
    }

    #[test]
    fn error_descriptions_target_only_the_related_action() {
        let join_html = render_feedback_lobby_for_test(LobbyFeedback::join_error("房间不存在"));
        assert!(join_html.contains("id=\"room-code-error\""));
        assert_eq!(
            join_html
                .matches("aria-describedby=\"room-code-error\"")
                .count(),
            1
        );
        assert!(!join_html.contains("create-room-error"));

        let create_html =
            render_feedback_lobby_for_test(LobbyFeedback::create_error("暂时无法创建房间"));
        assert!(create_html.contains("id=\"create-room-error\""));
        assert_eq!(
            create_html
                .matches("aria-describedby=\"create-room-error\"")
                .count(),
            1
        );
        assert!(!create_html.contains("room-code-error"));

        let system_html =
            render_feedback_lobby_for_test(LobbyFeedback::error("安全会话初始化失败"));
        assert!(system_html.contains("id=\"lobby-error\""));
        assert!(!system_html.contains("aria-describedby"));
    }

    #[test]
    fn invite_notice_reuses_the_guidance_slot() {
        let html = dioxus_ssr::render_element(rsx! { InviteLobbyForTest {} });

        assert!(html.contains("lobby-guidance"));
        assert!(html.contains("invite-copy-spacer"));
        assert!(html.contains(INVITE_READY_COPY));
    }

    #[component]
    fn InviteLobbyForTest() -> Element {
        rsx! {
            LobbyShell {
                room_code: rsx! { span {} },
                footer: rsx! { span {} },
                invite_ready: true,
            }
        }
    }

    fn render_initializing_lobby_for_test() -> String {
        dioxus_ssr::render_element(initializing_lobby_element())
    }

    fn render_feedback_lobby_for_test(feedback: LobbyFeedback) -> String {
        dioxus_ssr::render_element(rsx! { FeedbackLobbyForTest { feedback } })
    }

    #[component]
    fn FeedbackLobbyForTest(feedback: LobbyFeedback) -> Element {
        rsx! {
            LobbyShell {
                room_code: rsx! { span {} },
                footer: rsx! { span {} },
                feedback,
            }
        }
    }
}
