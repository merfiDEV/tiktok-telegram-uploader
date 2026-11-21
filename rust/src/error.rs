//! `TikTokUploadError`, mirroring the JavaScript/`Python` error of the same name.
//!
//! Callers can catch upload failures without the process dying mid-flow, which
//! is why the original library exposes a dedicated error type instead of
//! exiting.

use std::fmt;

#[derive(Debug, Clone)]
pub struct UploadError {
    pub message: String,
}

impl UploadError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl fmt::Display for UploadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "TikTokUploadError: {}", self.message)
    }
}

impl std::error::Error for UploadError {}

impl From<anyhow::Error> for UploadError {
    fn from(error: anyhow::Error) -> Self {
        Self::new(error.to_string())
    }
}
