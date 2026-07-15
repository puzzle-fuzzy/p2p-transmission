use std::{collections::HashMap, sync::Arc};

use tokio::sync::Mutex;

const MAX_TRACKED_KEYS: usize = 10_000;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RatePolicy {
    pub max_requests: u32,
    pub window_ms: u64,
}

impl RatePolicy {
    pub const fn new(max_requests: u32, window_ms: u64) -> Self {
        Self {
            max_requests,
            window_ms,
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct RateLimiter {
    entries: Arc<Mutex<HashMap<String, Window>>>,
}

#[derive(Clone, Copy, Debug)]
struct Window {
    count: u32,
    resets_at_ms: u64,
}

impl RateLimiter {
    pub async fn check(
        &self,
        bucket: &'static str,
        key: &str,
        policy: RatePolicy,
        now_ms: u64,
    ) -> bool {
        if policy.max_requests == 0 || policy.window_ms == 0 {
            return false;
        }

        let entry_key = format!("{bucket}:{key}");
        let mut entries = self.entries.lock().await;
        if entries.len() >= MAX_TRACKED_KEYS && !entries.contains_key(&entry_key) {
            entries.retain(|_, window| window.resets_at_ms > now_ms);
            if entries.len() >= MAX_TRACKED_KEYS {
                return false;
            }
        }

        let resets_at_ms = now_ms.saturating_add(policy.window_ms);
        let window = entries.entry(entry_key).or_insert(Window {
            count: 0,
            resets_at_ms,
        });
        if now_ms >= window.resets_at_ms {
            *window = Window {
                count: 0,
                resets_at_ms,
            };
        }
        if window.count >= policy.max_requests {
            return false;
        }
        window.count += 1;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn fixed_windows_are_bounded_and_reset() {
        let limiter = RateLimiter::default();
        let policy = RatePolicy::new(2, 1_000);
        assert!(limiter.check("join", "session_1", policy, 100).await);
        assert!(limiter.check("join", "session_1", policy, 101).await);
        assert!(!limiter.check("join", "session_1", policy, 102).await);
        assert!(limiter.check("join", "session_2", policy, 102).await);
        assert!(limiter.check("join", "session_1", policy, 1_100).await);
    }
}
