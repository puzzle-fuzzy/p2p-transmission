use std::{net::SocketAddr, path::PathBuf};

use anyhow::{Context, Result};
use p2p_server::{
    app, config::AppConfig, default_web_root, http_api::AppState, services::AppServices,
    storage::Storage,
};
use tracing::{info, warn};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "p2p_server=info,tower_http=info".into()),
        )
        .compact()
        .init();

    let address = std::env::var("P2P_ADDR")
        .unwrap_or_else(|_| "127.0.0.1:3410".to_owned())
        .parse::<SocketAddr>()
        .context("P2P_ADDR must be a valid socket address")?;
    let web_root = std::env::var_os("P2P_WEB_DIST")
        .map(PathBuf::from)
        .unwrap_or_else(default_web_root);
    let config = AppConfig::from_env().context("load Rust 2.0 server configuration")?;
    let storage = Storage::connect(&config.database_path)
        .await
        .context("initialize Rust 2.0 SQLite database")?;
    let state = AppState::new(AppServices::new(storage.clone(), config));
    let maintenance = tokio::spawn(p2p_server::maintenance::run(state.clone()));

    if !web_root.join("index.html").is_file() {
        warn!(path = %web_root.display(), "Dioxus web build is missing; application routes will return 404");
    }

    let listener = tokio::net::TcpListener::bind(address)
        .await
        .with_context(|| format!("bind Rust 2.0 server to {address}"))?;
    info!(
        address = %listener.local_addr()?,
        web_root = %web_root.display(),
        "P2P Transmission 2.0 listening"
    );

    axum::serve(
        listener,
        app(web_root, state).into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await
    .context("serve P2P Transmission 2.0")?;
    maintenance.abort();
    let _ = maintenance.await;
    storage.close().await;
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        if let Err(error) = tokio::signal::ctrl_c().await {
            warn!(%error, "failed to listen for Ctrl+C");
        }
    };

    #[cfg(unix)]
    {
        let terminate = async {
            match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
                Ok(mut signal) => {
                    signal.recv().await;
                }
                Err(error) => warn!(%error, "failed to listen for SIGTERM"),
            }
        };
        tokio::select! {
            _ = ctrl_c => {}
            _ = terminate => {}
        }
    }

    #[cfg(not(unix))]
    {
        ctrl_c.await;
    }
}
