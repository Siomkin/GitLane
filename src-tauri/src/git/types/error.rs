//! The one error shape that crosses IPC (`ipc/commands` spec, GL audit).
//!
//! Every `#[tauri::command]` rejects with a serialised [`CommandError`]: a
//! closed `kind` the frontend branches on, a human-readable `message`, and
//! optional structured context. Classification happens here in Rust, next to
//! the process that observed the failure, so the frontend never has to parse
//! `git`/`gh` text to decide what went wrong — it only formats copy.
//!
//! Internal error types (`GithubError`, `HttpError`, `SecretError`,
//! `RepoOpenError`, the forge `CaptureError`, the write layer's `String`
//! diagnostics) convert into this type via `From`; the conversions are the
//! single place their category is decided.

use serde::{Deserialize, Serialize};

use super::repo::{RepoOpenError, RepoOpenErrorKind};

/// Closed set of failure categories the frontend may branch on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CommandErrorKind {
    /// The `git` CLI reported a failure that fits no more specific category.
    Git,
    /// A repository hook refused the operation; `hook` names it when known.
    HookRejected,
    /// A credential was missing, refused, or lacks permission.
    Auth,
    /// The remote could not be reached (DNS, connection, TLS, host key).
    Network,
    /// A leased write found the repository changed since the preview.
    StaleLease,
    /// `.git/index.lock` exists and blocks the index write.
    IndexLock,
    /// The operation left (or found) the repository mid-conflict.
    Conflict,
    /// The path exists but is not a git repository.
    NotARepository,
    /// The path no longer exists on disk.
    MissingPath,
    /// A forge provider (`gh`, `glab`, REST, `origin`) failed for a reason
    /// other than auth/network.
    Forge,
    /// Anything else — unexpected, bug, or unclassified internal failure.
    Internal,
}

/// The serialised IPC error. Field names are camelCase on the wire; optional
/// context fields are omitted when absent so the JSON stays small.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    pub kind: CommandErrorKind,
    /// Finer sub-category within `kind` (e.g. `sshPublickey` under `auth`),
    /// stable identifiers the frontend picks copy by.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    /// Human-readable, already redacted. For hook rejections this is the hook's
    /// own reason lines with task-runner noise removed.
    pub message: String,
    /// Full redacted output when `message` is a summary of it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// The hook that refused the operation (`pre-commit`, `commit-msg`, …).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hook: Option<String>,
    /// The path the failure concerns, for `missingPath` / `notARepository`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

impl CommandError {
    /// A bare error of `kind` with no extra context.
    pub fn new(kind: CommandErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            code: None,
            message: message.into(),
            detail: None,
            hook: None,
            path: None,
        }
    }

    /// Shorthand for the catch-all category.
    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(CommandErrorKind::Internal, message)
    }

    /// Attach a sub-category code.
    pub fn with_code(mut self, code: impl Into<String>) -> Self {
        self.code = Some(code.into());
        self
    }

    /// Run every text field through secret redaction. Applied once at the
    /// command boundary (`commands::blocking` / `commands::sync`) so no
    /// producer can leak a credential by forgetting its own redaction.
    pub fn redacted(mut self) -> Self {
        self.message = crate::redact::redact_secrets(&self.message);
        self.detail = self
            .detail
            .map(|detail| crate::redact::redact_secrets(&detail));
        self
    }
}

impl std::fmt::Display for CommandError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for CommandError {}

/// The write layer's diagnostics are `String`s produced next to the `git`
/// subprocess; classifying them here keeps that layer message-typed while the
/// category still originates in Rust.
impl From<String> for CommandError {
    fn from(message: String) -> Self {
        crate::git::write::classify::classify_failure(&message)
    }
}

impl From<&str> for CommandError {
    fn from(message: &str) -> Self {
        Self::from(message.to_string())
    }
}

impl From<RepoOpenError> for CommandError {
    fn from(error: RepoOpenError) -> Self {
        let kind = match error.kind {
            RepoOpenErrorKind::Missing => CommandErrorKind::MissingPath,
            RepoOpenErrorKind::NotARepository => CommandErrorKind::NotARepository,
            RepoOpenErrorKind::Other => CommandErrorKind::Internal,
        };
        Self {
            kind,
            code: None,
            message: error.message,
            detail: None,
            hook: None,
            path: Some(error.path),
        }
    }
}

/// libgit2 read failures: only "not a repository" and "path gone" are
/// user-actionable categories; everything else is internal.
impl From<git2::Error> for CommandError {
    fn from(error: git2::Error) -> Self {
        let kind = match (error.class(), error.code()) {
            (git2::ErrorClass::Repository, git2::ErrorCode::NotFound) => {
                CommandErrorKind::NotARepository
            }
            (git2::ErrorClass::Os, _) => CommandErrorKind::MissingPath,
            _ => CommandErrorKind::Internal,
        };
        Self::new(kind, error.message())
    }
}

impl From<crate::secrets::SecretError> for CommandError {
    fn from(error: crate::secrets::SecretError) -> Self {
        Self::internal(error.0).with_code("keychain")
    }
}

impl From<crate::git::oauth::http::HttpError> for CommandError {
    fn from(error: crate::git::oauth::http::HttpError) -> Self {
        use crate::git::oauth::http::HttpError;
        match &error {
            HttpError::Transport(_) => {
                Self::new(CommandErrorKind::Network, error.to_string()).with_code("transport")
            }
            HttpError::ResponseTooLarge { .. } => {
                Self::new(CommandErrorKind::Forge, error.to_string()).with_code("responseTooLarge")
            }
        }
    }
}

