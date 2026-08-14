//! Response, error, and body-limit types shared by every transport.

use std::fmt;

/// OAuth and ordinary provider JSON responses are intentionally small. Callers
/// that legitimately return more data must opt into their own bounded limit.
pub const DEFAULT_RESPONSE_LIMIT: usize = 64 * 1024;

/// Provider PR list/detail/commit pages can legitimately exceed the OAuth-sized
/// default (descriptions, reviewers, and batched commit metadata add up), while
/// still being far smaller than raw patch responses. Provider REST clients opt
/// into this streaming ceiling; OAuth identity/token calls stay at 64 KiB.
pub const PROVIDER_JSON_RESPONSE_LIMIT: usize = 4 * 1024 * 1024;

/// A transport failure distinct from an HTTP status response. In particular,
/// an oversized body is typed so provider adapters can fail closed instead of
/// parsing a prefix as if it were the complete response.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HttpError {
    Transport(String),
    ResponseTooLarge { limit: usize },
}

impl fmt::Display for HttpError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Transport(message) => f.write_str(message),
            Self::ResponseTooLarge { limit } => {
                write!(f, "provider response exceeded the {limit}-byte limit")
            }
        }
    }
}

impl std::error::Error for HttpError {}

impl From<HttpError> for String {
    fn from(error: HttpError) -> Self {
        error.to_string()
    }
}

pub type HttpResult = Result<HttpResponse, HttpError>;

/// A completed HTTP exchange: the status code and the response body. Returned
/// for any response the server actually sent, including 4xx/5xx.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpResponse {
    pub status: u16,
    pub body: String,
}

impl HttpResponse {
    pub fn is_success(&self) -> bool {
        (200..300).contains(&self.status)
    }
}
