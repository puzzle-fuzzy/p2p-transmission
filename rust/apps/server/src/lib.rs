#![forbid(unsafe_code)]

pub mod config;
pub mod http_api;
pub mod maintenance;
pub mod rate_limit;
pub mod realtime;
pub mod services;
pub mod storage;

use std::{
    path::{Path, PathBuf},
    time::Duration,
};

use axum::{
    Json, Router,
    http::{HeaderName, HeaderValue, StatusCode, header},
    response::{Html, IntoResponse, Response},
    routing::get,
};
use http_api::AppState;
use p2p_domain::PRODUCT_NAME;
use p2p_protocol::{API_MAJOR_VERSION, BuildInfo};
use tower_http::{
    services::{ServeDir, ServeFile},
    set_header::SetResponseHeaderLayer,
    timeout::TimeoutLayer,
    trace::TraceLayer,
};

const CONTENT_SECURITY_POLICY: &str = "default-src 'self'; connect-src 'self' ws: wss:; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
const LANDING_HTML: &str = include_str!("../assets/landing.html");
const LANDING_CSS: &str = include_str!("../assets/landing.css");
const LANDING_JS: &str = include_str!("../assets/landing.js");
const APP_SHELL_JS: &str = include_str!("../assets/app-shell.js");
const WEB_MANIFEST: &str = include_str!("../assets/manifest.webmanifest");
const SERVICE_WORKER: &str = include_str!("../assets/sw.js");

pub fn app(web_root: impl Into<PathBuf>, state: AppState) -> Router {
    let web_root = web_root.into();
    let index = web_root.join("index.html");
    let static_files = ServeDir::new(web_root).fallback(ServeFile::new(index.clone()));

    Router::new()
        .route("/", get(landing))
        .route_service("/app", ServeFile::new(index))
        .route("/shell/landing.css", get(landing_css))
        .route("/shell/landing.js", get(landing_js))
        .route("/shell/app-shell.js", get(app_shell_js))
        .route("/manifest.webmanifest", get(web_manifest))
        .route("/sw.js", get(service_worker))
        .route("/health/live", get(live))
        .route("/health/ready", get(http_api::ready))
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
        .with_state(state)
}

async fn landing() -> Html<&'static str> {
    Html(LANDING_HTML)
}

async fn landing_css() -> Response {
    embedded_asset("text/css; charset=utf-8", LANDING_CSS)
}

async fn landing_js() -> Response {
    embedded_asset("text/javascript; charset=utf-8", LANDING_JS)
}

async fn app_shell_js() -> Response {
    embedded_asset("text/javascript; charset=utf-8", APP_SHELL_JS)
}

async fn web_manifest() -> Response {
    embedded_asset("application/manifest+json; charset=utf-8", WEB_MANIFEST)
}

async fn service_worker() -> Response {
    let mut response = embedded_asset("text/javascript; charset=utf-8", SERVICE_WORKER);
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

fn embedded_asset(content_type: &'static str, body: &'static str) -> Response {
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
        fs::write(path.join("index.html"), "<main>shell fixture</main>")
            .expect("write static fixture");
        path
    }

    #[tokio::test]
    async fn health_and_build_metadata_are_available() {
        let web_root = fixture_dir();
        let state = test_state(&web_root).await;
        let router = app(&web_root, state.clone());

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

        let metadata = router
            .oneshot(
                Request::get("/api/meta")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("metadata response");
        assert_eq!(metadata.status(), StatusCode::OK);

        state.services.storage.close().await;
        fs::remove_dir_all(web_root).expect("remove static fixture directory");
    }

    #[tokio::test]
    async fn root_is_server_rendered_without_loading_the_wasm_app() {
        let web_root = fixture_dir();
        let state = test_state(&web_root).await;
        let response = app(&web_root, state.clone())
            .oneshot(Request::get("/").body(Body::empty()).expect("request"))
            .await
            .expect("landing response");

        assert_eq!(response.status(), StatusCode::OK);
        let body = response
            .into_body()
            .collect()
            .await
            .expect("collect landing body")
            .to_bytes();
        let body = String::from_utf8(body.to_vec()).expect("landing utf-8");
        assert!(body.contains("加入房间"));
        assert!(body.contains("action=\"/app\""));
        assert!(!body.contains(".wasm"));
        assert!(!body.contains("shell fixture"));

        let app_shell = app(&web_root, state.clone())
            .oneshot(Request::get("/app").body(Body::empty()).expect("request"))
            .await
            .expect("application shell response")
            .into_body()
            .collect()
            .await
            .expect("collect application shell")
            .to_bytes();
        assert!(
            app_shell
                .windows(b"shell fixture".len())
                .any(|window| window == b"shell fixture")
        );

        state.services.storage.close().await;
        fs::remove_dir_all(web_root).expect("remove static fixture directory");
    }

    #[tokio::test]
    async fn installable_shell_assets_have_safe_cache_boundaries() {
        let web_root = fixture_dir();
        let state = test_state(&web_root).await;
        let router = app(&web_root, state.clone());

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

        state.services.storage.close().await;
        fs::remove_dir_all(web_root).expect("remove static fixture directory");
    }
}
