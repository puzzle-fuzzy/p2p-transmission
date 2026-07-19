//! Shared, platform-neutral presentation for the anonymous lobby.
//!
//! This crate deliberately owns no browser APIs, transport state, or server
//! routing. The same component tree can therefore be rendered by Dioxus Web or
//! by the server-side renderer.

use dioxus::prelude::*;

pub const ROOM_CODE_LENGTH: usize = 6;
pub const LOBBY_TITLE: &str = "加入房间";
pub const LOBBY_JOIN_COPY: &str = "输入发送者提供的 6 位房间码，或直接打开邀请链接";
pub const INVITE_READY_COPY: &str = "已读取邀请链接，确认后加入房间";
pub const INITIALIZING_COPY: &str = "正在初始化安全会话，稍候即可使用";
pub const RESTORING_ROOM_COPY: &str = "正在恢复上次房间，请稍候";
pub const JOIN_REQUEST_LABEL: &str = "请求加入";
pub const CREATE_ROOM_LABEL: &str = "创建房间";
pub const ABOUT_LABEL: &str = "关于";
pub const GITHUB_LABEL: &str = "GitHub";
pub const PRIVACY_COPY: &str = "文件和文本正文通过加密的 WebRTC 通道传输，优先尝试设备直连，必要时经加密中继转发；应用服务器只协调连接，不保存传输内容。接收完成的文件会暂存在当前页面中，关闭结果或退出房间后释放。";
pub const NOSCRIPT_COPY: &str = "传输工作区需要浏览器启用 JavaScript 和 WebAssembly。";

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
/// `room_code` supplies either the interactive six-cell input or the inert SSR
/// placeholder. `footer` supplies links/buttons while the shell retains the
/// stable footer layout. Event handlers use Dioxus' renderer-neutral event
/// types, so this crate does not depend on `web-sys`.
#[component]
pub fn LobbyShell(
    room_code: Element,
    footer: Element,
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
        div {
            class: "app-shell",
            main { class: "lobby",
                form {
                    class: "lobby-panel",
                    aria_labelledby: "join-title",
                    onsubmit: move |event| {
                        event.prevent_default();
                        if !primary_disabled {
                            on_submit.call(event);
                        }
                    },
                    h1 { id: "join-title", {LOBBY_TITLE} }
                    div { class: "lobby-guidance",
                        p {
                            class: if invite_ready { "join-copy invite-copy-spacer" } else { "join-copy" },
                            aria_hidden: invite_ready.then_some("true"),
                            {LOBBY_JOIN_COPY}
                        }
                        if invite_ready {
                            div { class: "invite-notice", role: "status",
                                span { class: "invite-mark", aria_hidden: "true", "✓" }
                                span { {INVITE_READY_COPY} }
                            }
                        }
                    }
                    div { class: "room-code-control", {room_code} }
                    LobbyFeedbackRow { feedback }
                    button {
                        class: "primary-button",
                        r#type: "submit",
                        disabled: primary_disabled,
                        aria_describedby: primary_description,
                        {primary_label}
                    }
                    div { class: "divider", aria_hidden: "true",
                        span {}
                        strong { "或" }
                        span {}
                    }
                    button {
                        class: "secondary-button",
                        r#type: "button",
                        disabled: secondary_disabled,
                        aria_describedby: secondary_description,
                        onclick: move |event| {
                            if !secondary_disabled {
                                on_create.call(event);
                            }
                        },
                        {secondary_label}
                    }
                    p { class: "privacy-copy", {PRIVACY_COPY} }
                    div { class: "footer-links", {footer} }
                    noscript {
                        p { class: "boot-noscript", role: "alert", {NOSCRIPT_COPY} }
                    }
                }
            }
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
fn LobbyFeedbackRow(feedback: LobbyFeedback) -> Element {
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
        LobbyFeedback::CreateError(message) => rsx! {
            div { id: "lobby-feedback", class: "form-message",
                p { id: "create-room-error", role: "alert", {message} }
            }
        },
        LobbyFeedback::Error(message) => rsx! {
            div { id: "lobby-feedback", class: "form-message",
                p { id: "lobby-error", role: "alert", {message} }
            }
        },
    }
}

#[component]
fn InitializingRoomCode() -> Element {
    rsx! {
        div { class: "room-code boot-room-code", aria_hidden: "true",
            for index in 0..ROOM_CODE_LENGTH {
                span {
                    key: "{index}",
                    class: "room-code-input boot-room-code-cell",
                }
            }
        }
    }
}

#[component]
fn InitializingFooter() -> Element {
    rsx! {
        span { class: "text-link", aria_hidden: "true", {ABOUT_LABEL} }
        span { class: "text-link", aria_hidden: "true", {GITHUB_LABEL} }
    }
}

#[component]
fn RoomRestoreFallback() -> Element {
    rsx! {
        div { class: "app-shell boot-room-restore",
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
        assert!(html.contains(PRIVACY_COPY));
        assert!(html.contains(NOSCRIPT_COPY));
        assert_eq!(
            html.matches("boot-room-code-cell").count(),
            ROOM_CODE_LENGTH
        );
        assert_eq!(html.matches(" disabled").count(), 2);
        assert!(!html.contains("<input"));
        assert!(!html.contains("<a"));
        assert!(!html.contains("tabindex"));
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
