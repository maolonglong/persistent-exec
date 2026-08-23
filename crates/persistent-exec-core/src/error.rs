use std::fmt;

/// Stable error categories intended for transport adapters and callers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ErrorKind {
    InvalidInput,
    NotFound,
    InvalidState,
    ResourceExhausted,
    Busy,
    SpawnFailed,
    Internal,
}

#[derive(Debug)]
pub struct ExecError {
    kind: ErrorKind,
    message: String,
}

impl ExecError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    pub fn kind(&self) -> ErrorKind {
        self.kind
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

impl fmt::Display for ExecError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for ExecError {}

pub type Result<T> = std::result::Result<T, ExecError>;
