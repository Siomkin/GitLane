//! Repository identity: the open-repo summary, open failures, recents, detected
//! forge, remotes, and the commit identity applied to a repo.

use serde::{Deserialize, Serialize};

/// High-level repository state shown in the title bar / status area.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoSummary {
    pub path: String,
    pub workdir: Option<String>,
    pub head_branch: Option<String>,
    pub head_oid: Option<String>,
    /// True when HEAD is detached (not on a branch).
    pub detached: bool,
    /// True when HEAD is unborn (fresh `git init`, no commits yet) — a real
    /// state, distinct from a read failure, so the UI can say "No commits yet"
    /// (GL-115).
    pub unborn: bool,
    /// True when this checkout is a *linked* worktree (not the main one).
    pub is_worktree: bool,
    /// The main checkout's path for a linked worktree — the stable repository
    /// identity that tab grouping and per-repo state key on (GL-109/GL-110).
    /// None for the main worktree itself (its own `path` is the identity).
    pub main_path: Option<String>,
}

/// Why `open_repo` failed, classified so the frontend can give a moved/deleted
/// repository its dedicated missing-repo state instead of the raw libgit2
/// message (GL-108). This is the one command with a structured IPC error —
/// everything else stays `Result<T, String>` (architecture-rules-rust §4); the
/// classification has to happen in Rust because only this side can distinguish
/// "path gone" from "not a repo" without matching on libgit2 message strings.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoOpenError {
    pub kind: RepoOpenErrorKind,
    /// Human-readable message (no libgit2 class/code jargon) for the error bar
    /// fallback when the failure isn't the missing-repo kind.
    pub message: String,
    /// The path the open was attempted with, echoed back for the missing state.
    pub path: String,
}

/// Classification of an [`RepoOpenError`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RepoOpenErrorKind {
    /// The path no longer exists on disk — moved, deleted, or on an unmounted
    /// volume (so a retry after re-mounting is a real recovery path).
    Missing,
    /// The path exists but no longer resolves to a git repository.
    NotARepository,
    /// Any other open failure (permissions, corruption, …) — error-bar material.
    Other,
}

/// Presence + current branch of a previously-opened repository path, for the
/// onboarding "Recent" list and the tab strip's session-restore probe
/// (GL-109/GL-110 share this shape). `exists: false` flags a path that no
/// longer resolves on disk so the UI can mark it "Missing" / drop the tab.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentStatus {
    pub path: String,
    pub exists: bool,
    /// Currently checked-out branch (short name), or None when detached / gone.
    pub branch: Option<String>,
    /// True when the path is a *linked* worktree of some repository.
    pub is_worktree: bool,
    /// The main checkout's path when `is_worktree` (see [`RepoSummary`]).
    pub main_path: Option<String>,
}

/// Remote-forge summary for the toolbar provider indicator. Pure libgit2
/// detection from the configured remote URLs — no network or auth probing.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoForge {
    /// True when the repo has at least one remote with a non-empty URL.
    pub has_remote: bool,
    /// Lowercase forge key ("github", "gitlab", …). None when there is no
    /// remote or the host is not a recognised forge.
    pub kind: Option<String>,
    /// Human-readable forge label ("GitHub", "GitLab", …). None when unclassified.
    pub forge: Option<String>,
    /// Remote host (e.g. "github.com"). None when no remote URL is configured.
    pub host: Option<String>,
    /// Browser URL for the repo (`https://host/owner/repo`), derived from the
    /// remote URL. None when no path can be parsed (e.g. no remote).
    pub web_url: Option<String>,
}

/// A single configured git remote, for the Repository settings → Remotes panel.
/// Pure libgit2 read of `.git/config`; provider classification of the URL is
/// done on the frontend (shared with the add/edit validation).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteInfo {
    /// Remote name (e.g. "origin").
    pub name: String,
    /// Fetch URL.
    pub fetch_url: String,
    /// Push URL — equals the fetch URL unless a separate `pushurl` is set.
    pub push_url: String,
    /// True for the repo's default push remote (the current branch's upstream
    /// remote, else "origin", else the first remote).
    pub is_default: bool,
}

