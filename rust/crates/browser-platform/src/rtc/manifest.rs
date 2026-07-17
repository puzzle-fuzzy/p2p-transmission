use blake3::Hasher;
use p2p_protocol::{
    FileDigest, FileManifest, MAX_BUFFERED_TRANSFER_BYTES, MAX_FILES_PER_MANIFEST,
    MAX_TRANSFER_BYTES, TransferMode,
};
use p2p_transfer::DEFAULT_STREAM_SEGMENT_BYTES;

use super::TransferFile;

#[derive(Clone)]
pub(super) struct IncomingFile {
    pub(super) file_bytes: [u8; 16],
    pub(super) file: TransferFile,
}

#[derive(Clone)]
pub(super) struct IncomingOffer {
    pub(super) transfer_id: String,
    pub(super) transfer_bytes: [u8; 16],
    pub(super) mode: TransferMode,
    pub(super) files: Vec<IncomingFile>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum IncomingManifestError {
    InvalidTransferId,
    InvalidFileId,
    BufferedBatchUnsupported,
}

impl IncomingOffer {
    pub(super) fn from_manifest(
        transfer_id: String,
        mode: TransferMode,
        files: Vec<FileManifest>,
    ) -> Result<Self, IncomingManifestError> {
        let transfer_bytes = parse_binary_id(&transfer_id, "transfer")
            .ok_or(IncomingManifestError::InvalidTransferId)?;
        let files = files
            .into_iter()
            .map(|file| {
                let file_bytes = parse_binary_id(&file.file_id, "file")
                    .ok_or(IncomingManifestError::InvalidFileId)?;
                Ok(IncomingFile {
                    file_bytes,
                    file: TransferFile {
                        name: file.name,
                        mime: file.mime,
                        size_bytes: file.size_bytes,
                    },
                })
            })
            .collect::<Result<Vec<_>, IncomingManifestError>>()?;
        if mode == TransferMode::Buffered && files.len() != 1 {
            return Err(IncomingManifestError::BufferedBatchUnsupported);
        }
        Ok(Self {
            transfer_id,
            transfer_bytes,
            mode,
            files,
        })
    }

    pub(super) fn transfer_files(&self) -> Vec<TransferFile> {
        self.files.iter().map(|file| file.file.clone()).collect()
    }

    pub(super) fn total_bytes(&self) -> u64 {
        self.files.iter().map(|file| file.file.size_bytes).sum()
    }

