//! Creating a commit, amending, and the locked body both entry points share.

use super::super::cli::run_git;
use crate::git::types::CommitRequest;

/// Create a commit. `description` (when non-empty) becomes a second message
/// paragraph; `amend` rewrites the previous commit instead.
///
/// When `name`/`email` are given they are pinned via `-c user.name`/
/// `-c user.email`, which sets **both author and committer** for this one
/// invocation — so a GitLane commit always uses the repo's bound identity
/// regardless of what global/local git config (or another tool) has set.
#[cfg(test)]
pub fn commit(repo: &str, request: &CommitRequest) -> Result<String, String> {
    let _index_guard = super::super::index_lock::lock_index_writes(repo)?;
    let _identity_guard = super::super::identity::lock_identity_config(repo)?;
    commit_locked(repo, request)
}

pub(super) fn commit_locked(repo: &str, request: &CommitRequest) -> Result<String, String> {
    // Guard an empty subject with a clear message instead of letting git fail
    // with its raw "Aborting commit due to empty commit message" — the commit
    // always carries an explicit `-m <summary>`, so an empty subject is a user
    // error, not an editor abort.
    if request.summary.trim().is_empty() {
        return Err("A commit message is required.".to_string());
    }
    let mut args: Vec<String> = Vec::new();
    let expected_author = match (request.name.as_deref(), request.email.as_deref()) {
        (Some(n), Some(e)) if !n.is_empty() && !e.is_empty() => Some((n, e)),
        _ => None,
    };
    if let Some((n, e)) = expected_author {
        args.push("-c".into());
        args.push(format!("user.name={n}"));
        args.push("-c".into());
        args.push(format!("user.email={e}"));
    }
    args.extend(super::super::identity::pinned_signing_args(
        repo,
        expected_author,
        &request.identity,
        super::super::identity::SigningOperation::Commit,
    )?);
    args.push("commit".into());
    if request.amend {
        args.push("--amend".into());
    }
    args.push("-m".into());
    args.push(request.summary.clone());
    if !request.description.is_empty() {
        args.push("-m".into());
        args.push(request.description.clone());
    }
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run_git(repo, &arg_refs)
}

/// Commit only while HEAD still matches the branch/oid snapshot the composer
/// was opened against. This applies to ordinary commits and amend alike.
pub fn commit_expected(repo: &str, request: &CommitRequest) -> Result<String, String> {
    let _index_guard = super::super::index_lock::lock_index_writes(repo)?;
    let _identity_guard = super::super::identity::lock_identity_config(repo)?;
    super::super::head::ensure_expected_head(
        repo,
        request.expected_branch.as_deref(),
        request.expected_oid.as_deref(),
    )?;
    commit_locked(repo, request)
}
