//! Repository-local commit identity reads.

use git2::ConfigLevel;

use crate::git::types::RepoIdentity;

use super::repo::open;

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
            Ok(Some(RepoIdentity { name, email }))
        }
        _ => Ok(None),
    }
}
