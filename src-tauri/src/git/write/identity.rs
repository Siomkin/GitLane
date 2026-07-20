//! Local repository identity configuration.

use std::sync::{Mutex, MutexGuard};

use super::cli::{run_git, run_git_allow_exit_codes};

// A profile apply spans several real-git commands. Tauri may execute two IPC
// calls concurrently, so hold one process-local lock across the whole tuple;
// otherwise name/email/signing fields from different cards can interleave.
static IDENTITY_WRITE_LOCK: Mutex<()> = Mutex::new(());

/// Serialize identity config mutations with every operation that may create a
/// commit or signed tag. Callers hold this guard from the config snapshot
/// through the git subprocess so a profile apply cannot interleave between
/// those two steps.
pub(super) fn lock_identity_config() -> Result<MutexGuard<'static, ()>, String> {
    // The protected value carries no recoverable state: Git config is the
    // source of truth and each caller re-reads it after locking. Preserve
    // serialization after a panic instead of bricking identity-aware writes
    // for the rest of the process lifetime.
    Ok(IDENTITY_WRITE_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner))
}

#[derive(Clone, Copy)]
pub(super) enum SigningOperation {
    Commit,
    Tag,
}

/// `git config --worktree` outranks the shared local config where identity
/// cards are stored. Build command-scoped `-c` overrides from the pinned card
/// so a linked worktree cannot silently change its key/format/signing policy.
/// For commit operations, only use signing fields when the caller's captured
/// author still matches the same local identity; this avoids combining a stale
/// author snapshot with signing settings from a newly edited card.
pub(super) fn pinned_signing_args(
    repo: &str,
    expected_author: Option<(&str, &str)>,
    expected_identity: Option<&crate::git::types::RepoIdentity>,
    identity_captured: bool,
    operation: SigningOperation,
) -> Result<Vec<String>, String> {
    let identity = crate::git::read::repo_identity(repo)
        .map_err(|error| format!("Failed to read the repository identity: {error}"))?;
    if identity_captured && identity.as_ref() != expected_identity {
        return Err(
            "The repository identity changed before this operation. Refresh and try again.".into(),
        );
    }
    let Some(identity) = identity else {
        if !identity_captured && (expected_author.is_some() || expected_identity.is_some()) {
            return Err(
                "The repository identity changed before this operation. Refresh and try again."
                    .into(),
            );
        }
        return Ok(Vec::new());
    };
    if (!identity_captured && expected_identity.is_some_and(|expected| expected != &identity))
        || expected_author
            .is_some_and(|(name, email)| identity.name != name || identity.email != email)
    {
        return Err(
            "The repository identity changed before this operation. Refresh and try again.".into(),
        );
    }

    Ok(signing_args(identity, operation))
}

/// Full card identity for Git operations that can create commits without a
/// dedicated author IPC payload (merge/rebase/cherry-pick/revert). Empty when
/// the repository intentionally defers to its contextual Git configuration.
pub(super) fn pinned_commit_args(repo: &str) -> Result<Vec<String>, String> {
    let Some(identity) = crate::git::read::repo_identity(repo)
        .map_err(|error| format!("Failed to read the repository identity: {error}"))?
    else {
        return Ok(Vec::new());
    };
    let mut args = vec![
        "-c".to_string(),
        format!("user.name={}", identity.name),
        "-c".to_string(),
        format!("user.email={}", identity.email),
    ];
    args.extend(signing_args(identity, SigningOperation::Commit));
    Ok(args)
}

/// Full selected-card identity for annotated tags. Tagger name/email are just
/// as identity-sensitive as signing policy and must also override a linked
/// worktree's higher-precedence config.
pub(super) fn pinned_tag_args(repo: &str) -> Result<Vec<String>, String> {
    let Some(identity) = crate::git::read::repo_identity(repo)
        .map_err(|error| format!("Failed to read the repository identity: {error}"))?
    else {
        return Ok(Vec::new());
    };
    let mut args = vec![
        "-c".to_string(),
        format!("user.name={}", identity.name),
        "-c".to_string(),
        format!("user.email={}", identity.email),
    ];
    args.extend(signing_args(identity, SigningOperation::Tag));
    Ok(args)
}

fn signing_args(
    identity: crate::git::types::RepoIdentity,
    operation: SigningOperation,
) -> Vec<String> {
    let mut args = Vec::new();
    let mut push = |key: &str, value: String| {
        args.push("-c".to_string());
        args.push(format!("{key}={value}"));
    };
    if let Some(key) = identity.signing_key {
        push("user.signingkey", key);
    }
    if let Some(format) = identity.gpg_format {
        push("gpg.format", format);
    }
    let enabled = match operation {
        SigningOperation::Commit => identity.gpg_sign,
        SigningOperation::Tag => identity.tag_gpg_sign,
    };
    if let Some(enabled) = enabled {
        push(
            match operation {
                SigningOperation::Commit => "commit.gpgsign",
                SigningOperation::Tag => "tag.gpgsign",
            },
            enabled.to_string(),
        );
    }
    args
}

