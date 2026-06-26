//! Read-only repository access via libgit2 (`git2`).
//!
//! All functions take a filesystem path and open the repo fresh. `git2`
//! `Repository` handles are not `Send`, so we never hold one across the async
//! Tauri command boundary — open, read, drop.

use git2::{Branch, BranchType, ConfigLevel, Repository};

use super::graph;
use super::types::{BranchInfo, BranchSyncState, RepoGraph, RepoIdentity, RepoSummary};

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
    let has_remote = !repo.remotes()?.is_empty();

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
            let configured_upstream = configured_upstream(&repo, &name);
            let upstream_branch = branch.upstream().ok();
            let resolved_upstream = upstream_branch
                .as_ref()
                .and_then(|u| u.name().ok().flatten().map(String::from));
            let upstream = resolved_upstream.or(configured_upstream);
            let sync = if kind == BranchType::Local {
                Some(branch_sync_state(
                    &repo,
                    &branch,
                    upstream_branch.as_ref(),
                    upstream.clone(),
                    has_remote,
                ))
            } else {
                None
            };

            out.push(BranchInfo {
                name,
                kind: label.to_string(),
                target,
                is_head: branch.is_head(),
                upstream,
                sync,
            });
        }
    }

    Ok(out)
}

fn configured_upstream(repo: &Repository, branch_name: &str) -> Option<String> {
    let cfg = repo.config().ok()?;
    let remote = cfg
        .get_string(&format!("branch.{branch_name}.remote"))
        .ok()?;
    let merge = cfg
        .get_string(&format!("branch.{branch_name}.merge"))
        .ok()?;
    if remote.is_empty() || merge.is_empty() {
        return None;
    }
    let merge_name = merge.strip_prefix("refs/heads/").unwrap_or(&merge);
    if remote == "." {
        Some(merge_name.to_string())
    } else {
        Some(format!("{remote}/{merge_name}"))
    }
}

