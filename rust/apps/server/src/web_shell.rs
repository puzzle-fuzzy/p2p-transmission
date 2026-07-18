use std::{
    fs, io,
    path::{Path, PathBuf},
};

use axum::{
    Extension,
    body::{Body, Bytes},
    http::{HeaderValue, header},
    response::Response,
};
use thiserror::Error;

pub const SSR_LOBBY_START: &str = "<!-- P2P_SSR_LOBBY_START -->";
pub const SSR_LOBBY_END: &str = "<!-- P2P_SSR_LOBBY_END -->";

const BOOT_FALLBACK_ID: &str = "id=\"boot-fallback\"";
const ISLAND_MOUNT_ID: &str = "id=\"main\"";
const RELEASE_PLACEHOLDER: &str = "__P2P_RELEASE__";
const RELEASE_FINGERPRINT_COUNT: usize = 3;
const VERSIONED_SHELL_ASSET_REFERENCES: [&str; RELEASE_FINGERPRINT_COUNT] = [
    "href=\"/shell/app-shell.css?v=__P2P_RELEASE__\"",
    "src=\"/shell/room-restore.js?v=__P2P_RELEASE__\"",
    "src=\"/shell/app-shell.js?v=__P2P_RELEASE__\"",
];

#[cfg(test)]
// Combined with the release template's 2 KiB raw ceiling, this keeps the
// deployed server-rendered response below 8 KiB before compression.
const SSR_SOURCE_RESPONSE_RAW_BUDGET: usize = 6 * 1024;

#[cfg(test)]
pub(crate) const TEST_WEB_SHELL_TEMPLATE: &str = concat!(
    "<!doctype html><head>",
    "<link rel=\"stylesheet\" href=\"/shell/app-shell.css?v=__P2P_RELEASE__\">",
    "<script src=\"/shell/room-restore.js?v=__P2P_RELEASE__\"></script>",
    "<script src=\"/shell/app-shell.js?v=__P2P_RELEASE__\" defer></script>",
    "</head><body>",
    "<!-- P2P_SSR_LOBBY_START -->",
    "<div id=\"boot-fallback\"><main>build fallback</main></div>",
    "<!-- P2P_SSR_LOBBY_END -->",
    "<div id=\"main\" hidden inert aria-hidden=\"true\"></div>",
    "</body>"
);

/// An immutable application shell assembled at startup from the Dioxus index
/// template and trusted, server-rendered lobby markup.
///
/// Keeping the rendered bytes immutable makes the root response independent of
/// cookies, query parameters and URL fragments. Browser-only room state remains
/// the responsibility of the WebAssembly island.
#[derive(Clone, Debug)]
pub struct WebShellRenderer {
    html: Bytes,
}

impl WebShellRenderer {
    pub fn from_web_root(web_root: impl AsRef<Path>) -> Result<Self, WebShellError> {
        let lobby_html = dioxus_ssr::render_element(p2p_ui_shell::initializing_lobby_element());
        Self::from_path(web_root.as_ref().join("index.html"), &lobby_html)
    }

    pub fn from_path(
        index_path: impl AsRef<Path>,
        lobby_html: &str,
    ) -> Result<Self, WebShellError> {
        let index_path = index_path.as_ref();
        let template = fs::read_to_string(index_path).map_err(|source| WebShellError::Read {
            path: index_path.to_path_buf(),
            source,
        })?;
        Self::from_template(&template, lobby_html).map_err(WebShellError::Template)
    }

