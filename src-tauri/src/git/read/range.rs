//! Commit-range reads for the create-pull-request surface.
//!
//! Two graph-only questions the PR form asks before anything is pushed: which
//! commits a proposed `base..head` would carry, and which of a set of candidate
//! refs the head branch descends from (the stack-parent probe). Neither
//! computes a diff — `compare_refs` already owns the file/line side, and paying
//! for a tree diff here would make the stack probe quadratic in open PRs.

use git2::{Oid, Repository, Sort};

use crate::git::types::{AncestorRef, HistorySearchResult};

use super::repo::open;

/// Upper bound on commits returned for one range. A pull request form only ever
/// lists a handful; the cap stops a mistargeted base (an unrelated root, say)
/// from walking the whole history into a modal.
const RANGE_LIMIT: usize = 500;

fn commit_oid(repo: &Repository, spec: &str) -> Result<Oid, git2::Error> {
    Ok(repo.revparse_single(spec)?.peel_to_commit()?.id())
}

fn to_result(commit: &git2::Commit<'_>) -> HistorySearchResult {
    let author = commit.author();
    let id = commit.id();
    HistorySearchResult {
        id: id.to_string(),
        short_id: id.to_string()[..7].to_string(),
        summary: commit.summary().ok().flatten().unwrap_or("").to_string(),
        author_name: author.name().unwrap_or_default().to_string(),
        author_email: author.email().unwrap_or_default().to_string(),
        timestamp: commit.time().seconds(),
    }
}

/// The commits in `base..head` — reachable from `head`, not from `base` —
/// newest first, capped at [`RANGE_LIMIT`].
///
/// This is what the pull request would actually carry, which is why `base` is
/// hidden rather than the walk being bounded by a merge-base: a head that has
/// merged `base` back in must not re-list `base`'s own commits.
pub fn range_commits(
    path: &str,
    base: &str,
    head: &str,
) -> Result<Vec<HistorySearchResult>, String> {
    let repo = open(path).map_err(|error| error.to_string())?;
    let base_oid = commit_oid(&repo, base).map_err(|error| error.to_string())?;
    let head_oid = commit_oid(&repo, head).map_err(|error| error.to_string())?;

    let mut walk = repo.revwalk().map_err(|error| error.to_string())?;
    walk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME)
        .map_err(|error| error.to_string())?;
    walk.push(head_oid).map_err(|error| error.to_string())?;
    walk.hide(base_oid).map_err(|error| error.to_string())?;

    let mut out = Vec::new();
    for oid in walk {
        if out.len() >= RANGE_LIMIT {
            break;
        }
        let commit = repo
            .find_commit(oid.map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?;
        out.push(to_result(&commit));
    }
    Ok(out)
}

/// Which of `candidates` `head` descends from, nearest first.
///
/// "Nearest" is the fewest commits between the candidate and `head`, so the tip
/// of the stack the branch was actually cut from sorts above the trunk it
/// ultimately sits on. A candidate that does not resolve is skipped rather than
/// failing the call: the candidate list comes from the pull request list, and a
/// branch whose remote ref was never fetched is a normal state, not an error.
///
/// `head` itself is never returned — a pull request cannot target its own
/// branch — and neither is a candidate pointing at the same commit, which would
/// describe an empty pull request.
pub fn ancestor_refs(
    path: &str,
    head: &str,
    candidates: &[String],
) -> Result<Vec<AncestorRef>, String> {
    let repo = open(path).map_err(|error| error.to_string())?;
    let head_oid = commit_oid(&repo, head).map_err(|error| error.to_string())?;

    let mut out: Vec<AncestorRef> = candidates
        .iter()
        .filter_map(|name| {
            let oid = commit_oid(&repo, name).ok()?;
            if oid == head_oid || !repo.graph_descendant_of(head_oid, oid).ok()? {
                return None;
            }
            let (ahead, _behind) = repo.graph_ahead_behind(head_oid, oid).ok()?;
            Some(AncestorRef {
                name: name.clone(),
                ahead,
            })
        })
        .collect();
    out.sort_by_key(|entry| entry.ahead);
    Ok(out)
}
