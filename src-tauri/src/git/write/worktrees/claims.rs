//! Whether a branch is in use by some worktree, counted the way git's own
//! `branch_checked_out` counts it. `git worktree list` only reports a worktree
//! whose HEAD is on the branch; a worktree paused in a rebase or bisect of that
//! branch is listed as detached, yet git still refuses to check the branch out
//! anywhere else. Any write that moves a branch ref must refuse in exactly the
//! cases git refuses, or it moves a branch out from under that operation.

use std::path::{Path, PathBuf};

use crate::git::types::WorktreeInfo;

/// How a worktree is holding a branch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::git::write) enum ClaimKind {
    CheckedOut,
    Rebasing,
    Bisecting,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::git::write) struct BranchClaim {
    pub path: String,
    pub kind: ClaimKind,
}

impl BranchClaim {
    /// User-facing description, e.g. "being rebased in the worktree at /x".
    pub fn describe(&self) -> String {
        let how = match self.kind {
            ClaimKind::CheckedOut => "checked out",
            ClaimKind::Rebasing => "being rebased",
            ClaimKind::Bisecting => "being bisected",
        };
        format!("{how} in the worktree at {}", self.path)
    }
}

/// The first worktree of `repo` that holds `branch`, from the porcelain
/// `listed` entries plus each worktree's rebase/bisect state. Prunable
/// worktrees count (git still refuses their branches); a bare main entry does
/// not (it has no HEAD to hold a branch with).
pub(in crate::git::write) fn branch_claim(
    repo: &str,
    branch: &str,
    listed: &[WorktreeInfo],
) -> Result<Option<BranchClaim>, String> {
    if let Some(wt) = listed
        .iter()
        .find(|wt| !wt.bare && wt.branch.as_deref() == Some(branch))
    {
        return Ok(Some(BranchClaim {
            path: wt.path.clone(),
            kind: ClaimKind::CheckedOut,
        }));
    }
    let common = git2::Repository::discover(repo)
        .map_err(|error| format!("Cannot open {repo}: {}", error.message()))?
        .commondir()
        .to_path_buf();
    for (admin, path) in admin_dirs(&common, listed) {
        if let Some(kind) = operation_claim(&admin, branch) {
            return Ok(Some(BranchClaim { path, kind }));
        }
    }
    Ok(None)
}

/// Refuse `action` ("delete", "squash") while any worktree holds `branch`.
pub(in crate::git::write) fn ensure_branch_unclaimed(
    repo: &str,
    branch: &str,
    action: &str,
) -> Result<(), String> {
    refuse_claim(repo, branch, action, &super::list::worktrees(repo)?)
}

/// Before removing the worktree at `source`: a claim held anywhere else would
/// refuse the deletion only after the worktree was already gone.
pub(super) fn ensure_unclaimed_elsewhere(
    repo: &str,
    branch: &str,
    source: &str,
) -> Result<(), String> {
    let mut others = super::list::worktrees(repo)?;
    others.retain(|worktree| !super::paths::same_path(&worktree.path, source));
    refuse_claim(repo, branch, "delete", &others)
}

fn refuse_claim(
    repo: &str,
    branch: &str,
    action: &str,
    listed: &[WorktreeInfo],
) -> Result<(), String> {
    match branch_claim(repo, branch, listed)? {
        Some(claim) => Err(format!(
            "Cannot {action} branch {branch}: it is {}.",
            claim.describe()
        )),
        None => Ok(()),
    }
}

/// Each non-bare worktree's admin dir paired with its working-tree path: the
/// common dir for the main worktree, `<common>/worktrees/<id>` for linked ones
/// (whose `gitdir` file names `<path>/.git`).
fn admin_dirs(common: &Path, listed: &[WorktreeInfo]) -> Vec<(PathBuf, String)> {
    let mut dirs = Vec::new();
    if let Some(main) = listed.iter().find(|wt| wt.is_main && !wt.bare) {
        dirs.push((common.to_path_buf(), main.path.clone()));
    }
    let Ok(entries) = std::fs::read_dir(common.join("worktrees")) else {
        return dirs;
    };
    for entry in entries.flatten() {
        let admin = entry.path();
        let Ok(gitdir) = std::fs::read_to_string(admin.join("gitdir")) else {
            continue;
        };
        let gitdir = gitdir.trim();
        let path = gitdir.strip_suffix("/.git").unwrap_or(gitdir);
        let path = if Path::new(path).is_relative() {
            // `worktree.useRelativePaths`: relative to the admin dir.
            let joined = admin.join(path);
            joined
                .canonicalize()
                .unwrap_or(joined)
                .to_string_lossy()
                .into_owned()
        } else {
            path.to_string()
        };
        dirs.push((admin, path));
    }
    dirs
}

/// A rebase (`rebase-merge` / `rebase-apply` head-name, or a ref queued by
/// `--update-refs`) or a bisect started from `branch`, in one admin dir.
fn operation_claim(admin: &Path, branch: &str) -> Option<ClaimKind> {
    let full = format!("refs/heads/{branch}");
    let read = |rel: &str| std::fs::read_to_string(admin.join(rel)).ok();
    for state in ["rebase-merge", "rebase-apply"] {
        if read(&format!("{state}/head-name")).is_some_and(|name| name.trim() == full) {
            return Some(ClaimKind::Rebasing);
        }
    }
    if read("rebase-merge/update-refs").is_some_and(|refs| refs.lines().any(|l| l.trim() == full)) {
        return Some(ClaimKind::Rebasing);
    }
    if read("BISECT_START").is_some_and(|start| {
        let start = start.trim();
        start == branch || start == full
    }) {
        return Some(ClaimKind::Bisecting);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_relative_gitdir_resolves_to_a_full_worktree_path() {
        let root = std::env::temp_dir().join(format!("gitlane-claims-{}", std::process::id()));
        let common = root.join(".git");
        let admin = common.join("worktrees/linked");
        let linked = root.join("linked");
        std::fs::create_dir_all(&admin).unwrap();
        std::fs::create_dir_all(&linked).unwrap();
        std::fs::write(admin.join("gitdir"), "../../../linked/.git\n").unwrap();

        let dirs = admin_dirs(&common, &[]);

        let expected = linked.canonicalize().unwrap();
        let _ = std::fs::remove_dir_all(&root);
        assert_eq!(dirs, [(admin, expected.to_string_lossy().into_owned())]);
    }
}
