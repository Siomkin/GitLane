//! Local repository identity configuration.

use super::cli::run_git;

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
    run_git(repo, &["config", "--local", "user.name", name])?;
    run_git(repo, &["config", "--local", "user.email", email])?;
    apply_optional(repo, "user.signingkey", signing_key)?;
    apply_optional(repo, "gpg.format", gpg_format)?;
    apply_optional(repo, "commit.gpgsign", bool_arg(gpg_sign))?;
    apply_optional(repo, "tag.gpgsign", bool_arg(tag_gpg_sign))?;
    Ok(format!("Identity set to {name} <{email}>"))
}

fn bool_arg(value: Option<bool>) -> Option<&'static str> {
    value.map(|on| if on { "true" } else { "false" })
}

/// Tri-state local config write: `None` leaves the key untouched, `Some("")`
/// unsets it, `Some(value)` sets it. Unset is best-effort — `--unset` on an
/// already-absent key exits non-zero, which is the desired end state.
fn apply_optional(repo: &str, key: &str, value: Option<&str>) -> Result<(), String> {
    match value {
        None => {}
        Some("") => {
            let _ = run_git(repo, &["config", "--local", "--unset", key]);
        }
        Some(v) => {
            run_git(repo, &["config", "--local", key, v])?;
        }
    }
    Ok(())
}

/// Remove the pinned commit identity — name, email, and any signing config —
/// from a repo's local git config so it defers to global config again (the
/// "default git identity" / "No identity" choice). Best-effort: `--unset` on an
/// already-absent key exits non-zero, which is the desired end state, so unset
/// failures aren't surfaced as errors.
pub fn clear_repo_identity(repo: &str) -> Result<String, String> {
    for key in [
        "user.name",
        "user.email",
        "user.signingkey",
        "gpg.format",
        "commit.gpgsign",
        "tag.gpgsign",
    ] {
        let _ = run_git(repo, &["config", "--local", "--unset", key]);
    }
    Ok("Identity cleared".into())
}
