//! Push: which remote and refspec a branch pushes to, publishing a new
//! branch, and deleting a remote branch or tag.

use super::config::push_endpoint;
use super::fetch::join_git_outputs;
use super::transport::{run_push, run_push_stable, run_transport};

use super::super::cli::run_git;
use super::super::operands::ensure_operand;
use crate::git::transport_auth::TransportCredential;

/// Push a specific `branch` without checking it out first (shells out — libgit2
/// has no network here). Pushes to the branch's configured remote
/// (`branch.<name>.remote`), falling back to `origin` when none is set, and
/// honours a divergent upstream branch name (`branch.<name>.merge`) so a local
/// branch tracking a differently-named remote branch still lands on the right
/// ref. Does **not** set upstream — use [`set_upstream`] for that. `cred` selects
/// the inline transport credentials; no token crosses the frontend boundary.
pub fn push_branch(
    repo: &str,
    branch: &str,
    expected_oid: &str,
    cred: &TransportCredential,
) -> Result<String, String> {
    // `branch` becomes a positional refspec in `git push <remote> <refspec>`, so
    // guard it against option injection (e.g. --receive-pack=…) like the others.
    super::super::head::ensure_expected_branch_tip(repo, branch, expected_oid)?;
    let (remote, refspec) = push_target_at(repo, branch, expected_oid);
    run_push(repo, cred, &remote, &[], &[&refspec])
}

/// Publish `branch` to `upstream` (`remote/branch`) and set it as the branch's
/// upstream in one git invocation. Used for first-push flows where the remote
/// tracking ref does not exist yet, so `set_upstream` alone would fail.
pub fn publish_branch(
    repo: &str,
    branch: &str,
    expected_oid: &str,
    upstream: &str,
    cred: &TransportCredential,
) -> Result<String, String> {
    super::super::head::ensure_expected_branch_tip(repo, branch, expected_oid)?;
    let (remote, remote_branch) = split_remote_ref(repo, upstream)?;
    ensure_operand(&remote)?;
    ensure_operand(&remote_branch)?;
    let refspec = format!("{expected_oid}:refs/heads/{remote_branch}");
    // A pinned oid source is what prevents a concurrent local branch move from
    // changing the commit we publish. `git push --set-upstream` cannot infer a
    // local branch from an oid source, so persist the equivalent tracking
    // configuration explicitly after the push succeeds. Push + config are not
    // one transaction: dying in between leaves the branch published but
    // untracked, which a re-publish repairs.
    let pushed = run_push(repo, cred, &remote, &[], &[&refspec])?;
    let configured_remote = run_git(
        repo,
        &["config", &format!("branch.{branch}.remote"), &remote],
    )?;
    let configured_merge = run_git(
        repo,
        &[
            "config",
            &format!("branch.{branch}.merge"),
            &format!("refs/heads/{remote_branch}"),
        ],
    )?;
    Ok(join_git_outputs(
        &join_git_outputs(&pushed, &configured_remote),
        &configured_merge,
    ))
}

/// Split an `upstream` string like `origin/main` into its `(remote, branch)`
/// parts by matching the **longest configured remote name** that prefixes it —
/// not by splitting on the first `/`. A remote name may itself contain a slash
/// (git permits it), and a first-`/` split would then send the push to the
/// wrong remote (or a nonexistent one). Falls back to the first-`/` split only
/// when no configured remote matches, so a genuine first-push to a
/// not-yet-fetched remote still works and git surfaces its own error if the
/// remote is unknown.
fn split_remote_ref(repo: &str, upstream: &str) -> Result<(String, String), String> {
    let invalid = || "Enter an upstream as remote/branch, for example origin/main.".to_string();
    let remotes = run_git(repo, &["remote"])?;
    let matched = remotes
        .lines()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .filter(|name| {
            upstream
                .strip_prefix(*name)
                .is_some_and(|rest| rest.starts_with('/'))
        })
        // Longest remote name wins so `origin/x` beats `origin` for an
        // `origin/x/feature` upstream.
        .max_by_key(|name| name.len());
    let (remote, remote_branch) = match matched {
        Some(remote) => (remote.to_string(), upstream[remote.len() + 1..].to_string()),
        None => {
            let (r, b) = upstream.split_once('/').ok_or_else(invalid)?;
            (r.to_string(), b.to_string())
        }
    };
    if remote.is_empty() || remote_branch.is_empty() {
        return Err(invalid());
    }
    Ok((remote, remote_branch))
}

/// The remote half of an `upstream` (`remote/branch`) publish target — the same
/// longest-prefix resolution [`publish_branch`] uses, exposed so per-remote auth
/// can validate the account against the remote actually pushed to (GL-129).
pub fn publish_remote(repo: &str, upstream: &str) -> Result<String, String> {
    split_remote_ref(repo, upstream).map(|(remote, _)| remote)
}

/// The remote a push of `branch` targets (the remote half of [`push_target`]).
/// For per-remote auth validation before [`push_branch`] / [`force_push`].
pub fn branch_push_remote(repo: &str, branch: &str) -> String {
    push_target(repo, branch).0
}

/// The remote a bare `git push` from the checked-out branch targets — that
/// branch's [`push_target`] remote, falling back to `origin` on a detached or
/// unborn HEAD (where the push itself will fail with git's own message anyway).
#[cfg(test)]
pub fn head_push_remote(repo: &str) -> String {
    run_git(repo, &["symbolic-ref", "--short", "-q", "HEAD"])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(|branch| push_target(repo, &branch).0)
        .unwrap_or_else(|| "origin".to_string())
}

