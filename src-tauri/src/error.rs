//! A single error type that crosses the IPC boundary as `{ code, message, hint }`.

use serde::Serialize;
use std::fmt;

#[derive(Debug, Clone, Serialize)]
pub struct AppError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}

pub type AppResult<T> = Result<T, AppError>;

impl AppError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            hint: None,
        }
    }

    pub fn with_hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }

    pub fn not_found(what: impl Into<String>) -> Self {
        Self::new("not_found", format!("{} was not found", what.into()))
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new("invalid", message)
    }

    pub fn missing_tool(component: &str) -> Self {
        Self::new(
            "missing_tool",
            format!("The {component} component is not installed"),
        )
        .with_hint("Open Environment and install it with one click.")
    }

    pub fn cancelled() -> Self {
        Self::new("cancelled", "Cancelled")
    }
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for AppError {}

impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        match e {
            rusqlite::Error::QueryReturnedNoRows => Self::not_found("Record"),
            other => Self::new("db", other.to_string()),
        }
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        let hint = match e.kind() {
            std::io::ErrorKind::PermissionDenied => {
                Some("Check folder permissions in Settings → Workspace.")
            }
            std::io::ErrorKind::StorageFull => {
                Some("Free some disk space or move the workspace to a larger drive.")
            }
            _ => None,
        };
        let err = Self::new("io", e.to_string());
        match hint {
            Some(h) => err.with_hint(h),
            None => err,
        }
    }
}

impl From<reqwest::Error> for AppError {
    fn from(e: reqwest::Error) -> Self {
        if e.is_timeout() || e.is_connect() {
            return Self::new("network", e.to_string())
                .with_hint("Check your internet connection and try again.");
        }
        Self::new("http", e.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        Self::new("json", e.to_string())
    }
}

impl From<tauri::Error> for AppError {
    fn from(e: tauri::Error) -> Self {
        Self::new("tauri", e.to_string())
    }
}

impl From<regex::Error> for AppError {
    fn from(e: regex::Error) -> Self {
        Self::invalid(format!("Invalid pattern: {e}"))
    }
}

/// Maps an HTTP status from a third-party API to a friendly error.
pub fn http_status_error(service: &str, status: reqwest::StatusCode, body: &str) -> AppError {
    let snippet: String = body.chars().take(300).collect();
    let base = AppError::new("http", format!("{service} returned {status}: {snippet}"));
    match status.as_u16() {
        401 => base.with_hint(format!("Your {service} credentials were rejected. Update them in Settings.")),
        403 => base.with_hint(format!(
            "Access denied by {service}. For gated models accept the license on the model page; for uploads use a token with write access."
        )),
        404 => base.with_hint("Check the name or ID; it may be private or misspelled."),
        429 => base.with_hint("Rate limited. Wait a moment and try again."),
        _ => base,
    }
}