/// The commit identity pinned in a repo's *local* git config (`user.name` /
/// `user.email`). `None` from the read side means nothing is pinned locally and
/// the repo defers to global git config.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoIdentity {
    pub name: String,
    pub email: String,
    /// `user.signingkey` pinned locally — a GPG key id or an SSH key path /
    /// literal. The passphrase / private key never lives here: only the
    /// reference, unlocked at use time by ssh-agent / gpg-agent / the OS
    /// keychain. Omitted from JSON when unset.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signing_key: Option<String>,
    /// `gpg.format` — "openpgp" or "ssh" — pinned locally, if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gpg_format: Option<String>,
    /// `commit.gpgsign` pinned locally, if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gpg_sign: Option<bool>,
    /// `tag.gpgsign` pinned locally, if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tag_gpg_sign: Option<bool>,
}

/// The repo-identity snapshot a commit-creating write was composed against —
/// crosses IPC in place of the former `identity` + `identityCaptured` pair, so
/// "did not read the identity" (NotCaptured) and "read it; the repo had none"
/// (CapturedNone) are distinct variants rather than a representable-invalid
/// `captured: false` + `identity: Some(card)` combination. The per-commit
/// author pin (`name`/`email`) is a separate, independent argument.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum CapturedIdentity {
    /// The composer had not read the repo identity when the write was queued.
    NotCaptured,
    /// The repo had no identity card when the write was composed — "this
    /// computer". A card landing afterwards still fails closed.
    CapturedNone,
    /// The repo had this card. Any field changing before the write runs fails
    /// closed.
    Card { identity: RepoIdentity },
}

/// A signing key the user already has, offered by the profile editor's key
/// picker. References only — a full GPG fingerprint or an SSH public-key path —
/// never private key material or a passphrase.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SigningKey {
    /// The value written to `user.signingkey`: a full GPG fingerprint, or an SSH
    /// public-key path.
    pub value: String,
    /// Human-readable label — the GPG uid, or the SSH key type + comment.
    pub label: String,
    /// `gpg.format` for this key: "openpgp" or "ssh".
    pub format: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn captured_identity_deserializes_the_wire_shapes() {
        // The inbound IPC payload replacing the former identity +
        // identityCaptured pair; each variant's exact JSON is pinned so the
        // frontend helper and this enum cannot drift apart.
        assert_eq!(
            serde_json::from_value::<CapturedIdentity>(serde_json::json!({"mode": "notCaptured"}))
                .unwrap(),
            CapturedIdentity::NotCaptured
        );
        assert_eq!(
            serde_json::from_value::<CapturedIdentity>(serde_json::json!({"mode": "capturedNone"}))
                .unwrap(),
            CapturedIdentity::CapturedNone
        );
        assert_eq!(
            serde_json::from_value::<CapturedIdentity>(serde_json::json!({
                "mode": "card",
                "identity": {"name": "Ada", "email": "ada@example.test"}
            }))
            .unwrap(),
            CapturedIdentity::Card {
                identity: RepoIdentity {
                    name: "Ada".to_string(),
                    email: "ada@example.test".to_string(),
                    signing_key: None,
                    gpg_format: None,
                    gpg_sign: None,
                    tag_gpg_sign: None,
                }
            }
        );
    }

    #[test]
    fn captured_identity_rejects_the_legacy_flat_shape() {
        // The old wire sent bare identity/identityCaptured keys — including
        // the contradictory "not captured" + card combination that routed
        // through the weaker stale-card guard. Without a `mode` tag those
        // payloads now fail to deserialize instead of silently degrading.
        assert!(
            serde_json::from_value::<CapturedIdentity>(serde_json::json!({
                "identity": {"name": "Ada", "email": "ada@example.test"},
                "identityCaptured": false
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<CapturedIdentity>(serde_json::json!({
                "identity": null,
                "identityCaptured": true
            }))
            .is_err()
        );
    }
}