/// Resolve where `branch` pushes: its remote via git's own push precedence
/// (`branch.<name>.pushRemote` → `remote.pushDefault` → `branch.<name>.remote`,
/// including Git's local-repository `.` target) and refspec (honouring a
/// divergent upstream branch name via
/// `branch.<name>.merge`, else the fully-qualified local branch). Shared by
/// [`push_branch`] and [`force_push`] so both target exactly one ref rather than
/// deferring to `push.default`. Config reads exit non-zero when unset, which
/// `.ok()` turns into the fallback.
pub(in crate::git::write) fn push_target(repo: &str, branch: &str) -> (String, String) {
    let (remote, destination) = push_destination(repo, branch);
    (remote, format!("refs/heads/{branch}:{destination}"))
}

pub(in crate::git::write) fn push_target_at(
    repo: &str,
    branch: &str,
    expected_oid: &str,
) -> (String, String) {
    let (remote, destination) = push_destination(repo, branch);
    (remote, format!("{expected_oid}:{destination}"))
}

pub(in crate::git::write) fn push_destination(repo: &str, branch: &str) -> (String, String) {
    let config = |key: String| {
        run_git(repo, &["config", &key])
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    };
    let upstream_remote = config(format!("branch.{branch}.remote"));
    // `git push` resolves its remote as branch.<name>.pushRemote →
    // remote.pushDefault → branch.<name>.remote → origin; a terminal push and a
    // GitLane push must land on the same remote (and pick that remote's
    // credentials) in triangular setups too.
    let remote = config(format!("branch.{branch}.pushRemote"))
        .or_else(|| config("remote.pushDefault".to_string()))
        .or_else(|| upstream_remote.clone())
        .unwrap_or_else(|| "origin".to_string());
    // `branch.<name>.merge` names the branch on the *fetch* upstream. It only
    // describes a push destination when pushing to that same remote; on a
    // triangular push remote git's push.default=simple uses the same-named
    // branch instead.
    let destination = if upstream_remote.as_deref() == Some(remote.as_str()) {
        config(format!("branch.{branch}.merge"))
    } else {
        None
    }
    .unwrap_or_else(|| format!("refs/heads/{branch}"));
    (remote, destination)
}

/// Push a tag to `remote` (`git push <remote> refs/tags/<name>`). The explicit
/// `refs/tags/` refspec avoids any ambiguity with a same-named branch. `cred`
/// selects the inline transport credentials.
pub fn push_tag(
    repo: &str,
    name: &str,
    remote: &str,
    cred: &TransportCredential,
) -> Result<String, String> {
    ensure_operand(name)?;
    ensure_operand(remote)?;
    let refspec = format!("refs/tags/{name}");
    run_push(repo, cred, remote, &[], &[&refspec])
}

/// Delete a tag on `remote` only when it still points at `expected_oid`. The
/// exact `--force-with-lease` prevents a tag moved after the confirmation was
/// opened from being erased. The fully-qualified `refs/tags/` destination also
/// guarantees a same-named branch on the remote is never deleted. Local
/// deletion is separate ([`super::delete_tag`]); without this, a tag deleted
/// locally but still on the remote is re-imported by the next Fetch's explicit
/// `refs/tags/*` refspec. `cred` selects the account.
///
/// A tag that was never pushed is not an error: absence upstream is the desired
/// end state, so "remote ref does not exist" maps to `Ok` and a combined
/// delete-everywhere still proceeds to the local delete. The subprocess runs
/// with `LC_ALL=C` so that message match is locale-stable (same approach as
/// [`is_tag_clobber_rejection`]).
pub fn delete_remote_tag(
    repo: &str,
    remote: &str,
    name: &str,
    expected_oid: &str,
    cred: &TransportCredential,
) -> Result<String, String> {
    ensure_operand(remote)?;
    ensure_operand(name)?;
    ensure_operand(expected_oid)?;
    let destination = format!("refs/tags/{name}");
    let lease = format!("--force-with-lease={destination}:{expected_oid}");
    match run_push_stable(repo, cred, remote, &[&lease, "--delete"], &[&destination]) {
        Err(output) if is_missing_remote_ref(&output) => {
            Ok(format!("Tag {name} was not on {remote}"))
        }
        Err(output) => {
            // File transports report an already-absent leased ref as a generic
            // stale-info rejection. Confirm absence on the same effective push
            // endpoint before treating that desired end state as success. A
            // moved ref produces output here and therefore preserves the
            // original lease failure.
            let probe = push_endpoint(repo, remote).and_then(|endpoint| {
                run_transport(
                    repo,
                    cred,
                    &["ls-remote", "--refs", &endpoint, &destination],
                )
            });
            match probe {
                Ok(found) if found.trim().is_empty() => {
                    Ok(format!("Tag {name} was not on {remote}"))
                }
                _ => Err(output),
            }
        }
        ok => ok,
    }
}

pub(in crate::git::write) fn is_missing_remote_ref(output: &str) -> bool {
    output.contains("remote ref does not exist")
}

/// Delete a branch on `remote` (`git push <remote> --delete <branch>`). `branch`
/// is the short name on the remote (e.g. `feature/x`, not `origin/feature/x`).
/// `cred` selects the account.
pub fn delete_remote_branch(
    repo: &str,
    remote: &str,
    branch: &str,
    expected_oid: &str,
    cred: &TransportCredential,
) -> Result<String, String> {
    ensure_operand(remote)?;
    ensure_operand(branch)?;
    ensure_operand(expected_oid)?;
    let destination = format!("refs/heads/{branch}");
    let lease = format!("--force-with-lease={destination}:{expected_oid}");
    run_push(repo, cred, remote, &[&lease, "--delete"], &[&destination])
}
