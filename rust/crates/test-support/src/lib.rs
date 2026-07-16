#![forbid(unsafe_code)]

use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Debug)]
pub struct SequenceIds {
    prefix: &'static str,
    next: AtomicU64,
}

impl SequenceIds {
    pub const fn new(prefix: &'static str) -> Self {
        Self {
            prefix,
            next: AtomicU64::new(1),
        }
    }

    pub fn next(&self) -> String {
        let value = self.next.fetch_add(1, Ordering::Relaxed);
        format!("{}_{value}", self.prefix)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sequence_ids_are_deterministic() {
        let ids = SequenceIds::new("peer");
        assert_eq!(ids.next(), "peer_1");
        assert_eq!(ids.next(), "peer_2");
    }
}
