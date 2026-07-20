#![forbid(unsafe_code)]

// Keep the complete DataChannel message comfortably below the conservative
// 64 KiB interoperability boundary after the binary protocol header is added.
pub const DEFAULT_CHUNK_BYTES: usize = 32 * 1024;
pub const DEFAULT_BUFFER_HIGH_BYTES: u64 = 4 * 1024 * 1024;
pub const DEFAULT_BUFFER_LOW_BYTES: u64 = 1024 * 1024;
pub const DEFAULT_STREAM_CHUNK_BYTES: usize = 32 * 1024;
pub const DEFAULT_STREAM_SEGMENT_BYTES: u32 = 8 * 1024 * 1024;
pub const DEFAULT_STREAM_ACK_WINDOW_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TransferDirection {
    Send,
    Receive,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TransferFile {
    pub name: String,
    pub mime: Option<String>,
    pub size_bytes: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TransferPlanError {
    ZeroChunkSize,
    ZeroSegmentSize,
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
}
