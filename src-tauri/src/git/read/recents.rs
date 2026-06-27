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
            // A directory that still exists on disk. Opening the repo can fail
            // independently (e.g. mid-clone), so presence keys off the path.
            let exists = std::path::Path::new(path).is_dir();
            let branch = if exists {
                Repository::discover(path).ok().and_then(|repo| {
                    if repo.head_detached().unwrap_or(false) {
                        None
                    } else {
                        repo.head()
                            .ok()
                            .and_then(|head| head.shorthand().ok().map(str::to_string))
                    }
                })
            } else {
                None
            };
            RecentStatus {
                path: path.clone(),
                exists,
                branch,
            }
        })
        .collect()
}
