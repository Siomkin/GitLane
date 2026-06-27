//! Status of recently-opened repositories for the onboarding "Recent" list.
//!
//! Each entry is checked cheaply (no network): does the path still exist, and
//! what branch is currently checked out. A path that no longer resolves to a
//! repository is reported as not present so the UI can flag it "Missing" and
//! offer to relocate it (GL-38).

use git2::Repository;

use crate::git::types::RecentStatus;

/// Resolve presence + current branch for each recent path. Best-effort and
/// infallible per entry: a missing/unreadable path yields `exists: false` with
/// no branch rather than failing the whole call.
pub fn recents_status(paths: &[String]) -> Vec<RecentStatus> {
    paths
        .iter()
        .map(|path| {
            // "Present" means the path still resolves to a Git repository — a
            // directory that exists but is no longer a repo (e.g. `.git` removed)
            // is reported missing so the UI flags it, rather than letting the open
            // fail later on the global error bar.
            let repo = if std::path::Path::new(path).is_dir() {
                Repository::discover(path).ok()
            } else {
                None
            };
            let branch = repo.as_ref().and_then(|repo| {
                if repo.head_detached().unwrap_or(false) {
                    None
                } else {
                    repo.head()
                        .ok()
                        .and_then(|head| head.shorthand().ok().map(str::to_string))
                }
            });
            RecentStatus {
                path: path.clone(),
                exists: repo.is_some(),
                branch,
            }
        })
        .collect()
}
