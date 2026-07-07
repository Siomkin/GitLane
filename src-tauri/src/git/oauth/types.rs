//! Non-secret types shared across the OAuth module and the IPC boundary (GL-139).
//!
//! Nothing here ever carries token material, a device code, a PKCE verifier, or
//! an authorization code. The access token lives only inside the module and is
//! handed straight to the OS keychain ([`crate::secrets`]); what crosses IPC is
//! account metadata and progress milestones.

use serde::Serialize;

/// Result of a completed native OAuth sign-in, returned across IPC.
///
/// `transport_username` is the git HTTPS username an OAuth *access* token
/// authenticates as — `oauth2` for GitLab, `x-token-auth` for Bitbucket — which
/// is not the human `login`. The keychain entry is keyed by the stable
/// `account_id`, never by the username.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderOauthResult {
    pub provider: String,
    pub host: String,
    pub account_id: String,
    pub login: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub transport_username: String,
    /// Always true on success — the token is in the keychain. The token value
    /// itself is never present in this struct.
    pub has_token: bool,
}

/// One progress milestone streamed to the webview as a `provider-oauth-progress`
/// event. Carries only display-safe fields (the *user* code is meant to be shown;
/// the *device* code — the secret half — is never emitted).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderOauthProgress {
    pub provider: String,
    /// `"device_code"` | `"browser"` | `"polling"` | `"waiting"` |
    /// `"authorized"` | `"storing"`.
    pub step: String,
    /// The short human code the user types on the verification page (device flow).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_code: Option<String>,
    /// The URL the frontend should open (verification URI for device flow, the
    /// authorize URL for PKCE). Opened through the app's audited external gate.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verification_uri: Option<String>,
    /// Seconds until the device/authorization code expires, for a countdown.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_in_secs: Option<u64>,
}

/// Whether native OAuth is configured for a provider/host, and where its public
/// client id comes from. Non-secret — a client id is a public identifier, and
/// this reports only presence + source, never the id itself.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OauthClientStatus {
    pub provider: String,
    pub host: String,
    /// True when a client id resolves for this provider/host (built-in or override).
    pub configured: bool,
    /// `"builtin"` | `"override"` | `"none"`.
    pub source: String,
    /// Whether GitLane implements native OAuth for this provider at all.
    pub supported: bool,
}
