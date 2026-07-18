use std::{
    fmt::Write,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Instant,
};

use axum::{
    Extension,
    extract::{Request, State},
    http::{HeaderValue, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
};

const PROMETHEUS_CONTENT_TYPE: &str = "text/plain; version=0.0.4; charset=utf-8";

/// Process-local counters for the small, single-instance server deployment.
///
/// The counters intentionally avoid labels so user-controlled values can never
/// create unbounded metric cardinality.
#[derive(Clone, Debug)]
pub struct Observability {
    inner: Arc<Counters>,
}

#[derive(Debug)]
struct Counters {
    started_at: Instant,
    http_requests: AtomicU64,
    http_server_errors: AtomicU64,
    http_rate_limited: AtomicU64,
    websocket_connections: AtomicU64,
    websocket_disconnects: AtomicU64,
    realtime_signal_rate_limited: AtomicU64,
}

impl Default for Observability {
    fn default() -> Self {
        Self::new()
    }
}

impl Observability {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Counters {
                started_at: Instant::now(),
                http_requests: AtomicU64::new(0),
                http_server_errors: AtomicU64::new(0),
                http_rate_limited: AtomicU64::new(0),
                websocket_connections: AtomicU64::new(0),
                websocket_disconnects: AtomicU64::new(0),
                realtime_signal_rate_limited: AtomicU64::new(0),
            }),
        }
    }

    fn record_http_response(&self, status: StatusCode) {
        self.inner.http_requests.fetch_add(1, Ordering::Relaxed);
        if status.is_server_error() {
            self.inner
                .http_server_errors
                .fetch_add(1, Ordering::Relaxed);
        }
        if status == StatusCode::TOO_MANY_REQUESTS {
            self.inner.http_rate_limited.fetch_add(1, Ordering::Relaxed);
        }
    }

    pub(crate) fn websocket_connection(&self) -> WebSocketConnectionGuard {
        self.inner
            .websocket_connections
            .fetch_add(1, Ordering::Relaxed);
        WebSocketConnectionGuard {
            observability: self.clone(),
        }
    }

    pub(crate) fn record_realtime_signal_rate_limited(&self) {
        self.inner
            .realtime_signal_rate_limited
            .fetch_add(1, Ordering::Relaxed);
    }

    fn render(&self) -> String {
        let snapshot = self.snapshot();
        let mut output = String::with_capacity(1_024);
        write_metric(
            &mut output,
            "p2p_http_requests_total",
            "Total HTTP requests completed by the Axum server.",
            "counter",
            snapshot.http_requests,
        );
        write_metric(
            &mut output,
            "p2p_http_responses_5xx_total",
            "Total HTTP responses with a 5xx status.",
            "counter",
            snapshot.http_server_errors,
        );
        write_metric(
            &mut output,
            "p2p_http_responses_429_total",
            "Total HTTP responses with a 429 status.",
            "counter",
            snapshot.http_rate_limited,
        );
        write_metric(
            &mut output,
            "p2p_websocket_connections_active",
            "Current accepted realtime WebSocket connections.",
            "gauge",
            snapshot.websocket_connections,
        );
        write_metric(
            &mut output,
            "p2p_websocket_disconnects_total",
            "Total accepted realtime WebSocket connections that disconnected.",
            "counter",
            snapshot.websocket_disconnects,
        );
        write_metric(
            &mut output,
            "p2p_realtime_signal_rate_limited_total",
            "Total realtime signaling messages rejected by rate limiting.",
            "counter",
            snapshot.realtime_signal_rate_limited,
        );
        write_metric(
            &mut output,
            "p2p_process_uptime_seconds",
            "Process uptime in whole seconds since application state initialization.",
            "gauge",
            snapshot.uptime_seconds,
        );
        output
    }

    fn snapshot(&self) -> MetricsSnapshot {
        MetricsSnapshot {
            http_requests: self.inner.http_requests.load(Ordering::Relaxed),
            http_server_errors: self.inner.http_server_errors.load(Ordering::Relaxed),
            http_rate_limited: self.inner.http_rate_limited.load(Ordering::Relaxed),
            websocket_connections: self.inner.websocket_connections.load(Ordering::Relaxed),
            websocket_disconnects: self.inner.websocket_disconnects.load(Ordering::Relaxed),
            realtime_signal_rate_limited: self
                .inner
                .realtime_signal_rate_limited
                .load(Ordering::Relaxed),
            uptime_seconds: self.inner.started_at.elapsed().as_secs(),
        }
    }
}

pub(crate) struct WebSocketConnectionGuard {
    observability: Observability,
}

