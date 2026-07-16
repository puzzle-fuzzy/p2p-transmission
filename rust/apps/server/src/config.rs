use std::{collections::HashSet, fmt, path::PathBuf};

use p2p_domain::DurationMillis;
use p2p_protocol::IceServer;
use thiserror::Error;

use crate::rate_limit::RatePolicy;

const MINUTE_MS: u64 = 60_000;
const HOUR_MS: u64 = 60 * MINUTE_MS;

#[derive(Clone, Debug)]
pub struct AppConfig {
    pub database_path: PathBuf,
    pub allowed_origins: HashSet<String>,
    pub secure_cookies: bool,
    pub session_ttl: DurationMillis,
    pub room_ttl: DurationMillis,
    pub join_request_ttl: DurationMillis,
    pub invite_ttl: DurationMillis,
    pub rtc_config_ttl: DurationMillis,
    pub outbound_queue_capacity: usize,
    pub ice_servers: Vec<IceServer>,
    pub capability_secret: SecretBytes,
    pub turn: Option<TurnConfig>,
    pub session_rate: RatePolicy,
    pub room_rate: RatePolicy,
    pub join_rate: RatePolicy,
    pub signal_rate: RatePolicy,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            database_path: PathBuf::from("data/p2p.sqlite3"),
            allowed_origins: HashSet::from([
                "http://127.0.0.1:3410".to_owned(),
                "http://localhost:3410".to_owned(),
            ]),
            secure_cookies: false,
            session_ttl: DurationMillis::new(24 * HOUR_MS),
            room_ttl: DurationMillis::new(6 * HOUR_MS),
            join_request_ttl: DurationMillis::new(10 * MINUTE_MS),
            invite_ttl: DurationMillis::new(HOUR_MS),
            rtc_config_ttl: DurationMillis::new(10 * MINUTE_MS),
            outbound_queue_capacity: 64,
            ice_servers: vec![IceServer {
                urls: vec!["stun:stun.l.google.com:19302".to_owned()],
                username: None,
                credential: None,
            }],
            capability_secret: SecretBytes::new(
                b"p2p-local-development-capability-secret".to_vec(),
            ),
            turn: None,
            session_rate: RatePolicy::new(20, MINUTE_MS),
            room_rate: RatePolicy::new(30, MINUTE_MS),
            join_rate: RatePolicy::new(30, MINUTE_MS),
            signal_rate: RatePolicy::new(240, MINUTE_MS),
        }
    }
}

impl AppConfig {
    pub fn from_env() -> Result<Self, ConfigError> {
        let mut config = Self::default();
        let mut capability_secret_from_env = false;
        if let Some(path) = std::env::var_os("P2P_DATABASE_PATH") {
            config.database_path = PathBuf::from(path);
        }
        if let Ok(value) = std::env::var("P2P_ALLOWED_ORIGINS") {
            config.allowed_origins = parse_origins(&value)?;
        }
        if let Ok(value) = std::env::var("P2P_SECURE_COOKIES") {
            config.secure_cookies = parse_bool("P2P_SECURE_COOKIES", &value)?;
        }
        if let Ok(value) = std::env::var("P2P_CAPABILITY_SECRET") {
            if value.len() < 32 {
                return Err(ConfigError::SecretTooShort("P2P_CAPABILITY_SECRET"));
            }
            config.capability_secret = SecretBytes::new(value.into_bytes());
            capability_secret_from_env = true;
        }
        if let Ok(value) = std::env::var("P2P_ICE_URLS") {
            let urls = value
                .split(',')
                .map(str::trim)
                .filter(|url| !url.is_empty())
                .map(str::to_owned)
                .collect::<Vec<_>>();
            if urls.is_empty() {
                return Err(ConfigError::EmptyIceServers);
            }
            config.ice_servers = vec![IceServer {
                urls,
                username: None,
                credential: None,
            }];
        }
        if let Ok(value) = std::env::var("P2P_SESSION_RATE_MAX") {
            config.session_rate.max_requests = parse_positive_u32("P2P_SESSION_RATE_MAX", &value)?;
        }
        if let Ok(value) = std::env::var("P2P_ROOM_RATE_MAX") {
            config.room_rate.max_requests = parse_positive_u32("P2P_ROOM_RATE_MAX", &value)?;
        }
        if let Ok(value) = std::env::var("P2P_JOIN_RATE_MAX") {
            config.join_rate.max_requests = parse_positive_u32("P2P_JOIN_RATE_MAX", &value)?;
        }
        if let Ok(value) = std::env::var("P2P_SIGNAL_RATE_MAX") {
            config.signal_rate.max_requests = parse_positive_u32("P2P_SIGNAL_RATE_MAX", &value)?;
        }
        match (
            std::env::var("P2P_TURN_URLS").ok(),
            std::env::var("P2P_TURN_SECRET").ok(),
        ) {
            (Some(urls), Some(secret)) => {
                let urls = parse_urls("P2P_TURN_URLS", &urls)?;
                if secret.len() < 16 {
                    return Err(ConfigError::SecretTooShort("P2P_TURN_SECRET"));
                }
                config.turn = Some(TurnConfig {
                    urls,
                    secret: SecretBytes::new(secret.into_bytes()),
                    ttl: config.rtc_config_ttl,
                });
            }
            (None, None) => {}
            _ => return Err(ConfigError::IncompleteTurnConfiguration),
        }
        config.validate_security(capability_secret_from_env)?;
        Ok(config)
    }

