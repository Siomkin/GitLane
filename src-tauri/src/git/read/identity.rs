//! Repository-local commit identity reads.

use git2::{Config, ConfigLevel};

use crate::git::types::RepoIdentity;

use super::repo::open;

/// The default commit identity git falls back to when nothing is pinned in a
/// repo's local config — the resolved global / system / XDG config. Read from
/// libgit2's default config (no repo), so it mirrors `~/.gitconfig`. Powers the
/// "Default git identity" option in the Identity panel. `None` when the user has
/// no global name/email set. Signing fields are surfaced too so the default
/// option can show whether global config already signs.
pub fn default_identity() -> Option<RepoIdentity> {
    let cfg = Config::open_default().ok()?;
    let name = cfg.get_string("user.name").ok().filter(|s| !s.is_empty())?;
    let email = cfg
        .get_string("user.email")
        .ok()
        .filter(|s| !s.is_empty())?;
    let signing_key = cfg
        .get_string("user.signingkey")
        .ok()
        .filter(|s| !s.is_empty());
    let gpg_format = cfg.get_string("gpg.format").ok().filter(|s| !s.is_empty());
    let gpg_sign = cfg.get_bool("commit.gpgsign").ok();
    Some(RepoIdentity {
        name,
        email,
        signing_key,
        gpg_format,
        gpg_sign,
    })
}

/// The commit identity pinned in this repo's **local** git config.
///
/// We deliberately read the `Local` config level only (not the resolved
/// view that also includes global/system) so the result reflects what is
/// *pinned on this repo* — the same thing `set_repo_identity` writes via
/// `git config --local`. This is the durable, build-independent source of
/// truth the UI hydrates from on open, so a pinned identity survives a
/// restart regardless of which webview's `localStorage` is in play. Returns
/// `None` when no local identity is set (the repo defers to global config).
pub fn repo_identity(path: &str) -> Result<Option<RepoIdentity>, git2::Error> {
    let repo = open(path)?;
    let cfg = repo.config()?;
    // Every git repo has a local config file; if it can't be opened, treat the
    // repo as having no pinned identity rather than erroring.
    let Ok(local) = cfg.open_level(ConfigLevel::Local) else {
        return Ok(None);
    };
    let name = local.get_string("user.name").ok();
    let email = local.get_string("user.email").ok();
    match (name, email) {
        (Some(name), Some(email)) if !name.is_empty() && !email.is_empty() => {
            // Signing config is surfaced alongside a present identity so the UI
            // can show "this repo signs as <key>" and match it against a saved
            // profile. An empty value is treated as unset.
            let signing_key = local
                .get_string("user.signingkey")
                .ok()
                .filter(|s| !s.is_empty());
            let gpg_format = local
                .get_string("gpg.format")
                .ok()
                .filter(|s| !s.is_empty());
            let gpg_sign = local.get_bool("commit.gpgsign").ok();
            Ok(Some(RepoIdentity {
                name,
                email,
                signing_key,
                gpg_format,
                gpg_sign,
            }))
        }
        _ => Ok(None),
    }
}
