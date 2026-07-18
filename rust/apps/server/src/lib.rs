#![forbid(unsafe_code)]

pub mod config;
pub mod http_api;
pub mod maintenance;
pub mod observability;
pub mod rate_limit;
pub mod realtime;
pub mod services;
pub mod storage;
pub mod web_shell;

use std::{
    path::{Path, PathBuf},
    time::Duration,
};

use axum::{
    Extension, Json, Router,
    http::{HeaderName, HeaderValue, StatusCode, header},
    middleware,
    response::{IntoResponse, Response},
    routing::get,
};
use http_api::AppState;
use p2p_domain::PRODUCT_NAME;
use p2p_protocol::{API_MAJOR_VERSION, BuildInfo};
use tower_http::{
    services::ServeDir, set_header::SetResponseHeaderLayer, timeout::TimeoutLayer,
    trace::TraceLayer,
};

const CONTENT_SECURITY_POLICY: &str = "default-src 'self'; connect-src 'self' ws: wss:; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
const APP_CSS: &str = include_str!("../../web/assets/main.css");
const APP_SHELL_JS: &str = include_str!("../assets/app-shell.js");
const ROOM_RESTORE_JS: &str = include_str!("../assets/room-restore.js");
const WEB_MANIFEST: &str = include_str!("../assets/manifest.webmanifest");
const SERVICE_WORKER: &str = include_str!("../assets/sw.js");

pub fn release_version() -> &'static str {
    option_env!("P2P_RELEASE_VERSION").unwrap_or(env!("CARGO_PKG_VERSION"))
}

pub(crate) fn is_safe_release_version(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

pub fn app(
    web_root: impl Into<PathBuf>,
    state: AppState,
) -> Result<Router, web_shell::WebShellError> {
    let web_root = web_root.into();
    let shell_renderer = web_shell::WebShellRenderer::from_web_root(&web_root)?;
    let static_files = ServeDir::new(web_root);
    let observability = state.observability.clone();

    Ok(Router::new()
        .route("/", get(web_shell::root).layer(Extension(shell_renderer)))
        // Prevent the static fallback from exposing a second HTML entrypoint.
        .route("/index.html", get(missing_html_entry))
        .route("/shell/app-shell.css", get(app_css))
        .route("/shell/room-restore.js", get(room_restore_js))
        .route("/shell/app-shell.js", get(app_shell_js))
        .route("/manifest.webmanifest", get(web_manifest))
        .route("/sw.js", get(service_worker))
        .route("/health/live", get(live))
        .route("/health/ready", get(http_api::ready))
        .route(
            "/internal/metrics",
            get(observability::metrics).layer(Extension(observability.clone())),
        )
        .route("/realtime", get(realtime::socket::upgrade))
        .route("/api/meta", get(meta))
        .nest("/api", http_api::router())
        .fallback_service(static_files)
        .layer(SetResponseHeaderLayer::if_not_present(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static(CONTENT_SECURITY_POLICY),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::REFERRER_POLICY,
            HeaderValue::from_static("no-referrer"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            HeaderName::from_static("permissions-policy"),
            HeaderValue::from_static("camera=(), microphone=(), geolocation=()"),
        ))
        .layer(TimeoutLayer::with_status_code(
            StatusCode::REQUEST_TIMEOUT,
            Duration::from_secs(30),
        ))
        .layer(TraceLayer::new_for_http())
        .layer(middleware::from_fn_with_state(
            observability,
            observability::track_http,
        ))
        .with_state(state))
}

async fn missing_html_entry() -> StatusCode {
    StatusCode::NOT_FOUND
}

async fn app_css() -> Response {
    let mut response = embedded_asset("text/css; charset=utf-8", APP_CSS);
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-cache, must-revalidate"),
    );
    response
}

async fn app_shell_js() -> Response {
    let mut response = embedded_asset("text/javascript; charset=utf-8", APP_SHELL_JS);
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-cache, must-revalidate"),
    );
    response
}

async fn room_restore_js() -> Response {
    let mut response = embedded_asset("text/javascript; charset=utf-8", ROOM_RESTORE_JS);
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-cache, must-revalidate"),
    );
    response
}

async fn web_manifest() -> Response {
    embedded_asset("application/manifest+json; charset=utf-8", WEB_MANIFEST)
}

async fn service_worker() -> Response {
    let body = SERVICE_WORKER.replace("__P2P_RELEASE__", release_version());
    let mut response = embedded_asset("text/javascript; charset=utf-8", body);
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-cache, must-revalidate"),
    );
    response.headers_mut().insert(
        HeaderName::from_static("service-worker-allowed"),
        HeaderValue::from_static("/"),
    );
    response
}

fn embedded_asset(content_type: &'static str, body: impl IntoResponse) -> Response {
    (
        [
            (header::CONTENT_TYPE, HeaderValue::from_static(content_type)),
            (
                header::CACHE_CONTROL,
                HeaderValue::from_static("public, max-age=3600"),
            ),
        ],
        body,
    )
        .into_response()
}