    pub fn from_template(template: &str, lobby_html: &str) -> Result<Self, WebShellTemplateError> {
        if lobby_html.trim().is_empty() {
            return Err(WebShellTemplateError::EmptyLobby);
        }
        if lobby_html.contains(SSR_LOBBY_START)
            || lobby_html.contains(SSR_LOBBY_END)
            || lobby_html.contains(RELEASE_PLACEHOLDER)
        {
            return Err(WebShellTemplateError::ReservedMarkerInLobby);
        }
        let boot_fallback_count = lobby_html.matches(BOOT_FALLBACK_ID).count();
        if boot_fallback_count != 1 {
            return Err(WebShellTemplateError::BootFallbackCount {
                actual: boot_fallback_count,
            });
        }
        if lobby_html.contains(ISLAND_MOUNT_ID) {
            return Err(WebShellTemplateError::IslandMountInLobby);
        }

        let start = unique_marker_offset(template, SSR_LOBBY_START)?;
        let end = unique_marker_offset(template, SSR_LOBBY_END)?;
        if start >= end {
            return Err(WebShellTemplateError::MarkerOrder);
        }

        if template
            .match_indices(BOOT_FALLBACK_ID)
            .any(|(offset, _)| offset <= start || offset >= end)
        {
            return Err(WebShellTemplateError::BootFallbackOutsidePlaceholder);
        }

        let island_mount_count = template.matches(ISLAND_MOUNT_ID).count();
        if island_mount_count != 1 {
            return Err(WebShellTemplateError::IslandMountCount {
                actual: island_mount_count,
            });
        }
        let island_mount = template
            .find(ISLAND_MOUNT_ID)
            .expect("the exact island mount count was validated");
        if island_mount <= end {
            return Err(WebShellTemplateError::IslandInsideLobby);
        }

        let release_fingerprint_count = template.matches(RELEASE_PLACEHOLDER).count();
        if release_fingerprint_count != RELEASE_FINGERPRINT_COUNT {
            return Err(WebShellTemplateError::ReleaseFingerprintCount {
                actual: release_fingerprint_count,
            });
        }
        for reference in VERSIONED_SHELL_ASSET_REFERENCES {
            let actual = template.matches(reference).count();
            if actual != 1 {
                return Err(WebShellTemplateError::VersionedShellAssetReferenceCount {
                    reference,
                    actual,
                });
            }
        }

        let release = crate::release_version();
        if !crate::is_safe_release_version(release) {
            return Err(WebShellTemplateError::InvalidReleaseVersion);
        }

        let lobby_html = lobby_html.trim();
        let mut html = String::with_capacity(template.len() + lobby_html.len());
        let content_start = start + SSR_LOBBY_START.len();
        html.push_str(&template[..content_start]);
        html.push('\n');
        html.push_str(lobby_html);
        html.push('\n');
        html.push_str(&template[end..]);

        let html = html.replace(RELEASE_PLACEHOLDER, release);
        Ok(Self {
            html: Bytes::from(html),
        })
    }

    pub fn response(&self) -> Response {
        let mut response = Response::new(Body::from(self.html.clone()));
        response.headers_mut().insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("text/html; charset=utf-8"),
        );
        response.headers_mut().insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-cache, must-revalidate"),
        );
        response
    }

    #[cfg(test)]
    fn html(&self) -> &str {
        std::str::from_utf8(&self.html).expect("web shell is assembled from UTF-8 strings")
    }
}

/// Serves the prebuilt public shell. This handler deliberately has no request
/// extractors beyond the immutable renderer, so request state cannot influence
/// the server-rendered lobby.
pub async fn root(Extension(renderer): Extension<WebShellRenderer>) -> Response {
    renderer.response()
}

fn unique_marker_offset(
    template: &str,
    marker: &'static str,
) -> Result<usize, WebShellTemplateError> {
    let mut offsets = template.match_indices(marker).map(|(offset, _)| offset);
    let Some(offset) = offsets.next() else {
        return Err(WebShellTemplateError::MarkerCount { marker, actual: 0 });
    };
    if offsets.next().is_some() {
        return Err(WebShellTemplateError::MarkerCount {
            marker,
            actual: template.matches(marker).count(),
        });
    }
    Ok(offset)
}

#[derive(Debug, Error)]
pub enum WebShellError {
    #[error("failed to read web shell template {path}: {source}")]
    Read {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("invalid web shell template: {0}")]
    Template(#[source] WebShellTemplateError),
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum WebShellTemplateError {
    #[error("expected exactly one {marker}, found {actual}")]
    MarkerCount { marker: &'static str, actual: usize },
    #[error("the SSR lobby start marker must precede its end marker")]
    MarkerOrder,
    #[error("the SSR lobby HTML must not be empty")]
    EmptyLobby,
    #[error("the SSR lobby HTML contains a reserved template marker")]
    ReservedMarkerInLobby,
    #[error("the web shell must contain exactly three release fingerprints, found {actual}")]
    ReleaseFingerprintCount { actual: usize },
    #[error("the web shell must contain exactly one {reference}, found {actual}")]
    VersionedShellAssetReferenceCount {
        reference: &'static str,
        actual: usize,
    },
    #[error(
        "the release version may contain only ASCII letters, digits, dots, underscores, and hyphens"
    )]
    InvalidReleaseVersion,
    #[error("the SSR lobby HTML must contain exactly one #boot-fallback, found {actual}")]
    BootFallbackCount { actual: usize },
    #[error("the SSR lobby HTML must not contain the #main WebAssembly island mount")]
    IslandMountInLobby,
    #[error("#boot-fallback in the template must be inside the SSR lobby placeholder")]
    BootFallbackOutsidePlaceholder,
    #[error(
        "the web shell must contain exactly one #main WebAssembly island mount, found {actual}"
    )]
    IslandMountCount { actual: usize },
    #[error("the #main WebAssembly island mount must follow the SSR lobby")]
    IslandInsideLobby,
}