impl From<crate::git::forge::GithubError> for CommandError {
    fn from(error: crate::git::forge::GithubError) -> Self {
        use crate::git::forge::GithubError as E;
        let message = error.to_ipc_string();
        let (kind, code) = match &error {
            E::ProviderUnavailable { .. } => (CommandErrorKind::Forge, "providerUnavailable"),
            E::UnsupportedVersion { .. } => (CommandErrorKind::Forge, "unsupportedVersion"),
            E::GhUnusable { .. } => (CommandErrorKind::Forge, "providerUnusable"),
            E::UnsupportedForge { .. } => (CommandErrorKind::Forge, "unsupportedForge"),
            E::NotAuthenticated { .. } => (CommandErrorKind::Auth, "notAuthenticated"),
            E::RepositoryNotFound { .. } => (CommandErrorKind::Forge, "repositoryNotFound"),
            E::HostMismatch { .. } => (CommandErrorKind::Auth, "hostMismatch"),
            E::PermissionDenied { .. } => (CommandErrorKind::Auth, "permissionDenied"),
            E::RateLimited { .. } => (CommandErrorKind::Forge, "rateLimited"),
            E::Network(_) => (CommandErrorKind::Network, "unreachable"),
            E::InvalidResponse(_) => (CommandErrorKind::Forge, "invalidResponse"),
            E::CommandFailed(_) => (CommandErrorKind::Forge, "commandFailed"),
        };
        Self::new(kind, message).with_code(code)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serialises_camel_case_and_omits_absent_context() {
        let error = CommandError::new(CommandErrorKind::HookRejected, "nope");
        let json = serde_json::to_value(&error).unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "kind": "hookRejected", "message": "nope" })
        );
        let round: CommandError = serde_json::from_value(json).unwrap();
        assert_eq!(round, error);
    }

    #[test]
    fn round_trips_every_field() {
        let error = CommandError {
            kind: CommandErrorKind::Auth,
            code: Some("sshPublickey".into()),
            message: "m".into(),
            detail: Some("d".into()),
            hook: Some("pre-push".into()),
            path: Some("/repo".into()),
        };
        let json = serde_json::to_string(&error).unwrap();
        assert!(json.contains("\"code\":\"sshPublickey\""));
        assert_eq!(serde_json::from_str::<CommandError>(&json).unwrap(), error);
    }

    #[test]
    fn repo_open_error_maps_kind_and_keeps_path() {
        let error = CommandError::from(RepoOpenError {
            kind: RepoOpenErrorKind::Missing,
            message: "gone".into(),
            path: "/x".into(),
        });
        assert_eq!(error.kind, CommandErrorKind::MissingPath);
        assert_eq!(error.path.as_deref(), Some("/x"));
        let other = CommandError::from(RepoOpenError {
            kind: RepoOpenErrorKind::NotARepository,
            message: "m".into(),
            path: "/y".into(),
        });
        assert_eq!(other.kind, CommandErrorKind::NotARepository);
    }

    #[test]
    fn git2_not_found_repository_is_not_a_repository() {
        let error = git2::Error::new(
            git2::ErrorCode::NotFound,
            git2::ErrorClass::Repository,
            "could not find repository",
        );
        assert_eq!(
            CommandError::from(error).kind,
            CommandErrorKind::NotARepository
        );
        let os = git2::Error::new(
            git2::ErrorCode::GenericError,
            git2::ErrorClass::Os,
            "No such file or directory",
        );
        assert_eq!(CommandError::from(os).kind, CommandErrorKind::MissingPath);
        let other = git2::Error::from_str("boom");
        assert_eq!(CommandError::from(other).kind, CommandErrorKind::Internal);
    }

    #[test]
    fn github_errors_map_auth_network_and_forge() {
        use crate::git::forge::GithubError as E;
        let auth = CommandError::from(E::NotAuthenticated {
            host: "github.com".into(),
            account: None,
        });
        assert_eq!(auth.kind, CommandErrorKind::Auth);
        assert_eq!(auth.code.as_deref(), Some("notAuthenticated"));
        assert_eq!(
            CommandError::from(E::Network("down".into())).kind,
            CommandErrorKind::Network
        );
        let forge = CommandError::from(E::RateLimited { reset_at: None });
        assert_eq!(forge.kind, CommandErrorKind::Forge);
        assert_eq!(forge.code.as_deref(), Some("rateLimited"));
        assert_eq!(
            CommandError::from(E::PermissionDenied { operation: "merge" }).kind,
            CommandErrorKind::Auth
        );
    }

    #[test]
    fn http_and_secret_errors_map() {
        use crate::git::oauth::http::HttpError;
        assert_eq!(
            CommandError::from(HttpError::Transport("dns".into())).kind,
            CommandErrorKind::Network
        );
        assert_eq!(
            CommandError::from(HttpError::ResponseTooLarge { limit: 1 }).kind,
            CommandErrorKind::Forge
        );
        let secret = CommandError::from(crate::secrets::SecretError("locked".into()));
        assert_eq!(secret.kind, CommandErrorKind::Internal);
        assert_eq!(secret.code.as_deref(), Some("keychain"));
    }

    #[test]
    fn redacted_scrubs_message_and_detail() {
        let error = CommandError {
            kind: CommandErrorKind::Git,
            code: None,
            message: "fatal: https://user:hunter2@example.com/r.git".into(),
            detail: Some("remote: https://x-token-auth:hunter2@bitbucket.org/t/r".into()),
            hook: None,
            path: None,
        }
        .redacted();
        assert!(!error.message.contains("hunter2"), "{}", error.message);
        assert!(!error.detail.as_deref().unwrap_or("").contains("hunter2"));
    }
}
