//! Branch listing and upstream sync state reads.

use git2::{Branch, BranchType, Repository};

use crate::git::types::{BranchInfo, BranchSyncState};

use super::repo::open;

/// True when fast-forwarding `to` to `from` is possible — i.e. `from` is `to`
/// itself or a descendant of it, so `to`'s pointer can move forward with no
/// merge commit. Both args are anything `revparse` accepts (branch, remote, oid).
///
/// Equal tips count as fast-forwardable: the move is an up-to-date no-op, which
/// is exactly what `git merge-base --is-ancestor A A` reports (true).
/// `graph_descendant_of` is *strict* (false for equal oids), so the equal case
/// is handled explicitly — otherwise the drop menu hid Fast-forward and offered
/// merge/rebase for two refs already pointing at the same commit.
pub fn can_fast_forward(path: &str, from: &str, to: &str) -> Result<bool, git2::Error> {
    let repo = open(path)?;
    let from_oid = repo.revparse_single(from)?.peel_to_commit()?.id();
    let to_oid = repo.revparse_single(to)?.peel_to_commit()?.id();
    Ok(from_oid == to_oid || repo.graph_descendant_of(from_oid, to_oid)?)
}

/// Local + remote branches for the sidebar.
pub fn branches(path: &str) -> Result<Vec<BranchInfo>, git2::Error> {
    let repo = open(path)?;
    let mut out = Vec::new();
    let remote_names = repo.remotes()?;
    let has_remote = !remote_names.is_empty();
    // Snapshot the configured remote names once so each remote branch can be
    // attributed to its remote by longest-prefix match (a remote name may
    // contain a slash), rather than the frontend re-splitting on the first `/`.
    let mut remotes: Vec<String> = (0..remote_names.len())
        .filter_map(|i| remote_names.get(i).ok().flatten().map(|s| s.to_string()))
        .collect();
    // Longest first so `origin/mirror` wins over `origin` for `origin/mirror/x`.
    remotes.sort_by_key(|r| std::cmp::Reverse(r.len()));

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

            let remote = if kind == BranchType::Remote {
                remotes
                    .iter()
                    .find(|r| {
                        name.strip_prefix(r.as_str())
                            .is_some_and(|rest| rest.starts_with('/'))
                    })
                    .cloned()
            } else {
                None
            };
            let upstream_remote = if kind == BranchType::Local {
                configured_remote(&repo, &name)
            } else {
                None
            };

            out.push(BranchInfo {
                name,
                kind: label.to_string(),
                target,
                is_head: branch.is_head(),
                upstream,
                remote,
                upstream_remote,
                sync,
            });
        }
    }

    Ok(out)
}

/// The remote a local branch pushes to (`branch.<name>.remote`), excluding the
/// local-tracking `"."` — mirrors the fallback-free half of the write side's
/// `push_target` so the frontend and the actual push agree on the target.
fn configured_remote(repo: &Repository, branch_name: &str) -> Option<String> {
    let cfg = repo.config().ok()?;
    let remote = cfg
        .get_string(&format!("branch.{branch_name}.remote"))
        .ok()?;
    if remote.is_empty() || remote == "." {
        return None;
    }
    Some(remote)
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
