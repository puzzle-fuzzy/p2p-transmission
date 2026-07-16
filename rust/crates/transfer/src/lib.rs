#![forbid(unsafe_code)]

pub const DEFAULT_CHUNK_BYTES: usize = 64 * 1024;
pub const DEFAULT_BUFFER_HIGH_BYTES: u64 = 4 * 1024 * 1024;
pub const DEFAULT_BUFFER_LOW_BYTES: u64 = 1024 * 1024;
pub const DEFAULT_STREAM_CHUNK_BYTES: usize = 32 * 1024;
pub const DEFAULT_STREAM_SEGMENT_BYTES: u32 = 8 * 1024 * 1024;
pub const DEFAULT_STREAM_ACK_WINDOW_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TransferPlanError {
    ZeroChunkSize,
    ZeroSegmentSize,
    ZeroWindowSize,
    ProgressRegressed {
        current: u64,
        next: u64,
    },
    ProgressExceeded {
        total: u64,
        next: u64,
    },
    SendRegressed {
        current: u64,
        next: u64,
    },
    SendExceeded {
        total: u64,
        next: u64,
    },
    SendWindowExceeded {
        committed: u64,
        next: u64,
        window: u64,
    },
    CommitRegressed {
        current: u64,
        next: u64,
    },
    CommitBeyondSent {
        sent: u64,
        next: u64,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ChunkDescriptor {
    pub index: u64,
    pub offset: u64,
    pub length: u32,
    pub is_last: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ChunkPlan {
    total_bytes: u64,
    chunk_bytes: u32,
}

impl ChunkPlan {
    pub fn new(total_bytes: u64, chunk_bytes: u32) -> Result<Self, TransferPlanError> {
        if chunk_bytes == 0 {
            return Err(TransferPlanError::ZeroChunkSize);
        }

        Ok(Self {
            total_bytes,
            chunk_bytes,
        })
    }

    pub const fn total_bytes(self) -> u64 {
        self.total_bytes
    }

    pub const fn chunk_bytes(self) -> u32 {
        self.chunk_bytes
    }

    pub const fn chunk_count(self) -> u64 {
        if self.total_bytes == 0 {
            return 0;
        }

        ((self.total_bytes - 1) / self.chunk_bytes as u64) + 1
    }

    pub fn chunk(self, index: u64) -> Option<ChunkDescriptor> {
        if index >= self.chunk_count() {
            return None;
        }

        let offset = index.checked_mul(self.chunk_bytes as u64)?;
        let remaining = self.total_bytes.checked_sub(offset)?;
        let length = remaining.min(self.chunk_bytes as u64) as u32;

        Some(ChunkDescriptor {
            index,
            offset,
            length,
            is_last: index + 1 == self.chunk_count(),
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SegmentDescriptor {
    pub index: u64,
    pub offset: u64,
    pub length: u32,
    pub is_last: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SegmentPlan {
    total_bytes: u64,
    segment_bytes: u32,
}

impl SegmentPlan {
    pub fn new(total_bytes: u64, segment_bytes: u32) -> Result<Self, TransferPlanError> {
        if segment_bytes == 0 {
            return Err(TransferPlanError::ZeroSegmentSize);
        }
        Ok(Self {
            total_bytes,
            segment_bytes,
        })
    }

    pub const fn total_bytes(self) -> u64 {
        self.total_bytes
    }

    pub const fn segment_bytes(self) -> u32 {
        self.segment_bytes
    }

    pub const fn segment_count(self) -> u64 {
        if self.total_bytes == 0 {
            return 0;
        }
        ((self.total_bytes - 1) / self.segment_bytes as u64) + 1
    }

    pub fn segment(self, index: u64) -> Option<SegmentDescriptor> {
        if index >= self.segment_count() {
            return None;
        }
        let offset = index.checked_mul(self.segment_bytes as u64)?;
        let remaining = self.total_bytes.checked_sub(offset)?;
        let length = remaining.min(self.segment_bytes as u64) as u32;
        Some(SegmentDescriptor {
            index,
            offset,
            length,
            is_last: index + 1 == self.segment_count(),
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ProgressCounter {
    total_bytes: u64,
    completed_bytes: u64,
}

impl ProgressCounter {
    pub const fn new(total_bytes: u64) -> Self {
        Self {
            total_bytes,
            completed_bytes: 0,
        }
    }

    pub const fn total_bytes(self) -> u64 {
        self.total_bytes
    }

    pub const fn completed_bytes(self) -> u64 {
        self.completed_bytes
    }

    pub const fn is_complete(self) -> bool {
        self.completed_bytes == self.total_bytes
    }

    pub fn advance_to(&mut self, next: u64) -> Result<bool, TransferPlanError> {
        if next < self.completed_bytes {
            return Err(TransferPlanError::ProgressRegressed {
                current: self.completed_bytes,
                next,
            });
        }
        if next > self.total_bytes {
            return Err(TransferPlanError::ProgressExceeded {
                total: self.total_bytes,
                next,
            });
        }

        let changed = next != self.completed_bytes;
        self.completed_bytes = next;
        Ok(changed)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BackpressurePolicy {
    pub chunk_bytes: usize,
    pub high_watermark_bytes: u64,
    pub low_watermark_bytes: u64,
}

impl Default for BackpressurePolicy {
    fn default() -> Self {
        Self {
            chunk_bytes: DEFAULT_CHUNK_BYTES,
            high_watermark_bytes: DEFAULT_BUFFER_HIGH_BYTES,
            low_watermark_bytes: DEFAULT_BUFFER_LOW_BYTES,
        }
    }
}

impl BackpressurePolicy {
    pub fn should_pause(self, buffered_bytes: u64) -> bool {
        buffered_bytes >= self.high_watermark_bytes
    }

    pub fn can_resume(self, buffered_bytes: u64) -> bool {
        buffered_bytes <= self.low_watermark_bytes
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AckWindow {
    total_bytes: u64,
    sent_bytes: u64,
    committed_bytes: u64,
    window_bytes: u64,
}

impl AckWindow {
    pub fn new(total_bytes: u64, window_bytes: u64) -> Result<Self, TransferPlanError> {
        if window_bytes == 0 {
            return Err(TransferPlanError::ZeroWindowSize);
        }
        Ok(Self {
            total_bytes,
            sent_bytes: 0,
            committed_bytes: 0,
            window_bytes,
        })
    }

    pub const fn total_bytes(self) -> u64 {
        self.total_bytes
    }

    pub const fn sent_bytes(self) -> u64 {
        self.sent_bytes
    }

    pub const fn committed_bytes(self) -> u64 {
        self.committed_bytes
    }

    pub const fn in_flight_bytes(self) -> u64 {
        self.sent_bytes - self.committed_bytes
    }

    pub const fn available_bytes(self) -> u64 {
        self.window_bytes - self.in_flight_bytes()
    }

    pub const fn is_complete(self) -> bool {
        self.committed_bytes == self.total_bytes
    }

    pub fn can_send(self, payload_bytes: u64) -> bool {
        self.sent_bytes
            .checked_add(payload_bytes)
            .is_some_and(|next| {
                next <= self.total_bytes && next - self.committed_bytes <= self.window_bytes
            })
    }

    pub fn advance_sent_to(&mut self, next: u64) -> Result<bool, TransferPlanError> {
        if next < self.sent_bytes {
            return Err(TransferPlanError::SendRegressed {
                current: self.sent_bytes,
                next,
            });
        }
        if next > self.total_bytes {
            return Err(TransferPlanError::SendExceeded {
                total: self.total_bytes,
                next,
            });
        }
        if next - self.committed_bytes > self.window_bytes {
            return Err(TransferPlanError::SendWindowExceeded {
                committed: self.committed_bytes,
                next,
                window: self.window_bytes,
            });
        }
        let changed = next != self.sent_bytes;
        self.sent_bytes = next;
        Ok(changed)
    }

    pub fn commit_to(&mut self, next: u64) -> Result<bool, TransferPlanError> {
        if next < self.committed_bytes {
            return Err(TransferPlanError::CommitRegressed {
                current: self.committed_bytes,
                next,
            });
        }
        if next > self.sent_bytes {
            return Err(TransferPlanError::CommitBeyondSent {
                sent: self.sent_bytes,
                next,
            });
        }
        let changed = next != self.committed_bytes;
        self.committed_bytes = next;
        Ok(changed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn next_random(state: &mut u64) -> u64 {
        *state ^= *state << 13;
        *state ^= *state >> 7;
        *state ^= *state << 17;
        *state
    }

    #[test]
    fn default_policy_has_separate_pause_and_resume_thresholds() {
        let policy = BackpressurePolicy::default();
        assert!(policy.low_watermark_bytes < policy.high_watermark_bytes);
        assert!(policy.should_pause(policy.high_watermark_bytes));
        assert!(policy.can_resume(policy.low_watermark_bytes));
    }

    #[test]
    fn chunk_plan_covers_each_byte_exactly_once() {
        let plan = ChunkPlan::new(131_073, 65_536).expect("valid plan");
        assert_eq!(plan.chunk_count(), 3);
        assert_eq!(plan.chunk(0).expect("first chunk").offset, 0);
        assert_eq!(plan.chunk(1).expect("second chunk").offset, 65_536);
        assert_eq!(plan.chunk(2).expect("last chunk").length, 1);
        assert!(plan.chunk(2).expect("last chunk").is_last);
        assert_eq!(plan.chunk(3), None);
    }

    #[test]
    fn zero_length_plan_has_no_chunks() {
        let plan = ChunkPlan::new(0, 65_536).expect("valid empty plan");
        assert_eq!(plan.chunk_count(), 0);
        assert_eq!(plan.chunk(0), None);
        assert_eq!(ChunkPlan::new(1, 0), Err(TransferPlanError::ZeroChunkSize));
    }

    #[test]
    fn progress_is_monotonic_bounded_and_idempotent() {
        let mut progress = ProgressCounter::new(10);
        assert_eq!(progress.advance_to(4), Ok(true));
        assert_eq!(progress.advance_to(4), Ok(false));
        assert_eq!(
            progress.advance_to(3),
            Err(TransferPlanError::ProgressRegressed {
                current: 4,
                next: 3,
            })
        );
        assert_eq!(
            progress.advance_to(11),
            Err(TransferPlanError::ProgressExceeded {
                total: 10,
                next: 11,
            })
        );
        assert_eq!(progress.advance_to(10), Ok(true));
        assert!(progress.is_complete());
    }

    #[test]
    fn generated_chunk_plans_are_contiguous_and_bounded() {
        for seed in 1..=512_u64 {
            let mut state = seed;
            let total = next_random(&mut state);
            let chunk_bytes = (next_random(&mut state) as u32).max(1);
            let plan = ChunkPlan::new(total, chunk_bytes).expect("generated plan is valid");
            let count = plan.chunk_count();

            if count == 0 {
                assert_eq!(total, 0);
                continue;
            }

            let first = plan.chunk(0).expect("non-empty plan has first chunk");
            let last = plan
                .chunk(count - 1)
                .expect("non-empty plan has final chunk");
            assert_eq!(first.offset, 0);
            assert!(first.length > 0);
            assert!(last.is_last);
            assert_eq!(last.offset + u64::from(last.length), total);

            if count > 1 {
                let before_last = plan.chunk(count - 2).expect("penultimate chunk exists");
                assert_eq!(
                    before_last.offset + u64::from(before_last.length),
                    last.offset
                );
            }
            assert_eq!(plan.chunk(count), None);
        }
    }

    #[test]
    fn five_gib_stream_has_bounded_eight_mib_segments() {
        let five_gib = 5_u64 * 1024 * 1024 * 1024;
        let plan =
            SegmentPlan::new(five_gib, DEFAULT_STREAM_SEGMENT_BYTES).expect("valid segment plan");
        assert_eq!(plan.segment_count(), 640);
        assert_eq!(plan.segment(0).expect("first segment").offset, 0);
        let last = plan.segment(639).expect("last segment");
        assert_eq!(last.length, DEFAULT_STREAM_SEGMENT_BYTES);
        assert!(last.is_last);
        assert_eq!(last.offset + u64::from(last.length), five_gib);
        assert_eq!(plan.segment(640), None);
    }

    #[test]
    fn ack_window_bounds_uncommitted_network_and_disk_data() {
        let mib = 1024_u64 * 1024;
        let mut window = AckWindow::new(32 * mib, 16 * mib).expect("valid ack window");
        assert!(window.can_send(16 * mib));
        assert!(!window.can_send(16 * mib + 1));
        assert_eq!(window.advance_sent_to(16 * mib), Ok(true));
        assert_eq!(window.available_bytes(), 0);
        assert_eq!(
            window.advance_sent_to(16 * mib + 1),
            Err(TransferPlanError::SendWindowExceeded {
                committed: 0,
                next: 16 * mib + 1,
                window: 16 * mib,
            })
        );
        assert_eq!(window.commit_to(8 * mib), Ok(true));
        assert_eq!(window.available_bytes(), 8 * mib);
        assert!(window.can_send(8 * mib));
        assert_eq!(window.advance_sent_to(24 * mib), Ok(true));
        assert_eq!(window.commit_to(24 * mib), Ok(true));
        assert_eq!(window.advance_sent_to(32 * mib), Ok(true));
        assert_eq!(window.commit_to(32 * mib), Ok(true));
        assert!(window.is_complete());
    }

    #[test]
    fn ack_window_rejects_invalid_resume_order() {
        let mut window = AckWindow::new(10, 4).expect("valid ack window");
        assert_eq!(window.advance_sent_to(4), Ok(true));
        assert_eq!(
            window.commit_to(5),
            Err(TransferPlanError::CommitBeyondSent { sent: 4, next: 5 })
        );
        assert_eq!(window.commit_to(2), Ok(true));
        assert_eq!(
            window.commit_to(1),
            Err(TransferPlanError::CommitRegressed {
                current: 2,
                next: 1,
            })
        );
    }
}