#[cfg(test)]
mod tests {
    use http_body_util::BodyExt;

    use super::*;

    #[test]
    fn production_template_accepts_the_shared_lobby() {
        let lobby_html = dioxus_ssr::render_element(p2p_ui_shell::initializing_lobby_element());
        let renderer =
            WebShellRenderer::from_template(include_str!("../../web/index.html"), &lobby_html)
                .expect("production template and shared lobby must remain compatible");

        assert!(renderer.html().contains(p2p_ui_shell::LOBBY_TITLE));
        assert!(renderer.html().contains(p2p_ui_shell::RESTORING_ROOM_COPY));
        assert!(renderer.html().contains(p2p_ui_shell::NOSCRIPT_COPY));
        assert_eq!(renderer.html().matches(BOOT_FALLBACK_ID).count(), 1);
        assert_eq!(renderer.html().matches(ISLAND_MOUNT_ID).count(), 1);
        let release = crate::release_version();
        assert!(
            renderer
                .html()
                .contains(&format!("href=\"/shell/app-shell.css?v={release}\""))
        );
        assert!(
            renderer
                .html()
                .contains(&format!("src=\"/shell/room-restore.js?v={release}\""))
        );
        assert!(
            renderer
                .html()
                .contains(&format!("src=\"/shell/app-shell.js?v={release}\""))
        );
        assert!(!renderer.html().contains(RELEASE_PLACEHOLDER));
        assert!(
            renderer
                .html()
                .contains("href=\"/favicon.svg\" type=\"image/svg+xml\" sizes=\"any\"")
        );
        assert!(!renderer.html().contains("href=\"/favicon.ico\""));
        let critical_restore_style = renderer
            .html()
            .find(".boot-room-restore { display: none; }")
            .expect("the room restore state needs inline critical CSS for old service workers");
        let restore_reference =
            format!("<script src=\"/shell/room-restore.js?v={release}\"></script>");
        let restore_script = renderer
            .html()
            .find(&restore_reference)
            .expect("the room restore hint must block body parsing before first paint");
        let fallback = renderer
            .html()
            .find(BOOT_FALLBACK_ID)
            .expect("the boot fallback must exist");
        assert!(critical_restore_style < restore_script);
        assert!(restore_script < fallback);
        assert!(
            renderer.html().len() <= SSR_SOURCE_RESPONSE_RAW_BUDGET,
            "server-rendered source shell is {} bytes; budget is {} bytes",
            renderer.html().len(),
            SSR_SOURCE_RESPONSE_RAW_BUDGET,
        );
    }

    #[test]
    fn replaces_only_the_lobby_and_preserves_the_island_contract() {
        let renderer = WebShellRenderer::from_template(
            TEST_WEB_SHELL_TEMPLATE,
            "<div id=\"boot-fallback\"><main><h1>加入房间</h1></main></div>",
        )
        .expect("valid web shell");

        assert!(renderer.html().contains("<h1>加入房间</h1>"));
        assert!(!renderer.html().contains("build fallback"));
        assert!(renderer.html().contains(SSR_LOBBY_START));
        assert!(renderer.html().contains(SSR_LOBBY_END));
        assert!(
            renderer
                .html()
                .contains("<div id=\"main\" hidden inert aria-hidden=\"true\"></div>")
        );
    }

