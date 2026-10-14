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
    let common = git2::Repository::open(repo)
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
        let path = gitdir.strip_suffix("/.git").unwrap_or(gitdir).to_string();
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
