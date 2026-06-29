//! Configured git remotes for the Repository settings → Remotes panel.
//!
//! Pure libgit2 read of `.git/config` (no network). Each entry carries its
//! fetch and push URLs; provider classification of those URLs lives on the
//! frontend so it's shared with the add/edit validation.

use git2::string_array::StringArray;
use git2::Repository;

use crate::git::types::RemoteInfo;

/// List the repo's configured remotes with their fetch/push URLs, flagging the
/// default push remote.
pub fn list_remotes(path: &str) -> Result<Vec<RemoteInfo>, String> {
    let repo = Repository::discover(path).map_err(|e| e.to_string())?;
    let names = repo.remotes().map_err(|e| e.to_string())?;
    let default = default_remote(&repo, &names);

    let mut out = Vec::new();
    for i in 0..names.len() {
        let Ok(Some(name)) = names.get(i) else {
            continue;
        };
        let Ok(remote) = repo.find_remote(name) else {
            continue;
        };
        let fetch_url = remote.url().unwrap_or("").to_string();
        // pushurl falls back to the fetch URL when not separately configured.
        let push_url = remote
            .pushurl()
            .ok()
            .flatten()
            .or_else(|| remote.url().ok())
            .unwrap_or("")
            .to_string();
        out.push(RemoteInfo {
            name: name.to_string(),
            fetch_url,
            push_url,
            is_default: default.as_deref() == Some(name),
        });
    }
    Ok(out)
}

/// The default push remote: the current branch's upstream remote, else "origin"
/// if configured, else the first remote.
fn default_remote(repo: &Repository, names: &StringArray) -> Option<String> {
    if let Ok(head) = repo.head() {
        if let Ok(branch) = head.shorthand() {
            if let Ok(buf) = repo.branch_upstream_remote(&format!("refs/heads/{branch}")) {
                if let Ok(name) = std::str::from_utf8(&buf) {
                    if !name.is_empty() {
                        return Some(name.to_string());
                    }
                }
            }
        }
    }
    for i in 0..names.len() {
        if matches!(names.get(i), Ok(Some("origin"))) {
            return Some("origin".to_string());
        }
    }
    for i in 0..names.len() {
        if let Ok(Some(name)) = names.get(i) {
            return Some(name.to_string());
        }
    }
    None
}
