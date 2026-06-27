//! Repository opening, summary, and graph entry points.

use git2::Repository;

use crate::git::graph;
use crate::git::types::{RepoGraph, RepoSummary};

/// Open the repository containing `path` (searches upward for `.git`).
pub fn open(path: &str) -> Result<Repository, git2::Error> {
    Repository::discover(path)
}

/// High-level state for the title bar / status area.
pub fn summary(path: &str) -> Result<RepoSummary, git2::Error> {
    let repo = open(path)?;
    let detached = repo.head_detached().unwrap_or(false);

    let head = repo.head().ok();
    let head_branch = if detached {
        None
    } else {
        head.as_ref()
            .and_then(|h| h.shorthand().ok())
            .map(|s| s.to_string())
    };
    let head_oid = head
        .and_then(|h| h.peel_to_commit().ok())
        .map(|c| c.id().to_string());

    Ok(RepoSummary {
        // Prefer the worktree root as the canonical path (correct for linked
        // worktrees and immune to repeated "/.git/" patterns); fall back to the
        // gitdir for a bare repo.
        path: repo
            .workdir()
            .and_then(|p| p.to_str())
            .map(|s| s.trim_end_matches('/').to_string())
            .unwrap_or_else(|| repo.path().to_str().unwrap_or(path).to_string()),
        workdir: repo.workdir().and_then(|p| p.to_str()).map(String::from),
        head_branch,
        head_oid,
        detached,
    })
}

/// Build the laid-out commit graph (delegates to [`graph::build`]).
pub fn commit_graph(path: &str, limit: usize) -> Result<RepoGraph, git2::Error> {
    let repo = open(path)?;
    graph::build(&repo, limit)
}