fn branch_sync_state(
    repo: &Repository,
    branch: &Branch<'_>,
    upstream_branch: Option<&Branch<'_>>,
    upstream: Option<String>,
    has_remote: bool,
) -> BranchSyncState {
    let Some(upstream_branch) = upstream_branch else {
        return BranchSyncState {
            status: if upstream.is_some() {
                "staleUpstream"
            } else if has_remote {
                "noUpstream"
            } else {
                "noRemote"
            }
            .to_string(),
            upstream,
            ahead: 0,
            behind: 0,
        };
    };

    let counts = branch.get().peel_to_commit().and_then(|local| {
        upstream_branch
            .get()
            .peel_to_commit()
            .and_then(|upstream| repo.graph_ahead_behind(local.id(), upstream.id()))
    });
    let Ok((ahead, behind)) = counts else {
        return BranchSyncState {
            status: "unknown".to_string(),
            upstream,
            ahead: 0,
            behind: 0,
        };
    };
    let status = match (ahead, behind) {
        (0, 0) => "upToDate",
        (_, 0) => "ahead",
        (0, _) => "behind",
        _ => "diverged",
    };

    BranchSyncState {
        status: status.to_string(),
        upstream,
        ahead,
        behind,
    }
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

#[cfg(test)]
mod tests {
    use super::branches;
    use git2::{Oid, Repository, Signature};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU32, Ordering};

    struct TempRepo(PathBuf);
    impl TempRepo {
        fn new(tag: &str) -> Self {
            static SEQ: AtomicU32 = AtomicU32::new(0);
            let n = SEQ.fetch_add(1, Ordering::Relaxed);
            let dir =
                std::env::temp_dir().join(format!("gitlane-read-{tag}-{}-{n}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            TempRepo(dir)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TempRepo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn commit(repo: &Repository, update_ref: &str, message: &str, parents: &[Oid]) -> Oid {
        let blob = repo.blob(message.as_bytes()).unwrap();
        let mut builder = repo.treebuilder(None).unwrap();
        builder
            .insert(format!("{message}.txt"), blob, 0o100644)
            .unwrap();
        let tree_id = builder.write().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();
        let sig = Signature::now("GitLane", "gitlane@example.test").unwrap();
        let parent_commits = parents
            .iter()
            .map(|oid| repo.find_commit(*oid).unwrap())
            .collect::<Vec<_>>();
        let parent_refs = parent_commits.iter().collect::<Vec<_>>();
        repo.commit(Some(update_ref), &sig, &sig, message, &tree, &parent_refs)
            .unwrap()
    }

    fn track(repo: &Repository, branch: &str, upstream: &str) {
        let (remote, merge) = upstream.split_once('/').unwrap();
        let mut cfg = repo.config().unwrap();
        cfg.set_str(&format!("branch.{branch}.remote"), remote)
            .unwrap();
        cfg.set_str(
            &format!("branch.{branch}.merge"),
            &format!("refs/heads/{merge}"),
        )
        .unwrap();
    }

    fn local_status(repo: &TempRepo, branch: &str) -> (String, Option<String>, usize, usize) {
        let list = branches(repo.path().to_str().unwrap()).unwrap();
        let info = list
            .into_iter()
            .find(|b| b.kind == "local" && b.name == branch)
            .unwrap();
        let sync = info.sync.unwrap();
        (sync.status, sync.upstream, sync.ahead, sync.behind)
    }

    #[test]
    fn branch_sync_reports_no_remote_and_no_upstream() {
        let dir = TempRepo::new("no-upstream");
        let repo = Repository::init(dir.path()).unwrap();
        let base = commit(&repo, "refs/heads/main", "base", &[]);
        repo.set_head("refs/heads/main").unwrap();

        assert_eq!(local_status(&dir, "main"), ("noRemote".into(), None, 0, 0));

        repo.remote("origin", "https://example.test/repo.git")
            .unwrap();
        assert_eq!(
            local_status(&dir, "main"),
            ("noUpstream".into(), None, 0, 0)
        );

        repo.reference("refs/remotes/origin/main", base, true, "seed remote")
            .unwrap();
        track(&repo, "main", "origin/main");
        assert_eq!(
            local_status(&dir, "main"),
            ("upToDate".into(), Some("origin/main".into()), 0, 0)
        );
    }

    #[test]
    fn branch_sync_counts_ahead_behind_and_diverged() {
        let dir = TempRepo::new("counts");
        let repo = Repository::init(dir.path()).unwrap();
        repo.remote("origin", "https://example.test/repo.git")
            .unwrap();
        let base = commit(&repo, "refs/heads/main", "base", &[]);
        repo.set_head("refs/heads/main").unwrap();

        repo.reference("refs/remotes/origin/ahead", base, true, "seed remote")
            .unwrap();
        let ahead = commit(&repo, "refs/heads/ahead", "ahead", &[base]);
        assert_ne!(ahead, base);
        track(&repo, "ahead", "origin/ahead");
        assert_eq!(
            local_status(&dir, "ahead"),
            ("ahead".into(), Some("origin/ahead".into()), 1, 0)
        );

        repo.reference("refs/heads/behind", base, true, "seed local")
            .unwrap();
        let remote_ahead = commit(&repo, "refs/remotes/origin/behind", "remote-ahead", &[base]);
        assert_ne!(remote_ahead, base);
        track(&repo, "behind", "origin/behind");
        assert_eq!(
            local_status(&dir, "behind"),
            ("behind".into(), Some("origin/behind".into()), 0, 1)
        );

        let local_tip = commit(&repo, "refs/heads/diverged", "local-diverged", &[base]);
        let remote_tip = commit(
            &repo,
            "refs/remotes/origin/diverged",
            "remote-diverged",
            &[base],
        );
        assert_ne!(local_tip, remote_tip);
        track(&repo, "diverged", "origin/diverged");
        assert_eq!(
            local_status(&dir, "diverged"),
            ("diverged".into(), Some("origin/diverged".into()), 1, 1)
        );
    }

    #[test]
    fn branch_sync_keeps_stale_upstream_name_after_remote_ref_is_missing() {
        let dir = TempRepo::new("stale");
        let repo = Repository::init(dir.path()).unwrap();
        repo.remote("origin", "https://example.test/repo.git")
            .unwrap();
        commit(&repo, "refs/heads/main", "base", &[]);
        repo.set_head("refs/heads/main").unwrap();
        track(&repo, "main", "origin/deleted");

        assert_eq!(
            local_status(&dir, "main"),
            ("staleUpstream".into(), Some("origin/deleted".into()), 0, 0)
        );
    }

    #[test]
    fn branch_sync_reports_unknown_when_ahead_behind_cannot_be_computed() {
        let dir = TempRepo::new("unknown");
        let repo = Repository::init(dir.path()).unwrap();
        repo.remote("origin", "https://example.test/repo.git")
            .unwrap();
        let remote = commit(&repo, "refs/remotes/origin/main", "remote", &[]);
        let blob = repo.blob(b"not a commit").unwrap();
        repo.reference("refs/heads/main", blob, true, "broken branch")
            .unwrap();
        assert_ne!(blob, remote);
        track(&repo, "main", "origin/main");

        assert_eq!(
            local_status(&dir, "main"),
            ("unknown".into(), Some("origin/main".into()), 0, 0)
        );
    }
}