/// Bind a repo's commit identity by writing `user.name`/`user.email` (and, when
/// provided, signing config) into its local git config, so commits are authored
/// — and optionally signed — as the associated profile/account.
///
/// Signing fields are **tri-state** so the same command serves both the legacy
/// name/email editor and a full profile apply:
/// - `None` leaves the existing local key untouched (a plain name/email save
///   never disturbs signing the user set elsewhere).
/// - `Some("")` unsets the key (switching to a profile that doesn't sign).
/// - `Some(value)` writes the key.
///
/// Only the signing *reference* (GPG key id / SSH key path) is ever stored —
/// never a passphrase or private key.
pub fn set_repo_identity(
    repo: &str,
    name: &str,
    email: &str,
    signing_key: Option<&str>,
    gpg_format: Option<&str>,
    gpg_sign: Option<bool>,
    tag_gpg_sign: Option<bool>,
) -> Result<String, String> {
    let _guard = lock_identity_config()?;
    // No ordering makes a six-command tuple atomic: each `git config` takes
    // `.git/config.lock` on its own, so a competing git process can fail any
    // step. A half-applied switch from card A to card B can pair B's name/email
    // with A's signing key (wrong signer) or B's name with A's email (wrong
    // author), so snapshot the whole tuple first and roll the *entire* tuple
    // back on any failure. Rollback restores the prior state rather than
    // clearing it: a failed save must not silently unpin a working identity.
    let previous = IDENTITY_KEYS.map(|key| (key, read_local(repo, key)));
    let applied = (|| {
        replace_value(repo, "user.name", name)?;
        replace_value(repo, "user.email", email)?;
        apply_optional(repo, "user.signingkey", signing_key)?;
        apply_optional(repo, "gpg.format", gpg_format)?;
        apply_optional(repo, "commit.gpgsign", bool_arg(gpg_sign))?;
        apply_optional(repo, "tag.gpgsign", bool_arg(tag_gpg_sign))
    })();
    if let Err(error) = applied {
        // Best effort: config writes are already failing, so a failure here
        // cannot be repaired automatically. The original cause is what the user
        // needs to see, so rollback errors are deliberately swallowed.
        for (key, value) in &previous {
            let _ = match value {
                Some(value) => replace_value(repo, key, value),
                None => unset_value(repo, key),
            };
        }
        return Err(error);
    }
    Ok(format!("Identity set to {name} <{email}>"))
}

/// Every local config key an identity card owns. Ordered so that a *forward*
/// walk retires signing before author fields — see `clear_repo_identity`.
const IDENTITY_KEYS: [&str; 6] = [
    "commit.gpgsign",
    "tag.gpgsign",
    "user.signingkey",
    "gpg.format",
    "user.name",
    "user.email",
];

/// The current local value of `key`, or `None` when unset. `git config --get`
/// exits 1 for a missing key, which is a normal answer rather than a failure.
fn read_local(repo: &str, key: &str) -> Option<String> {
    let value = run_git_allow_exit_codes(repo, &["config", "--local", "--get", key], &[1]).ok()?;
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

fn bool_arg(value: Option<bool>) -> Option<&'static str> {
    value.map(|on| if on { "true" } else { "false" })
}

fn replace_value(repo: &str, key: &str, value: &str) -> Result<(), String> {
    run_git(repo, &["config", "--local", "--replace-all", key, value]).map(|_| ())
}

fn unset_value(repo: &str, key: &str) -> Result<(), String> {
    // `git config --unset-all` exits 5 only when no matching key exists. That
    // is the one non-zero result that already represents the requested state;
    // permissions, malformed config, and every other failure must propagate.
    run_git_allow_exit_codes(repo, &["config", "--local", "--unset-all", key], &[5]).map(|_| ())
}

/// Tri-state local config write: `None` leaves the key untouched, `Some("")`
/// unsets it, `Some(value)` replaces every local value. An already-absent key
/// is accepted; every other unset failure is surfaced.
fn apply_optional(repo: &str, key: &str, value: Option<&str>) -> Result<(), String> {
    match value {
        None => {}
        Some("") => {
            unset_value(repo, key)?;
        }
        Some(v) => {
            replace_value(repo, key, v)?;
        }
    }
    Ok(())
}

/// Remove the pinned commit identity — name, email, and any signing config —
/// from a repo's local git config so it defers to global config again (the
/// "default git identity" / "No identity" choice). Already-absent keys are an
/// idempotent success; real config/permission failures are surfaced.
pub fn clear_repo_identity(repo: &str) -> Result<String, String> {
    let _guard = lock_identity_config()?;
    // Order matters. Each `git config` call takes `.git/config.lock`
    // independently, so an external git process (or a permission error) can
    // fail the tuple partway through. `repo_identity` reports "no identity"
    // whenever name/email are absent *regardless of leftover signing keys*, so
    // a clear that dropped name/email first but failed before the signing keys
    // would leave the repo silently committing as the global identity while
    // still signing with the removed card's key — the exact wrong-key outcome
    // the pinned-signing checks exist to prevent. Retiring the signing tuple
    // first makes any torn clear fail toward *unsigned*, never toward
    // *signed as someone else*.
    for key in IDENTITY_KEYS {
        unset_value(repo, key)?;
    }
    Ok("Identity cleared".into())
}

#[cfg(test)]
mod tests {
    use super::lock_identity_config;

    #[test]
    fn identity_lock_recovers_after_poisoning() {
        let panic = std::thread::spawn(|| {
            let _guard = lock_identity_config().expect("identity lock should be available");
            panic!("poison the identity lock");
        })
        .join();

        assert!(panic.is_err());
        assert!(lock_identity_config().is_ok());
    }
}
