use p2p_protocol::ResumeCursor;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct ManifestFile<'a> {
    pub file_id: &'a str,
    pub size_bytes: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct Checkpoint<'a> {
    pub file_id: &'a str,
    pub size_bytes: u64,
    pub committed_bytes: u64,
    pub last_segment_blake3: Option<&'a str>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct PendingCheckpoint<'a> {
    pub file_index: usize,
    pub committed_bytes: u64,
    pub blake3: &'a str,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ResolvedCheckpoint {
    pub committed_bytes: u64,
    pub last_segment_blake3: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ResumeDisposition {
    KeepCurrent,
    PromotePending { file_index: usize },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CheckpointError {
    ZeroSegmentBytes,
    FileCountMismatch,
    FileOrderMismatch,
    InvalidCheckpoint,
    StateMismatch,
}

pub(crate) fn validate_checkpoint_prefix(
    segment_bytes: u32,
    files: &[Checkpoint<'_>],
) -> Result<(), CheckpointError> {
    if segment_bytes == 0 {
        return Err(CheckpointError::ZeroSegmentBytes);
    }

    let mut incomplete_seen = false;
    for file in files {
        let aligned = file.committed_bytes <= file.size_bytes
            && (file.committed_bytes == file.size_bytes
                || file.committed_bytes % u64::from(segment_bytes) == 0);
        let verified = (file.committed_bytes == 0 && file.last_segment_blake3.is_none())
            || (file.committed_bytes > 0 && file.last_segment_blake3.is_some_and(valid_blake3));
        if !aligned || !verified || incomplete_seen && file.committed_bytes > 0 {
            return Err(CheckpointError::InvalidCheckpoint);
        }
        if file.committed_bytes < file.size_bytes {
            incomplete_seen = true;
        }
    }
    Ok(())
}

pub(crate) fn resolve_manifest_resume(
    segment_bytes: u32,
    files: &[ManifestFile<'_>],
    resume: &[ResumeCursor],
) -> Result<Vec<ResolvedCheckpoint>, CheckpointError> {
    if !resume.is_empty() && resume.len() != files.len() {
        return Err(CheckpointError::FileCountMismatch);
    }

    let mut resolved = Vec::with_capacity(files.len());
    for (index, file) in files.iter().enumerate() {
        let cursor = resume.get(index);
        if cursor.is_some_and(|cursor| cursor.file_id != file.file_id) {
            return Err(CheckpointError::FileOrderMismatch);
        }
        resolved.push(ResolvedCheckpoint {
            committed_bytes: cursor.map_or(0, |cursor| cursor.committed_bytes),
            last_segment_blake3: cursor.and_then(|cursor| cursor.last_segment_blake3.clone()),
        });
    }

    let checkpoints = files
        .iter()
        .zip(&resolved)
        .map(|(file, resolved)| Checkpoint {
            file_id: file.file_id,
            size_bytes: file.size_bytes,
            committed_bytes: resolved.committed_bytes,
            last_segment_blake3: resolved.last_segment_blake3.as_deref(),
        })
        .collect::<Vec<_>>();
    validate_checkpoint_prefix(segment_bytes, &checkpoints)?;
    Ok(resolved)
}

pub(crate) fn match_live_resume(
    segment_bytes: u32,
    current: &[Checkpoint<'_>],
    pending: Option<PendingCheckpoint<'_>>,
    resume: &[ResumeCursor],
) -> Result<ResumeDisposition, CheckpointError> {
    if !resume.is_empty() && resume.len() != current.len() {
        return Err(CheckpointError::FileCountMismatch);
    }

    let resolved = current
        .iter()
        .map(|file| {
            let cursor = if resume.is_empty() {
                None
            } else {
                Some(
                    resume
                        .iter()
                        .find(|cursor| cursor.file_id == file.file_id)
                        .ok_or(CheckpointError::StateMismatch)?,
                )
            };
            Ok(ResolvedCheckpoint {
                committed_bytes: cursor.map_or(0, |cursor| cursor.committed_bytes),
                last_segment_blake3: cursor.and_then(|cursor| cursor.last_segment_blake3.clone()),
            })
        })
        .collect::<Result<Vec<_>, CheckpointError>>()?;
    let received = current
        .iter()
        .zip(&resolved)
        .map(|(file, resolved)| Checkpoint {
            file_id: file.file_id,
            size_bytes: file.size_bytes,
            committed_bytes: resolved.committed_bytes,
            last_segment_blake3: resolved.last_segment_blake3.as_deref(),
        })
        .collect::<Vec<_>>();
    validate_checkpoint_prefix(segment_bytes, &received)?;

    let mut promotion = None;
    for (file_index, (file, received)) in current.iter().zip(&resolved).enumerate() {
        let current_matches = received.committed_bytes == file.committed_bytes
            && if received.committed_bytes == 0 {
                received.last_segment_blake3.is_none()
            } else {
                received.last_segment_blake3.as_deref() == file.last_segment_blake3
            };
        let pending_matches = pending.is_some_and(|pending| {
            pending.file_index == file_index
                && pending.committed_bytes == received.committed_bytes
                && Some(pending.blake3) == received.last_segment_blake3.as_deref()
        });
        if !current_matches && !pending_matches {
            return Err(CheckpointError::StateMismatch);
        }
        if pending_matches
            && received.committed_bytes != file.committed_bytes
            && promotion.replace(file_index).is_some()
        {
            return Err(CheckpointError::StateMismatch);
        }
    }

    Ok(
        promotion.map_or(ResumeDisposition::KeepCurrent, |file_index| {
            ResumeDisposition::PromotePending { file_index }
        }),
    )
}

fn valid_blake3(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;

    const HASH_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const HASH_B: &str = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

    fn checkpoint<'a>(
        file_id: &'a str,
        size_bytes: u64,
        committed_bytes: u64,
        last_segment_blake3: Option<&'a str>,
    ) -> Checkpoint<'a> {
        Checkpoint {
            file_id,
            size_bytes,
            committed_bytes,
            last_segment_blake3,
        }
    }

    fn cursor(file_id: &str, committed_bytes: u64, hash: Option<&str>) -> ResumeCursor {
        ResumeCursor {
            file_id: file_id.to_owned(),
            committed_bytes,
            last_segment_blake3: hash.map(str::to_owned),
        }
    }

    #[test]
    fn checkpoint_prefix_accepts_completed_partial_zero_and_empty_files() {
        let files = [
            checkpoint("file_a", 16, 16, Some(HASH_A)),
            checkpoint("file_empty", 0, 0, None),
            checkpoint("file_b", 18, 8, Some(HASH_B)),
            checkpoint("file_c", 8, 0, None),
        ];
        assert_eq!(validate_checkpoint_prefix(8, &files), Ok(()));

        let non_aligned_completion = [checkpoint("file_a", 10, 10, Some(HASH_A))];
        assert_eq!(
            validate_checkpoint_prefix(8, &non_aligned_completion),
            Ok(())
        );
    }

    #[test]
    fn checkpoint_prefix_rejects_invalid_boundaries_and_non_prefix_batches() {
        for files in [
            vec![checkpoint("file_a", 16, 17, Some(HASH_A))],
            vec![checkpoint("file_a", 16, 7, Some(HASH_A))],
            vec![
                checkpoint("file_a", 16, 8, Some(HASH_A)),
                checkpoint("file_b", 8, 8, Some(HASH_B)),
            ],
        ] {
            assert_eq!(
                validate_checkpoint_prefix(8, &files),
                Err(CheckpointError::InvalidCheckpoint)
            );
        }
        assert_eq!(
            validate_checkpoint_prefix(0, &[checkpoint("file_a", 8, 0, None)]),
            Err(CheckpointError::ZeroSegmentBytes)
        );
    }

    #[test]
    fn checkpoint_prefix_rejects_unverified_hash_states() {
        for files in [
            vec![checkpoint("file_a", 8, 0, Some(HASH_A))],
            vec![checkpoint("file_a", 8, 8, None)],
            vec![checkpoint("file_a", 8, 8, Some("not-a-blake3-hash"))],
        ] {
            assert_eq!(
                validate_checkpoint_prefix(8, &files),
                Err(CheckpointError::InvalidCheckpoint)
            );
        }
    }

    #[test]
    fn manifest_resume_is_strictly_ordered_and_empty_resume_means_zero() {
        let files = [
            ManifestFile {
                file_id: "file_a",
                size_bytes: 16,
            },
            ManifestFile {
                file_id: "file_b",
                size_bytes: 8,
            },
        ];
        assert_eq!(
            resolve_manifest_resume(8, &files, &[]),
            Ok(vec![
                ResolvedCheckpoint {
                    committed_bytes: 0,
                    last_segment_blake3: None,
                },
                ResolvedCheckpoint {
                    committed_bytes: 0,
                    last_segment_blake3: None,
                },
            ])
        );
        assert_eq!(
            resolve_manifest_resume(
                8,
                &files,
                &[cursor("file_b", 0, None), cursor("file_a", 0, None),],
            ),
            Err(CheckpointError::FileOrderMismatch)
        );
        assert_eq!(
            resolve_manifest_resume(8, &files, &[cursor("file_a", 0, None)]),
            Err(CheckpointError::FileCountMismatch)
        );
    }

    #[test]
    fn live_resume_matches_by_id_without_requiring_manifest_order() {
        let current = [
            checkpoint("file_a", 8, 8, Some(HASH_A)),
            checkpoint("file_b", 8, 0, None),
        ];
        let resume = [cursor("file_b", 0, None), cursor("file_a", 8, Some(HASH_A))];
        assert_eq!(
            match_live_resume(8, &current, None, &resume),
            Ok(ResumeDisposition::KeepCurrent)
        );
    }

    #[test]
    fn live_resume_can_promote_the_single_pending_checkpoint() {
        let current = [
            checkpoint("file_a", 16, 0, None),
            checkpoint("file_b", 8, 0, None),
        ];
        let resume = [cursor("file_a", 8, Some(HASH_A)), cursor("file_b", 0, None)];
        let pending = PendingCheckpoint {
            file_index: 0,
            committed_bytes: 8,
            blake3: HASH_A,
        };
        assert_eq!(
            match_live_resume(8, &current, Some(pending), &resume),
            Ok(ResumeDisposition::PromotePending { file_index: 0 })
        );
    }

    #[test]
    fn live_resume_rejects_unknown_or_unverified_state() {
        let current = [checkpoint("file_a", 16, 0, None)];
        assert_eq!(
            match_live_resume(8, &current, None, &[cursor("file_b", 0, None)]),
            Err(CheckpointError::StateMismatch)
        );
        assert_eq!(
            match_live_resume(8, &current, None, &[cursor("file_a", 8, Some(HASH_A))],),
            Err(CheckpointError::StateMismatch)
        );
        assert_eq!(
            match_live_resume(0, &current, None, &[]),
            Err(CheckpointError::ZeroSegmentBytes)
        );
    }
}
