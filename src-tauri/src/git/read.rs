//! Read-only repository access via libgit2 (`git2`).
//!
//! All functions take a filesystem path and open the repo fresh. `git2`
//! `Repository` handles are not `Send`, so we never hold one across the async
//! Tauri command boundary — open, read, drop.

use git2::{BranchType, ConfigLevel, Repository};

use super::graph;
use super::types::{BranchInfo, RepoGraph, RepoIdentity, RepoSummary};

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

/// True when fast-forwarding `to` to `from` is possible — i.e. `from` is a
/// strict descendant of `to`, so `to`'s pointer can move forward with no merge
/// commit. Both args are anything `revparse` accepts (branch, remote, oid).
pub fn can_fast_forward(path: &str, from: &str, to: &str) -> Result<bool, git2::Error> {
    let repo = open(path)?;
    let from_oid = repo.revparse_single(from)?.peel_to_commit()?.id();
    let to_oid = repo.revparse_single(to)?.peel_to_commit()?.id();
    repo.graph_descendant_of(from_oid, to_oid)
}

/// Local + remote branches for the sidebar.
pub fn branches(path: &str) -> Result<Vec<BranchInfo>, git2::Error> {
    let repo = open(path)?;
    let mut out = Vec::new();

    for (kind, label) in [(BranchType::Local, "local"), (BranchType::Remote, "remote")] {
        for entry in repo.branches(Some(kind))? {
            let (branch, _) = entry?;
            let name = match branch.name() {
                Ok(Some(n)) => n.to_string(),
                _ => continue,
            };
            if name.ends_with("/HEAD") {
                continue; // skip the remote's symbolic HEAD pointer
            }
            let target = branch
                .get()
                .peel_to_commit()
                .ok()
                .map(|c| c.id().to_string());
            let upstream = branch
                .upstream()
                .ok()
                .and_then(|u| u.name().ok().flatten().map(String::from));

            out.push(BranchInfo {
                name,
                kind: label.to_string(),
                target,
                is_head: branch.is_head(),
                upstream,
            });
        }
    }

    Ok(out)
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
            Ok(Some(RepoIdentity { name, email }))
        }
        _ => Ok(None),
    }
}
