use std::collections::{BTreeMap, BTreeSet};

use thiserror::Error;

use crate::{FileId, SessionId, TransferId};

pub const MAX_FILES_PER_TRANSFER: usize = 10;
pub const MAX_TRANSFER_BYTES: u64 = 100 * 1024 * 1024;
pub const MAX_FILE_NAME_CHARS: usize = 255;
pub const MAX_MIME_BYTES: usize = 128;
pub const MAX_RECEIVERS_PER_TRANSFER: usize = 16;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FileName(String);

impl FileName {
    pub fn parse(value: impl AsRef<str>) -> Result<Self, TransferError> {
        let value = value.as_ref();
        let length = value.chars().count();
        if length == 0 || length > MAX_FILE_NAME_CHARS {
            return Err(TransferError::InvalidFileName);
        }
        if value
            .chars()
            .any(|character| character.is_control() || matches!(character, '/' | '\\'))
        {
            return Err(TransferError::InvalidFileName);
        }
        Ok(Self(value.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FileSpec {
    id: FileId,
    name: FileName,
    size_bytes: u64,
    mime: Option<String>,
}

impl FileSpec {
    pub fn new(
        id: FileId,
        name: FileName,
        size_bytes: u64,
        mime: Option<String>,
    ) -> Result<Self, TransferError> {
        if let Some(value) = mime.as_deref()
            && (value.is_empty()
                || value.len() > MAX_MIME_BYTES
                || value.chars().any(char::is_control))
        {
            return Err(TransferError::InvalidMime);
        }
        Ok(Self {
            id,
            name,
            size_bytes,
            mime,
        })
    }

    pub fn id(&self) -> &FileId {
        &self.id
    }

    pub fn name(&self) -> &FileName {
        &self.name
    }

    pub const fn size_bytes(&self) -> u64 {
        self.size_bytes
    }

    pub fn mime(&self) -> Option<&str> {
        self.mime.as_deref()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TransferManifest {
    id: TransferId,
    sender: SessionId,
    files: Vec<FileSpec>,
    total_bytes: u64,
}

impl TransferManifest {
    pub fn new(
        id: TransferId,
        sender: SessionId,
        files: Vec<FileSpec>,
    ) -> Result<Self, TransferError> {
        if files.is_empty() || files.len() > MAX_FILES_PER_TRANSFER {
            return Err(TransferError::InvalidFileCount);
        }
        let mut ids = BTreeSet::new();
        let mut total_bytes = 0_u64;
        for file in &files {
            if !ids.insert(file.id.clone()) {
                return Err(TransferError::DuplicateFileId);
            }
            total_bytes = total_bytes
                .checked_add(file.size_bytes)
                .ok_or(TransferError::TransferTooLarge)?;
        }
        if total_bytes > MAX_TRANSFER_BYTES {
            return Err(TransferError::TransferTooLarge);
        }
        Ok(Self {
            id,
            sender,
            files,
            total_bytes,
        })
    }

    pub fn id(&self) -> &TransferId {
        &self.id
    }

    pub fn sender(&self) -> &SessionId {
        &self.sender
    }

    pub fn files(&self) -> &[FileSpec] {
        &self.files
    }

    pub const fn total_bytes(&self) -> u64 {
        self.total_bytes
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CancelledBy {
    Sender,
    Receiver,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FailureCode {
    ConnectionLost,
    Timeout,
    IntegrityMismatch,
    ResourceLimit,
    Internal,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReceiverTransferState {
    Offered,
    Accepted,
    Transferring { transferred_bytes: u64 },
    Rejected,
    Completed { bytes: u64, blake3: [u8; 32] },
    Cancelled { by: CancelledBy },
    Failed { code: FailureCode },
}

impl ReceiverTransferState {
    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            Self::Rejected | Self::Completed { .. } | Self::Cancelled { .. } | Self::Failed { .. }
        )
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReceiverCommand {
    Accept,
    Reject,
    Start,
    Progress { transferred_bytes: u64 },
    Complete { bytes: u64, blake3: [u8; 32] },
    Cancel { by: CancelledBy },
    Fail { code: FailureCode },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReceiverEvent {
    Accepted,
    Rejected,
    Started,
    Progressed { transferred_bytes: u64 },
    Completed { bytes: u64, blake3: [u8; 32] },
    Cancelled { by: CancelledBy },
    Failed { code: FailureCode },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ReceiverTransition {
    pub event: Option<ReceiverEvent>,
}

impl ReceiverTransition {
    pub fn changed(&self) -> bool {
        self.event.is_some()
    }

    fn unchanged() -> Self {
        Self { event: None }
    }

    fn with_event(event: ReceiverEvent) -> Self {
        Self { event: Some(event) }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReceiverTransfer {
    transfer_id: TransferId,
    receiver: SessionId,
    total_bytes: u64,
    state: ReceiverTransferState,
}

impl ReceiverTransfer {
    pub fn offered(manifest: &TransferManifest, receiver: SessionId) -> Self {
        Self {
            transfer_id: manifest.id.clone(),
            receiver,
            total_bytes: manifest.total_bytes,
            state: ReceiverTransferState::Offered,
        }
    }

    pub fn transfer_id(&self) -> &TransferId {
        &self.transfer_id
    }

    pub fn receiver(&self) -> &SessionId {
        &self.receiver
    }

    pub const fn total_bytes(&self) -> u64 {
        self.total_bytes
    }

    pub fn state(&self) -> &ReceiverTransferState {
        &self.state
    }

    pub fn apply(&mut self, command: ReceiverCommand) -> Result<ReceiverTransition, TransferError> {
        match command {
            ReceiverCommand::Accept => self.accept(),
            ReceiverCommand::Reject => self.reject(),
            ReceiverCommand::Start => self.start(),
            ReceiverCommand::Progress { transferred_bytes } => self.progress(transferred_bytes),
            ReceiverCommand::Complete { bytes, blake3 } => self.complete(bytes, blake3),
            ReceiverCommand::Cancel { by } => self.cancel(by),
            ReceiverCommand::Fail { code } => self.fail(code),
        }
    }

    pub fn verify_invariants(&self) -> Result<(), TransferInvariantError> {
        match &self.state {
            ReceiverTransferState::Transferring { transferred_bytes }
                if *transferred_bytes > self.total_bytes =>
            {
                Err(TransferInvariantError::ProgressExceedsTotal)
            }
            ReceiverTransferState::Completed { bytes, .. } if *bytes != self.total_bytes => {
                Err(TransferInvariantError::CompletedBytesMismatch)
            }
            _ => Ok(()),
        }
    }

    fn accept(&mut self) -> Result<ReceiverTransition, TransferError> {
        match self.state {
            ReceiverTransferState::Offered => {
                self.state = ReceiverTransferState::Accepted;
                Ok(ReceiverTransition::with_event(ReceiverEvent::Accepted))
            }
            ReceiverTransferState::Accepted | ReceiverTransferState::Transferring { .. } => {
                Ok(ReceiverTransition::unchanged())
            }
            _ => Err(TransferError::TerminalState),
        }
    }

    fn reject(&mut self) -> Result<ReceiverTransition, TransferError> {
        match self.state {
            ReceiverTransferState::Offered => {
                self.state = ReceiverTransferState::Rejected;
                Ok(ReceiverTransition::with_event(ReceiverEvent::Rejected))
            }
            ReceiverTransferState::Rejected => Ok(ReceiverTransition::unchanged()),
            _ => Err(TransferError::TerminalState),
        }
    }

    fn start(&mut self) -> Result<ReceiverTransition, TransferError> {
        match self.state {
            ReceiverTransferState::Accepted => {
                self.state = ReceiverTransferState::Transferring {
                    transferred_bytes: 0,
                };
                Ok(ReceiverTransition::with_event(ReceiverEvent::Started))
            }
            ReceiverTransferState::Transferring { .. } => Ok(ReceiverTransition::unchanged()),
            _ if self.state.is_terminal() => Err(TransferError::TerminalState),
            _ => Err(TransferError::InvalidTransition),
        }
    }

    fn progress(&mut self, transferred_bytes: u64) -> Result<ReceiverTransition, TransferError> {
        let ReceiverTransferState::Transferring {
            transferred_bytes: current,
        } = self.state
        else {
            return if self.state.is_terminal() {
                Err(TransferError::TerminalState)
            } else {
                Err(TransferError::InvalidTransition)
            };
        };
        if transferred_bytes < current {
            return Err(TransferError::ProgressRegressed);
        }
        if transferred_bytes > self.total_bytes {
            return Err(TransferError::ProgressExceedsTotal);
        }
        if transferred_bytes == current {
            return Ok(ReceiverTransition::unchanged());
        }
        self.state = ReceiverTransferState::Transferring { transferred_bytes };
        Ok(ReceiverTransition::with_event(ReceiverEvent::Progressed {
            transferred_bytes,
        }))
    }

    fn complete(
        &mut self,
        bytes: u64,
        blake3: [u8; 32],
    ) -> Result<ReceiverTransition, TransferError> {
        if let ReceiverTransferState::Completed {
            bytes: current_bytes,
            blake3: current_digest,
        } = self.state
        {
            return if current_bytes == bytes && current_digest == blake3 {
                Ok(ReceiverTransition::unchanged())
            } else {
                Err(TransferError::TerminalState)
            };
        }
        if self.state.is_terminal() {
            return Err(TransferError::TerminalState);
        }
        if !matches!(self.state, ReceiverTransferState::Transferring { .. }) {
            return Err(TransferError::InvalidTransition);
        }
        if bytes != self.total_bytes {
            return Err(TransferError::IncompleteTransfer);
        }
        self.state = ReceiverTransferState::Completed { bytes, blake3 };
        Ok(ReceiverTransition::with_event(ReceiverEvent::Completed {
            bytes,
            blake3,
        }))
    }

    fn cancel(&mut self, by: CancelledBy) -> Result<ReceiverTransition, TransferError> {
        if let ReceiverTransferState::Cancelled { by: current } = self.state {
            return if current == by {
                Ok(ReceiverTransition::unchanged())
            } else {
                Err(TransferError::TerminalState)
            };
        }
        if self.state.is_terminal() {
            return Err(TransferError::TerminalState);
        }
        self.state = ReceiverTransferState::Cancelled { by };
        Ok(ReceiverTransition::with_event(ReceiverEvent::Cancelled {
            by,
        }))
    }

    fn fail(&mut self, code: FailureCode) -> Result<ReceiverTransition, TransferError> {
        if let ReceiverTransferState::Failed { code: current } = self.state {
            return if current == code {
                Ok(ReceiverTransition::unchanged())
            } else {
                Err(TransferError::TerminalState)
            };
        }
        if self.state.is_terminal() {
            return Err(TransferError::TerminalState);
        }
        self.state = ReceiverTransferState::Failed { code };
        Ok(ReceiverTransition::with_event(ReceiverEvent::Failed {
            code,
        }))
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct TransferSummary {
    pub offered: usize,
    pub active: usize,
    pub completed: usize,
    pub rejected: usize,
    pub cancelled: usize,
    pub failed: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SenderTransfer {
    manifest: TransferManifest,
    receivers: BTreeMap<SessionId, ReceiverTransfer>,
}

impl SenderTransfer {
    pub fn new(
        manifest: TransferManifest,
        receivers: impl IntoIterator<Item = SessionId>,
    ) -> Result<Self, TransferError> {
        let mut receiver_states = BTreeMap::new();
        for receiver in receivers {
            let state = ReceiverTransfer::offered(&manifest, receiver.clone());
            if receiver_states.insert(receiver, state).is_some() {
                return Err(TransferError::DuplicateReceiver);
            }
        }
        if receiver_states.is_empty() || receiver_states.len() > MAX_RECEIVERS_PER_TRANSFER {
            return Err(TransferError::InvalidReceiverCount);
        }
        Ok(Self {
            manifest,
            receivers: receiver_states,
        })
    }

    pub fn manifest(&self) -> &TransferManifest {
        &self.manifest
    }

    pub fn receiver(&self, receiver: &SessionId) -> Option<&ReceiverTransfer> {
        self.receivers.get(receiver)
    }

    pub fn apply(
        &mut self,
        receiver: &SessionId,
        command: ReceiverCommand,
    ) -> Result<ReceiverTransition, TransferError> {
        self.receivers
            .get_mut(receiver)
            .ok_or(TransferError::ReceiverNotFound)?
            .apply(command)
    }

    pub fn summary(&self) -> TransferSummary {
        let mut summary = TransferSummary::default();
        for receiver in self.receivers.values() {
            match receiver.state {
                ReceiverTransferState::Offered => summary.offered += 1,
                ReceiverTransferState::Accepted | ReceiverTransferState::Transferring { .. } => {
                    summary.active += 1;
                }
                ReceiverTransferState::Completed { .. } => summary.completed += 1,
                ReceiverTransferState::Rejected => summary.rejected += 1,
                ReceiverTransferState::Cancelled { .. } => summary.cancelled += 1,
                ReceiverTransferState::Failed { .. } => summary.failed += 1,
            }
        }
        summary
    }

    pub fn is_terminal(&self) -> bool {
        self.receivers
            .values()
            .all(|receiver| receiver.state.is_terminal())
    }

    pub fn verify_invariants(&self) -> Result<(), TransferInvariantError> {
        if self.receivers.is_empty() || self.receivers.len() > MAX_RECEIVERS_PER_TRANSFER {
            return Err(TransferInvariantError::InvalidReceiverCount);
        }
        for (receiver_id, receiver) in &self.receivers {
            if receiver_id != &receiver.receiver
                || receiver.transfer_id != self.manifest.id
                || receiver.total_bytes != self.manifest.total_bytes
            {
                return Err(TransferInvariantError::ReceiverIdentityMismatch);
            }
            receiver.verify_invariants()?;
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
pub enum TransferError {
    #[error("file name is empty, too long, or contains a path/control character")]
    InvalidFileName,
    #[error("MIME value is empty, too long, or contains a control character")]
    InvalidMime,
    #[error("transfer must contain between 1 and 10 files")]
    InvalidFileCount,
    #[error("transfer contains duplicate file ids")]
    DuplicateFileId,
    #[error("transfer exceeds the configured byte limit")]
    TransferTooLarge,
    #[error("transfer must contain between 1 and 16 unique receivers")]
    InvalidReceiverCount,
    #[error("transfer contains a duplicate receiver")]
    DuplicateReceiver,
    #[error("receiver is not part of the transfer")]
    ReceiverNotFound,
    #[error("command is not valid in the current transfer state")]
    InvalidTransition,
    #[error("terminal transfer state cannot be changed")]
    TerminalState,
    #[error("transfer progress must not decrease")]
    ProgressRegressed,
    #[error("transfer progress exceeds the manifest total")]
    ProgressExceedsTotal,
    #[error("completion bytes must equal the manifest total")]
    IncompleteTransfer,
}

#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
pub enum TransferInvariantError {
    #[error("receiver progress exceeds the transfer total")]
    ProgressExceedsTotal,
    #[error("completed byte count differs from the transfer total")]
    CompletedBytesMismatch,
    #[error("sender transfer receiver count is invalid")]
    InvalidReceiverCount,
    #[error("receiver identity or manifest totals differ from the sender aggregate")]
    ReceiverIdentityMismatch,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id<T>(value: &str) -> T
    where
        T: std::str::FromStr,
        T::Err: std::fmt::Debug,
    {
        value.parse().expect("valid id")
    }

    fn manifest(total: u64) -> TransferManifest {
        TransferManifest::new(
            id("transfer_1"),
            id("sender_1"),
            vec![
                FileSpec::new(
                    id("file_1"),
                    FileName::parse("report.pdf").expect("file name"),
                    total,
                    Some("application/pdf".to_owned()),
                )
                .expect("file spec"),
            ],
        )
        .expect("manifest")
    }

    #[test]
    fn receiver_happy_path_enforces_monotonic_progress_and_idempotent_completion() {
        let manifest = manifest(100);
        let mut receiver = ReceiverTransfer::offered(&manifest, id("receiver_1"));
        assert!(
            receiver
                .apply(ReceiverCommand::Accept)
                .expect("accept")
                .changed()
        );
        assert!(
            receiver
                .apply(ReceiverCommand::Start)
                .expect("start")
                .changed()
        );
        assert!(
            receiver
                .apply(ReceiverCommand::Progress {
                    transferred_bytes: 60
                })
                .expect("progress")
                .changed()
        );
        assert_eq!(
            receiver.apply(ReceiverCommand::Progress {
                transferred_bytes: 50
            }),
            Err(TransferError::ProgressRegressed)
        );
        let digest = [7; 32];
        assert!(
            receiver
                .apply(ReceiverCommand::Complete {
                    bytes: 100,
                    blake3: digest,
                })
                .expect("complete")
                .changed()
        );
        assert!(
            !receiver
                .apply(ReceiverCommand::Complete {
                    bytes: 100,
                    blake3: digest,
                })
                .expect("complete replay")
                .changed()
        );
        assert_eq!(
            receiver.apply(ReceiverCommand::Cancel {
                by: CancelledBy::Sender
            }),
            Err(TransferError::TerminalState)
        );
    }

    #[test]
    fn receiver_outcomes_are_independent_in_sender_summary() {
        let mut sender = SenderTransfer::new(
            manifest(10),
            [id("receiver_1"), id("receiver_2"), id("receiver_3")],
        )
        .expect("sender transfer");
        sender
            .apply(&id("receiver_1"), ReceiverCommand::Reject)
            .expect("reject");
        sender
            .apply(&id("receiver_2"), ReceiverCommand::Accept)
            .expect("accept");
        sender
            .apply(
                &id("receiver_3"),
                ReceiverCommand::Fail {
                    code: FailureCode::Timeout,
                },
            )
            .expect("fail");
        assert_eq!(
            sender.summary(),
            TransferSummary {
                active: 1,
                rejected: 1,
                failed: 1,
                ..TransferSummary::default()
            }
        );
        sender.verify_invariants().expect("sender invariants");
    }

    #[test]
    fn manifest_rejects_duplicate_ids_and_oversized_totals() {
        let file = FileSpec::new(
            id("file_1"),
            FileName::parse("a.txt").expect("file name"),
            1,
            None,
        )
        .expect("file");
        assert_eq!(
            TransferManifest::new(id("transfer_1"), id("sender_1"), vec![file.clone(), file],),
            Err(TransferError::DuplicateFileId)
        );
        assert!(
            TransferManifest::new(
                id("transfer_1"),
                id("sender_1"),
                vec![
                    FileSpec::new(
                        id("file_2"),
                        FileName::parse("large.bin").expect("file name"),
                        MAX_TRANSFER_BYTES + 1,
                        None,
                    )
                    .expect("file")
                ],
            )
            .is_err()
        );
    }

    #[test]
    fn generated_receiver_commands_preserve_terminal_and_progress_invariants() {
        for seed in 1_u64..=128 {
            let manifest = manifest(100);
            let mut receiver = ReceiverTransfer::offered(&manifest, id("receiver_1"));
            let mut value = seed;
            for _ in 0..128 {
                value = value
                    .wrapping_mul(2_862_933_555_777_941_757)
                    .wrapping_add(3_037_000_493);
                let before = receiver.state;
                let command = match value % 7 {
                    0 => ReceiverCommand::Accept,
                    1 => ReceiverCommand::Reject,
                    2 => ReceiverCommand::Start,
                    3 => ReceiverCommand::Progress {
                        transferred_bytes: (value >> 8) % 130,
                    },
                    4 => ReceiverCommand::Complete {
                        bytes: (value >> 16) % 130,
                        blake3: [value as u8; 32],
                    },
                    5 => ReceiverCommand::Cancel {
                        by: if value & 1 == 0 {
                            CancelledBy::Sender
                        } else {
                            CancelledBy::Receiver
                        },
                    },
                    _ => ReceiverCommand::Fail {
                        code: FailureCode::ConnectionLost,
                    },
                };
                let _ = receiver.apply(command);
                receiver.verify_invariants().expect("receiver invariant");
                if before.is_terminal() {
                    assert_eq!(
                        receiver.state, before,
                        "terminal state changed for seed {seed}"
                    );
                }
            }
        }
    }
}
