//! Fetch across one or every remote, including the tag refspec and the two
//! git messages that must not be mistaken for failures.

use super::transport::run_transport_stable;
use std::collections::HashMap;

use super::super::cli::run_git;
use super::super::operands::ensure_operand;
use crate::git::transport_auth::TransportCredential;

pub(in crate::git::write) const TAG_FETCH_REFSPEC: &str = "refs/tags/*:refs/tags/*";

/// Fetch every non-skipped remote, prune deleted upstream refs, and import
/// tags (shells out — libgit2 has no network here). Explicit tag import is
/// intentional: Git's default tag auto-follow misses remote-only tags in some
/// no-branch-update refreshes, but the UI derives visible tags from local
/// `refs/tags/*`.
///
/// Each remote is fetched **individually with its own credentials** (GL-129):
/// `cred_by_remote` maps a remote name to the [`TransportCredential`] its bound
/// account resolved to, and remotes without an entry go through the system
/// credential helpers / SSH untouched — that is what keeps unauthenticated
/// Bitbucket/GitLab remotes working next to an account-bound GitHub remote.
/// One failing remote does not stop the others (matching `git fetch --all`
/// semantics); if any remote failed, the combined per-remote output comes back
/// as the error so the toast attributes each part to its remote.
///
/// Tags are fetched through an explicit tag-only refspec after a `--no-tags`
/// branch/prune fetch. A remote tag that would clobber an existing local tag
/// is left alone and treated as non-fatal, so the UI still refreshes branch
/// updates and any tags that did import. Other tag-fetch failures fail that
/// remote. Local-only tags and tags deleted upstream are intentionally
/// preserved unless the user deletes them explicitly: the tag fetch passes
/// `--no-prune` (its explicit `refs/tags/*` refspec would otherwise prune
/// local-only tags under `fetch.prune=true`), and the branch fetch forces
/// `--no-prune-tags` so a repo with `fetch.pruneTags=true` (or
/// `remote.<name>.pruneTags=true`) and a divergent local tag does not fail the
/// remote's fetch with "would clobber existing tag" before the clobber
/// tolerance can run.
pub fn fetch(
    repo: &str,
    cred_by_remote: &HashMap<String, TransportCredential>,
) -> Result<String, String> {
    let mut succeeded: Vec<String> = Vec::new();
    let mut failed: Vec<String> = Vec::new();
    let default_cred = TransportCredential::None;
    for remote in fetch_remotes(repo)? {
        ensure_operand(&remote)?;
        let cred = cred_by_remote.get(&remote).unwrap_or(&default_cred);
        match fetch_remote(repo, &remote, cred) {
            Ok(output) => succeeded.push(label_remote_output(&remote, &output)),
            Err(err) => failed.push(label_remote_output(&remote, &err)),
        }
    }
    let mut combined = String::new();
    for part in failed.iter().chain(succeeded.iter()) {
        combined = join_git_outputs(&combined, part);
    }
    if failed.is_empty() {
        Ok(combined)
    } else {
        Err(combined)
    }
}

/// Fetch one remote: a branch/prune pass, then the explicit tag-refspec pass
/// with clobber tolerance (see [`fetch`] for the tag semantics). If another git
/// process moves a remote-tracking ref after this fetch reads it but before it
/// takes the lock, retry the branch pass once from the now-current oid.
fn fetch_remote(repo: &str, remote: &str, cred: &TransportCredential) -> Result<String, String> {
    let branch_cmd = ["fetch", remote, "--prune", "--no-tags", "--no-prune-tags"];
    let tag_cmd = [
        "fetch",
        remote,
        "--no-tags",
        "--no-prune",
        TAG_FETCH_REFSPEC,
    ];
    let output = match run_transport_stable(repo, cred, &branch_cmd) {
        Ok(output) => output,
        Err(error) if is_concurrent_fetch_ref_update(&error) => {
            run_transport_stable(repo, cred, &branch_cmd)?
        }
        Err(error) => return Err(error),
    };
    match run_transport_stable(repo, cred, &tag_cmd) {
        Ok(tag_output) => Ok(join_git_outputs(&output, &tag_output)),
        Err(e) if is_tag_clobber_rejection(&e) => Ok(join_git_outputs(&output, &e)),
        Err(e) => Err(e),
    }
}

/// Git's stable diagnostic when a concurrent process updates a remote-tracking
/// ref between fetch's read and lock phases. This is safe to retry once; an
/// ordinary lock-file collision, auth failure, or rejected ref update does not
/// match and remains visible to the caller.
pub(in crate::git::write) fn is_concurrent_fetch_ref_update(output: &str) -> bool {
    output.lines().any(|line| {
        line.contains("error: cannot lock ref 'refs/remotes/")
            && line.contains(": is at ")
            && line.contains(" but expected ")
    }) && output.contains("(unable to update local ref)")
}

/// Prefix a remote's fetch output with its name so the combined multi-remote
/// output stays attributable (the single `--all` invocation used to print
/// "Fetching <remote>" headers itself).
fn label_remote_output(remote: &str, output: &str) -> String {
    if output.trim().is_empty() {
        format!("{remote}: up to date")
    } else {
        format!("{remote}:\n{}", output.trim())
    }
}

fn fetch_remotes(repo: &str) -> Result<Vec<String>, String> {
    let remotes = run_git(repo, &["remote"])?
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    let mut included = Vec::new();
    for remote in remotes {
        let skip = ["skipFetchAll", "skipDefaultUpdate"].iter().any(|key| {
            run_git(
                repo,
                &["config", "--bool", &format!("remote.{remote}.{key}")],
            )
            .ok()
            .is_some_and(|value| value.trim().eq_ignore_ascii_case("true"))
        });
        if !skip {
            included.push(remote);
        }
    }
    Ok(included)
}

pub(super) fn join_git_outputs(first: &str, second: &str) -> String {
    match (first.trim(), second.trim()) {
        ("", "") => String::new(),
        (a, "") => a.to_string(),
        ("", b) => b.to_string(),
        (a, b) => format!("{a}\n{b}"),
    }
}

pub(in crate::git::write) fn is_tag_clobber_rejection(output: &str) -> bool {
    output.contains("would clobber existing tag")
        && !output.lines().any(|line| {
            let trimmed = line.trim_start();
            trimmed.starts_with("fatal:") || trimmed.starts_with("error:")
        })
}