    pub(super) fn matches(&self, other: &Self) -> bool {
        self.transfer_id == other.transfer_id
            && self.transfer_bytes == other.transfer_bytes
            && self.mode == other.mode
            && self.files.len() == other.files.len()
            && self
                .files
                .iter()
                .zip(&other.files)
                .all(|(left, right)| left.file_bytes == right.file_bytes && left.file == right.file)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct TransferPlan {
    pub(super) total_bytes: u64,
    pub(super) mode: TransferMode,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum TransferPlanError {
    InvalidFileCount,
    SizeOverflow,
    TransferTooLarge,
}

pub(super) fn plan_transfer(files: &[TransferFile]) -> Result<TransferPlan, TransferPlanError> {
    if files.is_empty() || files.len() > MAX_FILES_PER_MANIFEST {
        return Err(TransferPlanError::InvalidFileCount);
    }
    let total_bytes = files.iter().try_fold(0_u64, |total, file| {
        total
            .checked_add(file.size_bytes)
            .ok_or(TransferPlanError::SizeOverflow)
    })?;
    if total_bytes > MAX_TRANSFER_BYTES {
        return Err(TransferPlanError::TransferTooLarge);
    }
    let mode = if files.len() == 1 && total_bytes <= MAX_BUFFERED_TRANSFER_BYTES {
        TransferMode::Buffered
    } else {
        TransferMode::Streamed {
            segment_bytes: DEFAULT_STREAM_SEGMENT_BYTES,
        }
    };
    Ok(TransferPlan { total_bytes, mode })
}

pub(super) fn format_binary_id(prefix: &str, bytes: &[u8; 16]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";

    let mut result = String::with_capacity(prefix.len() + 33);
    result.push_str(prefix);
    result.push('_');
    for byte in bytes {
        result.push(char::from(HEX[(byte >> 4) as usize]));
        result.push(char::from(HEX[(byte & 0x0f) as usize]));
    }
    result
}

pub(super) fn parse_binary_id(value: &str, prefix: &str) -> Option<[u8; 16]> {
    let hex = value.strip_prefix(&format!("{prefix}_"))?;
    if hex.len() != 32 {
        return None;
    }
    let mut bytes = [0_u8; 16];
    for (index, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[index * 2..index * 2 + 2], 16).ok()?;
    }
    Some(bytes)
}

pub(super) fn summarize_transfer_files(files: &[TransferFile]) -> TransferFile {
    if let [file] = files {
        return file.clone();
    }
    TransferFile {
        name: format!("{} 个文件", files.len()),
        mime: None,
        size_bytes: files.iter().map(|file| file.size_bytes).sum(),
    }
}

pub(super) fn batch_blake3(files: &[FileDigest]) -> String {
    if let [file] = files {
        return file.blake3.clone();
    }
    let mut hasher = Hasher::new();
    for file in files {
        hasher.update(file.file_id.as_bytes());
        hasher.update(&file.size_bytes.to_be_bytes());
        hasher.update(file.blake3.as_bytes());
    }
    hasher.finalize().to_hex().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(name: &str, size_bytes: u64) -> TransferFile {
        TransferFile {
            name: name.to_owned(),
            mime: None,
            size_bytes,
        }
    }

    fn manifest(file_id: &str, name: &str, size_bytes: u64) -> FileManifest {
        FileManifest {
            file_id: file_id.to_owned(),
            name: name.to_owned(),
            mime: None,
            size_bytes,
        }
    }

    #[test]
    fn binary_ids_round_trip_and_preserve_uppercase_compatibility() {
        let bytes = [
            0x0a, 0xbc, 0xde, 0xf0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
        ];
        let id = format_binary_id("file", &bytes);
        assert_eq!(id, "file_0abcdef00102030405060708090a0b0c");
        assert_eq!(parse_binary_id(&id, "file"), Some(bytes));
        assert_eq!(
            parse_binary_id("file_0ABCDEF00102030405060708090A0B0C", "file"),
            Some(bytes)
        );
        assert_eq!(parse_binary_id(&id, "transfer"), None);
        assert_eq!(parse_binary_id("file_01", "file"), None);
    }

    #[test]
    fn incoming_manifest_parses_protocol_ids_and_metadata() {
        let offer = IncomingOffer::from_manifest(
            "transfer_000102030405060708090a0b0c0d0e0f".to_owned(),
            TransferMode::Buffered,
            vec![manifest(
                "file_0f0e0d0c0b0a09080706050403020100",
                "payload.bin",
                42,
            )],
        )
        .expect("manifest should parse");

        assert_eq!(offer.transfer_bytes[0], 0);
        assert_eq!(offer.files[0].file_bytes[0], 15);
        assert_eq!(offer.transfer_files(), vec![file("payload.bin", 42)]);
        assert_eq!(offer.total_bytes(), 42);
    }

    #[test]
    fn incoming_manifest_errors_keep_protocol_categories_distinct() {
        assert!(matches!(
            IncomingOffer::from_manifest(
                "invalid".to_owned(),
                TransferMode::Buffered,
                vec![manifest("file_0f0e0d0c0b0a09080706050403020100", "a", 1,)],
            ),
            Err(IncomingManifestError::InvalidTransferId)
        ));
        assert!(matches!(
            IncomingOffer::from_manifest(
                "transfer_000102030405060708090a0b0c0d0e0f".to_owned(),
                TransferMode::Buffered,
                vec![manifest("invalid", "a", 1)],
            ),
            Err(IncomingManifestError::InvalidFileId)
        ));
        assert!(matches!(
            IncomingOffer::from_manifest(
                "transfer_000102030405060708090a0b0c0d0e0f".to_owned(),
                TransferMode::Buffered,
                vec![
                    manifest("file_000102030405060708090a0b0c0d0e0f", "a", 1),
                    manifest("file_0f0e0d0c0b0a09080706050403020100", "b", 1),
                ],
            ),
            Err(IncomingManifestError::BufferedBatchUnsupported)
        ));
    }

    #[test]
    fn incoming_offer_identity_includes_order_and_metadata() {
        let left = IncomingOffer::from_manifest(
            "transfer_000102030405060708090a0b0c0d0e0f".to_owned(),
            TransferMode::Streamed {
                segment_bytes: DEFAULT_STREAM_SEGMENT_BYTES,
            },
            vec![manifest("file_0f0e0d0c0b0a09080706050403020100", "a", 1)],
        )
        .unwrap();
        let mut changed = left.clone();
        assert!(left.matches(&changed));
        changed.files[0].file.name = "b".to_owned();
        assert!(!left.matches(&changed));
    }

    #[test]
    fn transfer_plan_selects_buffered_and_streamed_modes() {
        assert_eq!(
            plan_transfer(&[file("small", MAX_BUFFERED_TRANSFER_BYTES)]).unwrap(),
            TransferPlan {
                total_bytes: MAX_BUFFERED_TRANSFER_BYTES,
                mode: TransferMode::Buffered,
            }
        );
        assert!(matches!(
            plan_transfer(&[file("large", MAX_BUFFERED_TRANSFER_BYTES + 1)])
                .unwrap()
                .mode,
            TransferMode::Streamed { .. }
        ));
        assert!(matches!(
            plan_transfer(&[file("a", 1), file("b", 1)]).unwrap().mode,
            TransferMode::Streamed { .. }
        ));
    }

    #[test]
    fn transfer_plan_rejects_invalid_counts_overflow_and_limit() {
        assert_eq!(plan_transfer(&[]), Err(TransferPlanError::InvalidFileCount));
        let too_many = (0..=MAX_FILES_PER_MANIFEST)
            .map(|index| file(&index.to_string(), 0))
            .collect::<Vec<_>>();
        assert_eq!(
            plan_transfer(&too_many),
            Err(TransferPlanError::InvalidFileCount)
        );
        assert_eq!(
            plan_transfer(&[file("a", u64::MAX), file("b", 1)]),
            Err(TransferPlanError::SizeOverflow)
        );
        assert_eq!(
            plan_transfer(&[file("large", MAX_TRANSFER_BYTES + 1)]),
            Err(TransferPlanError::TransferTooLarge)
        );
    }

    #[test]
    fn transfer_summary_preserves_single_file_and_summarizes_batches() {
        let single = file("a", 4);
        assert_eq!(
            summarize_transfer_files(std::slice::from_ref(&single)),
            single
        );
        assert_eq!(
            summarize_transfer_files(&[file("a", 4), file("b", 5)]),
            TransferFile {
                name: "2 个文件".to_owned(),
                mime: None,
                size_bytes: 9,
            }
        );
    }

    #[test]
    fn batch_digest_preserves_single_digest_and_is_order_sensitive() {
        let first = FileDigest {
            file_id: "file_a".to_owned(),
            size_bytes: 1,
            blake3: "a".repeat(64),
        };
        let second = FileDigest {
            file_id: "file_b".to_owned(),
            size_bytes: 2,
            blake3: "b".repeat(64),
        };
        assert_eq!(batch_blake3(std::slice::from_ref(&first)), first.blake3);
        let forward = batch_blake3(&[first.clone(), second.clone()]);
        let reverse = batch_blake3(&[second, first]);
        assert_eq!(forward.len(), 64);
        assert_ne!(forward, reverse);
    }
}
