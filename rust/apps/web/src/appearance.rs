use dioxus::prelude::*;
use p2p_browser_platform::{
    close_modal_dialog, load_ui_preference, save_ui_preference, set_document_attribute,
    show_modal_dialog,
};

const THEME_STORAGE_KEY: &str = "vault-theme";
const WALLPAPER_STORAGE_KEY: &str = "vault-wallpaper";
const LANGUAGE_STORAGE_KEY: &str = "vault-language";

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(super) enum Theme {
    #[default]
    Mist,
    Slate,
    Dusk,
    Sand,
}

impl Theme {
    const ALL: [Self; 4] = [Self::Mist, Self::Slate, Self::Dusk, Self::Sand];

    fn parse(value: &str) -> Option<Self> {
        match value {
            "mist" => Some(Self::Mist),
            "slate" => Some(Self::Slate),
            "dusk" => Some(Self::Dusk),
            "sand" => Some(Self::Sand),
            _ => None,
        }
    }

    fn value(self) -> &'static str {
        match self {
            Self::Mist => "mist",
            Self::Slate => "slate",
            Self::Dusk => "dusk",
            Self::Sand => "sand",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Mist => "Mist",
            Self::Slate => "Slate",
            Self::Dusk => "Dusk",
            Self::Sand => "Sand",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(super) enum Wallpaper {
    #[default]
    Quiet,
    Paper,
    Plain,
}

impl Wallpaper {
    const ALL: [Self; 3] = [Self::Quiet, Self::Paper, Self::Plain];

    fn parse(value: &str) -> Option<Self> {
        match value {
            "quiet" => Some(Self::Quiet),
            "paper" => Some(Self::Paper),
            "plain" => Some(Self::Plain),
            _ => None,
        }
    }

    fn value(self) -> &'static str {
        match self {
            Self::Quiet => "quiet",
            Self::Paper => "paper",
            Self::Plain => "plain",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Quiet => "柔光",
            Self::Paper => "纸雾",
            Self::Plain => "纯色",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(super) enum Language {
    #[default]
    Chinese,
    English,
}

impl Language {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "zh" => Some(Self::Chinese),
            "en" => Some(Self::English),
            _ => None,
        }
    }

    fn value(self) -> &'static str {
        match self {
            Self::Chinese => "zh",
            Self::English => "en",
        }
    }

    fn document_lang(self) -> &'static str {
        match self {
            Self::Chinese => "zh-CN",
            Self::English => "en",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(super) struct Appearance {
    pub(super) theme: Theme,
    pub(super) wallpaper: Wallpaper,
    pub(super) language: Language,
}

impl Appearance {
    pub(super) fn load() -> Self {
        let theme = load_ui_preference(THEME_STORAGE_KEY)
            .ok()
            .flatten()
            .as_deref()
            .and_then(Theme::parse)
            .unwrap_or_default();
        let wallpaper = load_ui_preference(WALLPAPER_STORAGE_KEY)
            .ok()
            .flatten()
            .as_deref()
            .and_then(Wallpaper::parse)
            .unwrap_or_default();
        let language = load_ui_preference(LANGUAGE_STORAGE_KEY)
            .ok()
            .flatten()
            .as_deref()
            .and_then(Language::parse)
            .unwrap_or_default();
        let appearance = Self {
            theme,
            wallpaper,
            language,
        };
        appearance.apply_document();
        appearance
    }

    fn apply_document(self) {
        let _ = set_document_attribute("data-theme", self.theme.value());
        let _ = set_document_attribute("data-wallpaper", self.wallpaper.value());
        let _ = set_document_attribute("data-language", self.language.value());
        let _ = set_document_attribute("lang", self.language.document_lang());
    }

    fn persist(self) {
        self.apply_document();
        let _ = save_ui_preference(THEME_STORAGE_KEY, self.theme.value());
        let _ = save_ui_preference(WALLPAPER_STORAGE_KEY, self.wallpaper.value());
        let _ = save_ui_preference(LANGUAGE_STORAGE_KEY, self.language.value());
    }
}

#[component]
pub(super) fn AppearanceDialog(
    mut appearance: Signal<Appearance>,
    mut open: Signal<bool>,
) -> Element {
    use_effect(|| {
        let _ = show_modal_dialog("appearance-dialog");
    });
    let current = appearance();

    rsx! {
        dialog {
            id: "appearance-dialog",
            class: "appearance-dialog",
            aria_labelledby: "appearance-title",
            oncancel: move |event| {
                event.prevent_default();
                close_appearance_dialog(open);
            },
            header { class: "appearance-heading",
                div {
                    p { class: "appearance-kicker", "Vault preferences" }
                    h2 { id: "appearance-title", "界面设置" }
                }
                button {
                    class: "appearance-close",
                    r#type: "button",
                    aria_label: "关闭界面设置",
                    onclick: move |_| close_appearance_dialog(open),
                    "×"
                }
            }
            section { class: "appearance-section", aria_labelledby: "language-label",
                div { class: "appearance-label",
                    h3 { id: "language-label", "语言 / Language" }
                    span { if current.language == Language::Chinese { "中文" } else { "English" } }
                }
                div { class: "appearance-segment", role: "group", aria_label: "语言切换",
                    for language in [Language::Chinese, Language::English] {
                        button {
                            class: if current.language == language { "appearance-choice active" } else { "appearance-choice" },
                            r#type: "button",
                            aria_pressed: current.language == language,
                            onclick: move |_| {
                                let next = Appearance { language, ..appearance() };
                                next.persist();
                                appearance.set(next);
                            },
                            if language == Language::Chinese { "中文" } else { "English" }
                        }
                    }
                }
                p { class: "appearance-hint", "语言偏好会保留；当前产品操作文案以中文为准。" }
            }
            section { class: "appearance-section", aria_labelledby: "theme-label",
                div { class: "appearance-label",
                    h3 { id: "theme-label", "主题 / Theme" }
                    span { "4 presets" }
                }
                div { class: "theme-options", role: "group", aria_label: "主题切换",
                    for theme in Theme::ALL {
                        button {
                            class: if current.theme == theme { "theme-option active" } else { "theme-option" },
                            r#type: "button",
                            aria_label: "切换到 {theme.label()} 主题",
                            aria_pressed: current.theme == theme,
                            onclick: move |_| {
                                let next = Appearance { theme, ..appearance() };
                                next.persist();
                                appearance.set(next);
                            },
                            span { class: "theme-swatch theme-{theme.value()}", aria_hidden: "true" }
                            span { "{theme.label()}" }
                        }
                    }
                }
            }
            section { class: "appearance-section", aria_labelledby: "wallpaper-label",
                div { class: "appearance-label",
                    h3 { id: "wallpaper-label", "背景壁纸 / Wallpaper" }
                    span { "Atmosphere" }
                }
                div { class: "wallpaper-options", role: "group", aria_label: "背景壁纸切换",
                    for wallpaper in Wallpaper::ALL {
                        button {
                            class: if current.wallpaper == wallpaper { "wallpaper-option active" } else { "wallpaper-option" },
                            r#type: "button",
                            aria_pressed: current.wallpaper == wallpaper,
                            onclick: move |_| {
                                let next = Appearance { wallpaper, ..appearance() };
                                next.persist();
                                appearance.set(next);
                            },
                            span { class: "wallpaper-swatch wallpaper-{wallpaper.value()}", aria_hidden: "true" }
                            span { "{wallpaper.label()}" }
                        }
                    }
                }
            }
        }
    }
}

fn close_appearance_dialog(mut open: Signal<bool>) {
    let _ = close_modal_dialog("appearance-dialog");
    open.set(false);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appearance_values_are_stable_for_storage_and_css() {
        assert_eq!(Theme::parse("dusk"), Some(Theme::Dusk));
        assert_eq!(Theme::Sand.value(), "sand");
        assert_eq!(Wallpaper::parse("plain"), Some(Wallpaper::Plain));
        assert_eq!(Language::English.document_lang(), "en");
    }
}