impl Drop for WebSocketConnectionGuard {
    fn drop(&mut self) {
        let previous = self
            .observability
            .inner
            .websocket_connections
            .fetch_sub(1, Ordering::Relaxed);
        debug_assert!(previous > 0, "WebSocket connection gauge underflow");
        self.observability
            .inner
            .websocket_disconnects
            .fetch_add(1, Ordering::Relaxed);
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct MetricsSnapshot {
    http_requests: u64,
    http_server_errors: u64,
    http_rate_limited: u64,
    websocket_connections: u64,
    websocket_disconnects: u64,
    realtime_signal_rate_limited: u64,
    uptime_seconds: u64,
}

fn write_metric(output: &mut String, name: &str, help: &str, kind: &str, value: u64) {
    writeln!(output, "# HELP {name} {help}").expect("writing to a String cannot fail");
    writeln!(output, "# TYPE {name} {kind}").expect("writing to a String cannot fail");
    writeln!(output, "{name} {value}").expect("writing to a String cannot fail");
}

pub async fn track_http(
    State(observability): State<Observability>,
    request: Request,
    next: Next,
) -> Response {
    let response = next.run(request).await;
    observability.record_http_response(response.status());
    response
}

pub async fn metrics(Extension(observability): Extension<Observability>) -> Response {
    (
        [
            (
                header::CONTENT_TYPE,
                HeaderValue::from_static(PROMETHEUS_CONTENT_TYPE),
            ),
            (header::CACHE_CONTROL, HeaderValue::from_static("no-store")),
        ],
        observability.render(),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use axum::{Router, body::Body, http::Request, middleware, routing::get};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    use super::*;

    async fn no_content() -> StatusCode {
        StatusCode::NO_CONTENT
    }

    async fn server_error() -> StatusCode {
        StatusCode::SERVICE_UNAVAILABLE
    }

    async fn rate_limited() -> StatusCode {
        StatusCode::TOO_MANY_REQUESTS
    }

    #[test]
    fn metric_text_reports_websocket_and_signaling_counters() {
        let observability = Observability::new();
        let connection = observability.websocket_connection();
        observability.record_realtime_signal_rate_limited();

        let active = observability.render();
        assert!(active.contains("p2p_websocket_connections_active 1\n"));
        assert!(active.contains("p2p_websocket_disconnects_total 0\n"));
        assert!(active.contains("p2p_realtime_signal_rate_limited_total 1\n"));
        assert!(active.contains("p2p_process_uptime_seconds "));

        drop(connection);
        let disconnected = observability.render();
        assert!(disconnected.contains("p2p_websocket_connections_active 0\n"));
        assert!(disconnected.contains("p2p_websocket_disconnects_total 1\n"));
    }

    #[tokio::test]
    async fn http_middleware_counts_requests_and_relevant_statuses() {
        let observability = Observability::new();
        let router = Router::new()
            .route("/ok", get(no_content))
            .route("/error", get(server_error))
            .route("/limited", get(rate_limited))
            .layer(middleware::from_fn_with_state(
                observability.clone(),
                track_http,
            ));

        for (path, expected_status) in [
            ("/ok", StatusCode::NO_CONTENT),
            ("/error", StatusCode::SERVICE_UNAVAILABLE),
            ("/limited", StatusCode::TOO_MANY_REQUESTS),
        ] {
            let response = router
                .clone()
                .oneshot(Request::get(path).body(Body::empty()).expect("request"))
                .await
                .expect("response");
            assert_eq!(response.status(), expected_status);
        }

        let snapshot = observability.snapshot();
        assert_eq!(snapshot.http_requests, 3);
        assert_eq!(snapshot.http_server_errors, 1);
        assert_eq!(snapshot.http_rate_limited, 1);
        assert_eq!(snapshot.websocket_connections, 0);
        assert_eq!(snapshot.websocket_disconnects, 0);
        assert_eq!(snapshot.realtime_signal_rate_limited, 0);
    }

    #[tokio::test]
    async fn metrics_endpoint_uses_prometheus_content_type_and_disables_caching() {
        let observability = Observability::new();
        let router = Router::new()
            .route("/internal/metrics", get(metrics))
            .layer(Extension(observability));
        let response = router
            .oneshot(
                Request::get("/internal/metrics")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(
            response.headers()[header::CONTENT_TYPE],
            HeaderValue::from_static(PROMETHEUS_CONTENT_TYPE)
        );
        assert_eq!(
            response.headers()[header::CACHE_CONTROL],
            HeaderValue::from_static("no-store")
        );
        let body = response
            .into_body()
            .collect()
            .await
            .expect("collect metrics")
            .to_bytes();
        let body = String::from_utf8(body.to_vec()).expect("metrics UTF-8");
        assert!(body.contains("# TYPE p2p_http_requests_total counter"));
        assert!(body.contains("p2p_process_uptime_seconds"));
    }
}
