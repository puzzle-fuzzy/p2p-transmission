use thiserror::Error;

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct EpochMillis(u64);

impl EpochMillis {
    pub const fn new(value: u64) -> Self {
        Self(value)
    }

    pub const fn value(self) -> u64 {
        self.0
    }

    pub fn checked_add(self, duration: DurationMillis) -> Result<Self, TimeError> {
        self.0
            .checked_add(duration.0)
            .map(Self)
            .ok_or(TimeError::Overflow)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DurationMillis(u64);

impl DurationMillis {
    pub const fn new(value: u64) -> Self {
        Self(value)
    }

    pub const fn value(self) -> u64 {
        self.0
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, Ord, PartialEq, PartialOrd)]
pub struct Revision(u64);

impl Revision {
    pub const fn new(value: u64) -> Self {
        Self(value)
    }

    pub const fn value(self) -> u64 {
        self.0
    }

    pub fn next(self) -> Result<Self, TimeError> {
        self.0.checked_add(1).map(Self).ok_or(TimeError::Overflow)
    }
}

#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
pub enum TimeError {
    #[error("time or revision overflow")]
    Overflow,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn time_addition_is_checked() {
        assert_eq!(
            EpochMillis::new(5)
                .checked_add(DurationMillis::new(7))
                .expect("time fits")
                .value(),
            12
        );
        assert_eq!(
            EpochMillis::new(u64::MAX).checked_add(DurationMillis::new(1)),
            Err(TimeError::Overflow)
        );
    }
}