    #[test]
    fn rejects_invalid_or_ambiguous_template_boundaries() {
        let missing_end = TEST_WEB_SHELL_TEMPLATE.replace(SSR_LOBBY_END, "");
        assert_eq!(
            WebShellRenderer::from_template(
                &missing_end,
                "<div id=\"boot-fallback\"><main>lobby</main></div>",
            )
            .expect_err("missing marker must fail"),
            WebShellTemplateError::MarkerCount {
                marker: SSR_LOBBY_END,
                actual: 0,
            }
        );

        let duplicate_start = TEST_WEB_SHELL_TEMPLATE.replace(
            SSR_LOBBY_START,
            &format!("{SSR_LOBBY_START}{SSR_LOBBY_START}"),
        );
        assert_eq!(
            WebShellRenderer::from_template(
                &duplicate_start,
                "<div id=\"boot-fallback\"><main>lobby</main></div>",
            )
            .expect_err("duplicate marker must fail"),
            WebShellTemplateError::MarkerCount {
                marker: SSR_LOBBY_START,
                actual: 2,
            }
        );

        let reversed = TEST_WEB_SHELL_TEMPLATE
            .replace(SSR_LOBBY_START, "__START__")
            .replace(SSR_LOBBY_END, SSR_LOBBY_START)
            .replace("__START__", SSR_LOBBY_END);
        assert_eq!(
            WebShellRenderer::from_template(
                &reversed,
                "<div id=\"boot-fallback\"><main>lobby</main></div>",
            )
            .expect_err("reversed markers must fail"),
            WebShellTemplateError::MarkerOrder
        );
    }

    #[test]
    fn rejects_missing_or_misplaced_release_fingerprints() {
        let lobby = "<div id=\"boot-fallback\"><main>lobby</main></div>";
        let unversioned = TEST_WEB_SHELL_TEMPLATE.replace("?v=__P2P_RELEASE__", "");
        assert_eq!(
            WebShellRenderer::from_template(&unversioned, lobby)
                .expect_err("unversioned shell assets must fail"),
            WebShellTemplateError::ReleaseFingerprintCount { actual: 0 }
        );

        let misplaced = TEST_WEB_SHELL_TEMPLATE.replace(
            "href=\"/shell/app-shell.css?v=__P2P_RELEASE__\"",
            "href=\"/shell/other.css?v=__P2P_RELEASE__\"",
        );
        assert_eq!(
            WebShellRenderer::from_template(&misplaced, lobby)
                .expect_err("a fingerprint on the wrong asset must fail"),
            WebShellTemplateError::VersionedShellAssetReferenceCount {
                reference: VERSIONED_SHELL_ASSET_REFERENCES[0],
                actual: 0,
            }
        );
    }

    #[test]
    fn release_fingerprint_character_set_is_url_and_javascript_safe() {
        for valid in ["2.0.1", "2.0.1-abcdef0", "release_candidate-1"] {
            assert!(crate::is_safe_release_version(valid));
        }
        for invalid in ["", "release+1", "release&1", "release'1", "版本-1"] {
            assert!(!crate::is_safe_release_version(invalid));
        }
    }

    #[test]
    fn rejects_shells_that_could_replace_the_wasm_mount() {
        let island_inside = TEST_WEB_SHELL_TEMPLATE
            .replace(
                "<div id=\"main\" hidden inert aria-hidden=\"true\"></div>",
                "",
            )
            .replace(
                SSR_LOBBY_END,
                "<div id=\"main\"></div><!-- P2P_SSR_LOBBY_END -->",
            );
        assert_eq!(
            WebShellRenderer::from_template(
                &island_inside,
                "<div id=\"boot-fallback\"><main>lobby</main></div>",
            )
            .expect_err("island in replacement boundary must fail"),
            WebShellTemplateError::IslandInsideLobby
        );
    }

    #[tokio::test]
    async fn root_response_has_explicit_html_and_revalidation_headers() {
        let response = WebShellRenderer::from_template(
            TEST_WEB_SHELL_TEMPLATE,
            "<div id=\"boot-fallback\"><main>lobby</main></div>",
        )
        .expect("valid web shell")
        .response();

        assert_eq!(
            response.headers()[header::CONTENT_TYPE],
            HeaderValue::from_static("text/html; charset=utf-8")
        );
        assert_eq!(
            response.headers()[header::CACHE_CONTROL],
            HeaderValue::from_static("no-cache, must-revalidate")
        );
        let body = response
            .into_body()
            .collect()
            .await
            .expect("collect web shell response")
            .to_bytes();
        assert!(String::from_utf8_lossy(&body).contains("<main>lobby</main>"));
    }
}
