//! Remote repositories over SSH (remote-ssh-repos): the session state the UI
//! shows per host, and what connecting to a host reports.

use serde::Serialize;

use super::CommandError;

/// Where a host's session is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RemoteSessionState {
    Connecting,
    /// Putting this version's agent on the host first.
    Installing,
    Connected,
    /// The session ended (closed, or the connection dropped).
    Disconnected,
    /// Connecting failed; `error` says why.
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RemoteProgressStage {
    Downloading,
    Uploading,
}

/// How far an agent install has got.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteProgress {
    pub stage: RemoteProgressStage,
    pub percent: u8,
}

/// `remote-session-changed` payload.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSessionEvent {
    /// `ssh://[user@]host[:port]`, shared by every repository on the host.
    pub origin: String,
    pub state: RemoteSessionState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<RemoteProgress>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<CommandError>,
}

/// What `remote_connect` learned about the host.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteHost {
    pub origin: String,
    /// The connecting user's home directory, so the open dialog can offer it.
    pub home: Option<String>,
    /// The host's `git --version`.
    pub git: Option<String>,
}

/// What an `ssh` question asks for (remote-ssh-repos D4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SshPromptKind {
    /// Whether to trust a host key `ssh` hasn't seen before.
    HostKey,
    /// A password, key passphrase or one-time code: shown masked.
    Secret,
}

/// `ssh-prompt` payload: a question waiting on the user. Answered through
/// `answer_ssh_prompt` with the same `id`. Carries the question, never an
/// answer.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshPromptEvent {
    pub id: u64,
    /// `ssh://[user@]host[:port]` being connected to.
    pub origin: String,
    /// `ssh`'s own prompt text.
    pub prompt: String,
    pub kind: SshPromptKind,
}