pub fn default_web_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../target/dx/p2p-web/release/web/public")
}

async fn live() -> StatusCode {
    StatusCode::NO_CONTENT
}

async fn meta() -> Json<BuildInfo> {
    Json(BuildInfo {
        product: PRODUCT_NAME.to_owned(),
        version: env!("CARGO_PKG_VERSION").to_owned(),
        release: release_version().to_owned(),
        api_major: API_MAJOR_VERSION,
    })
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use http_body_util::BodyExt;
    use serde_json::Value;
    use tower::ServiceExt;

    use super::*;

    async fn test_state(path: &Path) -> AppState {
        let config = config::AppConfig {
            database_path: path.join("test.sqlite3"),
            ..config::AppConfig::default()
        };
        let storage = storage::Storage::connect(&config.database_path)
            .await
            .expect("connect test database");
        AppState::new(services::AppServices::new(storage, config))
    }

    fn fixture_dir() -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time is after unix epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("p2p-server-{nonce}"));
        fs::create_dir_all(&path).expect("create static fixture directory");
        fs::write(path.join("index.html"), web_shell::TEST_WEB_SHELL_TEMPLATE)
            .expect("write static fixture");
        path
    }

    fn test_app(web_root: &Path, state: AppState) -> Router {
        app(web_root, state).expect("assemble test web shell")
    }

    #[tokio::test]
    async fn health_and_build_metadata_are_available() {
        let web_root = fixture_dir();
        let state = test_state(&web_root).await;
        let router = test_app(&web_root, state.clone());

        let health = router
            .clone()
            .oneshot(
                Request::get("/health/ready")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("health response");
        assert_eq!(health.status(), StatusCode::OK);
        assert_eq!(
            health.headers()[header::X_CONTENT_TYPE_OPTIONS],
            HeaderValue::from_static("nosniff")
        );
        let body = health
            .into_body()
            .collect()
            .await
            .expect("collect health body")
            .to_bytes();
        let value: Value = serde_json::from_slice(&body).expect("health json");
        assert_eq!(value["status"], "ready");
        assert_eq!(value["release"], release_version());

        let metadata = router
            .oneshot(
                Request::get("/api/meta")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("metadata response");
        assert_eq!(metadata.status(), StatusCode::OK);
        let metadata = metadata
            .into_body()
            .collect()
            .await
            .expect("collect metadata body")
            .to_bytes();
        let metadata: Value = serde_json::from_slice(&metadata).expect("metadata json");
        assert_eq!(metadata["release"], release_version());

        state.services.storage.close().await;
        fs::remove_dir_all(web_root).expect("remove static fixture directory");
    }

    #[tokio::test]
    async fn observability_endpoint_reports_router_requests() {
        let web_root = fixture_dir();
        let state = test_state(&web_root).await;
        let router = test_app(&web_root, state.clone());

        let health = router
            .clone()
            .oneshot(
                Request::get("/health/live")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("health response");
        assert_eq!(health.status(), StatusCode::NO_CONTENT);

        let metrics = router
            .oneshot(
                Request::get("/internal/metrics")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("metrics response");
        assert_eq!(metrics.status(), StatusCode::OK);
        assert_eq!(
            metrics.headers()[header::CONTENT_TYPE],
            HeaderValue::from_static("text/plain; version=0.0.4; charset=utf-8")
        );
        assert_eq!(
            metrics.headers()[header::CACHE_CONTROL],
            HeaderValue::from_static("no-store")
        );
        let metrics = metrics
            .into_body()
            .collect()
            .await
            .expect("collect metrics")
            .to_bytes();
        let metrics = String::from_utf8(metrics.to_vec()).expect("metrics UTF-8");
        assert!(metrics.contains("p2p_http_requests_total 1\n"));
        assert!(metrics.contains("p2p_websocket_connections_active 0\n"));

        state.services.storage.close().await;
        fs::remove_dir_all(web_root).expect("remove static fixture directory");
    }

    #[tokio::test]
    async fn root_is_the_only_application_entrypoint() {
        let web_root = fixture_dir();
        let state = test_state(&web_root).await;
        let response = test_app(&web_root, state.clone())
            .oneshot(Request::get("/").body(Body::empty()).expect("request"))
            .await
            .expect("application response");

        assert_eq!(response.status(), StatusCode::OK);
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
            .expect("collect application body")
            .to_bytes();
        let body = String::from_utf8(body.to_vec()).expect("application utf-8");
        assert!(body.contains(p2p_ui_shell::LOBBY_TITLE));
        assert!(!body.contains("build fallback"));
        assert_eq!(body.matches("id=\"boot-fallback\"").count(), 1);
        assert_eq!(body.matches("id=\"main\"").count(), 1);

        for path in [
            "/app",
            "/app/",
            "/app?intent=create",
            "/app/?room=ABC234",
            "/index.html",
            "/shell/app.css",
            "/unknown-route",
            "/assets/missing.js",
            "/appx",
        ] {
            let missing = test_app(&web_root, state.clone())
                .oneshot(Request::get(path).body(Body::empty()).expect("request"))
                .await
                .expect("missing static response");
            assert_eq!(missing.status(), StatusCode::NOT_FOUND);
        }

        state.services.storage.close().await;
        fs::remove_dir_all(web_root).expect("remove static fixture directory");
    }

    #[tokio::test]
    async fn invalid_web_shell_fails_during_router_construction() {
        let web_root = fixture_dir();
        fs::write(
            web_root.join("index.html"),
            "<div id=\"main\" hidden></div>",
        )
        .expect("write invalid web shell fixture");
        let state = test_state(&web_root).await;

        let result = app(&web_root, state.clone());
        assert!(matches!(
            result,
            Err(web_shell::WebShellError::Template(
                web_shell::WebShellTemplateError::MarkerCount {
                    marker: web_shell::SSR_LOBBY_START,
                    actual: 0,
                }
            ))
        ));

        state.services.storage.close().await;
        fs::remove_dir_all(web_root).expect("remove static fixture directory");
    }

    #[tokio::test]
    async fn installable_shell_assets_have_safe_cache_boundaries() {
        let web_root = fixture_dir();
        let state = test_state(&web_root).await;
        let router = test_app(&web_root, state.clone());

        let manifest = router
            .clone()
            .oneshot(
                Request::get("/manifest.webmanifest")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("manifest response");
        assert_eq!(manifest.status(), StatusCode::OK);
        assert_eq!(
            manifest.headers()[header::CONTENT_TYPE],
            HeaderValue::from_static("application/manifest+json; charset=utf-8")
        );

        let service_worker = router
            .clone()
            .oneshot(Request::get("/sw.js").body(Body::empty()).expect("request"))
            .await
            .expect("service worker response");
        assert_eq!(service_worker.status(), StatusCode::OK);
        assert_eq!(
            service_worker.headers()[header::CACHE_CONTROL],
            HeaderValue::from_static("no-cache, must-revalidate")
        );
        assert_eq!(
            service_worker.headers()[HeaderName::from_static("service-worker-allowed")],
            HeaderValue::from_static("/")
        );
        let service_worker = service_worker
            .into_body()
            .collect()
            .await
            .expect("collect service worker")
            .to_bytes();
        let service_worker =
            String::from_utf8(service_worker.to_vec()).expect("service worker utf-8");
        assert!(service_worker.contains(release_version()));
        assert!(!service_worker.contains("__P2P_RELEASE__"));
        assert!(service_worker.contains("'/shell/app-shell.css'"));
        assert!(service_worker.contains("?v=${encodeURIComponent(RELEASE)}"));
        assert!(service_worker.contains("applicationShellMatchesRelease(html)"));
        assert!(service_worker.contains("currentReleaseShellAsset(url)"));
        assert!(service_worker.contains("cacheFirstShellAsset(request)"));
        assert!(service_worker.contains("networkFirstUnversionedShellAsset(request)"));
        assert!(service_worker.contains("networkFirstAsset(request)"));
        assert!(!service_worker.contains("url.pathname === '/app'"));

        let room_restore = router
            .clone()
            .oneshot(
                Request::get("/shell/room-restore.js")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("room restore hint response");
        assert_eq!(room_restore.status(), StatusCode::OK);
        assert_eq!(
            room_restore.headers()[header::CONTENT_TYPE],
            HeaderValue::from_static("text/javascript; charset=utf-8")
        );
        assert_eq!(
            room_restore.headers()[header::CACHE_CONTROL],
            HeaderValue::from_static("no-cache, must-revalidate")
        );
        let room_restore = room_restore
            .into_body()
            .collect()
            .await
            .expect("collect room restore hint")
            .to_bytes();
        let room_restore =
            String::from_utf8(room_restore.to_vec()).expect("room restore hint utf-8");
        assert!(room_restore.contains("p2p_room_session"));
        assert!(room_restore.contains("data-p2p-room-restore"));

        let app_shell = router
            .clone()
            .oneshot(
                Request::get("/shell/app-shell.js")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("application bootstrap response");
        assert_eq!(app_shell.status(), StatusCode::OK);
        assert_eq!(
            app_shell.headers()[header::CACHE_CONTROL],
            HeaderValue::from_static("no-cache, must-revalidate")
        );

        let app_css = router
            .oneshot(
                Request::get("/shell/app-shell.css")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("application stylesheet response");
        assert_eq!(app_css.status(), StatusCode::OK);
        assert_eq!(
            app_css.headers()[header::CONTENT_TYPE],
            HeaderValue::from_static("text/css; charset=utf-8")
        );
        assert_eq!(
            app_css.headers()[header::CACHE_CONTROL],
            HeaderValue::from_static("no-cache, must-revalidate")
        );

        state.services.storage.close().await;
        fs::remove_dir_all(web_root).expect("remove static fixture directory");
    }
}
