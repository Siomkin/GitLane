//! Status of recently-opened repositories for the onboarding "Recent" list.
//!
//! Each entry is checked cheaply (no network): does the path still exist, and
//! what branch is currently checked out. A path that no longer resolves to a
//! repository is reported as not present so the UI can flag it "Missing" and
//! offer to relocate it (GL-38).

use git2::Repository;

use crate::git::types::RecentStatus;

use super::repo::main_worktree_path;

/// Resolve presence + current branch for each recent path. Best-effort and
/// infallible per entry: a missing/unreadable path yields `exists: false` with
/// no branch rather than failing the whole call. The tab strip shares this
/// probe for session restore + worktree-tab labeling (GL-109/GL-110), so each
/// entry also reports whether it is a linked worktree and of which repository.
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
                is_worktree: repo.as_ref().is_some_and(|r| r.is_worktree()),
                main_path: repo.as_ref().and_then(main_worktree_path),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::recents_status;

    #[test]
    fn plain_dir_and_missing_path_are_not_present() {
        let base = std::env::temp_dir().join(format!("gitlane-recents-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let plain = base.join("not-a-repo");
        std::fs::create_dir_all(&plain).expect("create temp dir");
        let missing = base.join("gone");

        let statuses = recents_status(&[
            plain.to_string_lossy().into_owned(),
            missing.to_string_lossy().into_owned(),
        ]);

        // A directory that exists but is not a Git repo is reported missing (so
        // the UI flags it rather than offering to open it).
        assert!(!statuses[0].exists, "a non-repo directory is not present");
        assert_eq!(statuses[0].branch, None);
        // A path that no longer exists at all is missing too.
        assert!(!statuses[1].exists, "a missing path is not present");
        assert_eq!(statuses[1].branch, None);

        let _ = std::fs::remove_dir_all(&base);
    }
}
