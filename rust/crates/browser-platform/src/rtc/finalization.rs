#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum CompletionSignalOutcome {
    Enqueued,
    ReconnectableFailure,
    FatalFailure,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum CompletionAction {
    AttemptRecoveryCleanupAndComplete,
    PreserveRecoveryAndReconnect,
    PreserveRecoveryAndFail,
}

pub(super) fn completion_action(outcome: CompletionSignalOutcome) -> CompletionAction {
    match outcome {
        CompletionSignalOutcome::Enqueued => CompletionAction::AttemptRecoveryCleanupAndComplete,
        CompletionSignalOutcome::ReconnectableFailure => {
            CompletionAction::PreserveRecoveryAndReconnect
        }
        CompletionSignalOutcome::FatalFailure => CompletionAction::PreserveRecoveryAndFail,
    }
}

pub(super) fn recovery_cleanup_retry_delay_ms(failed_attempts: u8) -> Option<u32> {
    match failed_attempts {
        1 => Some(50),
        2 => Some(150),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn completion_requires_an_enqueued_control_frame() {
        assert_eq!(
            completion_action(CompletionSignalOutcome::Enqueued),
            CompletionAction::AttemptRecoveryCleanupAndComplete
        );
        assert_eq!(
            completion_action(CompletionSignalOutcome::ReconnectableFailure),
            CompletionAction::PreserveRecoveryAndReconnect
        );
        assert_eq!(
            completion_action(CompletionSignalOutcome::FatalFailure),
            CompletionAction::PreserveRecoveryAndFail
        );
    }

    #[test]
    fn recovery_cleanup_retry_schedule_is_finite() {
        assert_eq!(recovery_cleanup_retry_delay_ms(1), Some(50));
        assert_eq!(recovery_cleanup_retry_delay_ms(2), Some(150));
        assert_eq!(recovery_cleanup_retry_delay_ms(3), None);
        assert_eq!(recovery_cleanup_retry_delay_ms(u8::MAX), None);
    }
}