    pub fn allows_origin(&self, origin: &str) -> bool {
        self.allowed_origins.contains(origin)
    }

    pub fn allows_authority(&self, authority: &str) -> bool {
        self.allowed_origins.iter().any(|origin| {
            origin
                .split_once("://")
                .is_some_and(|(_, allowed)| allowed.eq_ignore_ascii_case(authority))
        })
    }

    fn validate_security(&self, capability_secret_from_env: bool) -> Result<(), ConfigError> {
        let https_only = self
            .allowed_origins
            .iter()
            .all(|origin| origin.starts_with("https://"));
        if https_only {
            if !self.secure_cookies {
                return Err(ConfigError::SecureCookiesRequired);
            }
            if !capability_secret_from_env {
                return Err(ConfigError::CapabilitySecretRequired);
            }
        }
        Ok(())
    }
}

#[derive(Clone)]
pub struct SecretBytes(Vec<u8>);

impl SecretBytes {
    pub fn new(value: Vec<u8>) -> Self {
        Self(value)
    }

    pub fn as_bytes(&self) -> &[u8] {
        &self.0
    }
}

impl fmt::Debug for SecretBytes {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SecretBytes([REDACTED])")
    }
}

#[derive(Clone, Debug)]
pub struct TurnConfig {
    pub urls: Vec<String>,
    pub secret: SecretBytes,
    pub ttl: DurationMillis,
}

fn parse_origins(value: &str) -> Result<HashSet<String>, ConfigError> {
    let mut origins = HashSet::new();
    for origin in value
        .split(',')
        .map(str::trim)
        .filter(|item| !item.is_empty())
    {
        let Some((scheme, authority)) = origin.split_once("://") else {
            return Err(ConfigError::InvalidOrigin(origin.to_owned()));
        };
        if !matches!(scheme, "http" | "https") || authority.is_empty() || authority.contains('/') {
            return Err(ConfigError::InvalidOrigin(origin.to_owned()));
        }
        origins.insert(origin.to_owned());
    }
    if origins.is_empty() {
        return Err(ConfigError::EmptyOrigins);
    }
    Ok(origins)
}

fn parse_bool(name: &'static str, value: &str) -> Result<bool, ConfigError> {
    match value {
        "1" | "true" | "TRUE" => Ok(true),
        "0" | "false" | "FALSE" => Ok(false),
        _ => Err(ConfigError::InvalidBoolean {
            name,
            value: value.to_owned(),
        }),
    }
}

fn parse_positive_u32(name: &'static str, value: &str) -> Result<u32, ConfigError> {
    value
        .parse::<u32>()
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(|| ConfigError::InvalidPositiveInteger {
            name,
            value: value.to_owned(),
        })
}

fn parse_urls(name: &'static str, value: &str) -> Result<Vec<String>, ConfigError> {
    let urls = value
        .split(',')
        .map(str::trim)
        .filter(|url| !url.is_empty())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    if urls.is_empty() {
        return Err(ConfigError::EmptyUrlList(name));
    }
    Ok(urls)
}

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("P2P_ALLOWED_ORIGINS must contain at least one origin")]
    EmptyOrigins,
    #[error("invalid origin {0:?}; expected scheme://authority")]
    InvalidOrigin(String),
    #[error("{name} contains invalid boolean {value:?}")]
    InvalidBoolean { name: &'static str, value: String },
    #[error("{name} must be a positive integer, got {value:?}")]
    InvalidPositiveInteger { name: &'static str, value: String },
    #[error("P2P_ICE_URLS must contain at least one URL")]
    EmptyIceServers,
    #[error("P2P_SECURE_COOKIES must be enabled when every allowed origin uses HTTPS")]
    SecureCookiesRequired,
    #[error("P2P_CAPABILITY_SECRET must be set when every allowed origin uses HTTPS")]
    CapabilitySecretRequired,
    #[error("{0} must contain at least the required number of secret bytes")]
    SecretTooShort(&'static str),
    #[error("P2P_TURN_URLS and P2P_TURN_SECRET must be configured together")]
    IncompleteTurnConfiguration,
    #[error("{0} must contain at least one URL")]
    EmptyUrlList(&'static str),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origins_must_be_exact_http_origins() {
        assert!(parse_origins("https://send.example.com,http://localhost:3410").is_ok());
        assert!(parse_origins("https://send.example.com/path").is_err());
        assert!(parse_origins("").is_err());
        let insecure_production = AppConfig {
            allowed_origins: HashSet::from(["https://send.example.com".to_owned()]),
            secure_cookies: false,
            ..AppConfig::default()
        };
        assert!(matches!(
            insecure_production.validate_security(false),
            Err(ConfigError::SecureCookiesRequired)
        ));
    }

    #[test]
    fn rate_limit_overrides_require_positive_integers() {
        assert_eq!(
            parse_positive_u32("TEST_RATE", "200").expect("positive rate parses"),
            200
        );
        assert!(parse_positive_u32("TEST_RATE", "0").is_err());
        assert!(parse_positive_u32("TEST_RATE", "many").is_err());
    }
}
