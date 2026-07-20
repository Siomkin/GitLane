//! Configured git remotes for the Repository settings → Remotes panel.
//!
//! Pure libgit2 read of `.git/config` (no network). Each entry carries its
//! fetch and push URLs; provider classification of those URLs lives on the
//! frontend so it's shared with the add/edit validation.

use git2::Repository;

use crate::git::forge;
use crate::git::types::RemoteInfo;

/// List the repo's configured remotes with their fetch/push URLs, flagging the
/// default push remote.
pub fn list_remotes(path: &str) -> Result<Vec<RemoteInfo>, String> {
    let repo = Repository::discover(path).map_err(|e| e.to_string())?;
    let names = repo.remotes().map_err(|e| e.to_string())?;
    // Shared with the toolbar provider detection so both agree on "default".
    let default = forge::default_remote_name(&repo);

    let mut out = Vec::new();
    for i in 0..names.len() {
        let Ok(Some(name)) = names.get(i) else {
            continue;
        };
        let Ok(remote) = repo.find_remote(name) else {
            continue;
        };
        // A remote may have been configured outside GitLane with a legacy
        // password-bearing URL. Never let that secret cross the read IPC
        // boundary; the redacted form remains visibly invalid in the editor so
        // the user can replace it with helper/keychain authentication.
        let fetch_url = crate::redact::redact_secrets(remote.url().unwrap_or(""));
        // pushurl falls back to the fetch URL when not separately configured.
        let push_url = crate::redact::redact_secrets(
            remote
                .pushurl()
                .ok()
                .flatten()
                .or_else(|| remote.url().ok())
                .unwrap_or(""),
        );
        out.push(RemoteInfo {
            name: name.to_string(),
            fetch_url,
            push_url,
            is_default: default.as_deref() == Some(name),
        });
    }
    Ok(out)
}
