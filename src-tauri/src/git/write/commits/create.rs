//! Creating a commit, amending, and the locked body both entry points share.

use super::super::cli::run_git;

/// Create a commit. `description` (when non-empty) becomes a second message
/// paragraph; `amend` rewrites the previous commit instead.
///
/// When `name`/`email` are given they are pinned via `-c user.name`/
/// `-c user.email`, which sets **both author and committer** for this one
/// invocation — so a GitLane commit always uses the repo's bound identity
/// regardless of what global/local git config (or another tool) has set.
#[cfg(test)]
#[allow(clippy::too_many_arguments)] // Test-only wrapper mirrors the guarded commit contract exactly.
pub fn commit(
    repo: &str,
    summary: &str,
    description: &str,
    amend: bool,
    name: Option<&str>,
    email: Option<&str>,
    identity: &crate::git::types::CapturedIdentity,
) -> Result<String, String> {
    let _index_guard = super::super::index_lock::lock_index_writes(repo)?;
    let _identity_guard = super::super::identity::lock_identity_config(repo)?;
    commit_locked(repo, summary, description, amend, name, email, identity)
}

#[allow(clippy::too_many_arguments)] // Internal half of the guarded IPC contract.
pub(super) fn commit_locked(
    repo: &str,
    summary: &str,
    description: &str,
    amend: bool,
    name: Option<&str>,
    email: Option<&str>,
    identity: &crate::git::types::CapturedIdentity,
) -> Result<String, String> {
    // Guard an empty subject with a clear message instead of letting git fail
    // with its raw "Aborting commit due to empty commit message" — the commit
    // always carries an explicit `-m <summary>`, so an empty subject is a user
    // error, not an editor abort.
    if summary.trim().is_empty() {
        return Err("A commit message is required.".to_string());
    }
    let mut args: Vec<String> = Vec::new();
    let expected_author = match (name, email) {
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
        identity,
        super::super::identity::SigningOperation::Commit,
    )?);
    args.push("commit".into());
    if amend {
        args.push("--amend".into());
    }
    args.push("-m".into());
    args.push(summary.into());
    if !description.is_empty() {
        args.push("-m".into());
        args.push(description.into());
    }
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run_git(repo, &arg_refs)
}

/// Commit only while HEAD still matches the branch/oid snapshot the composer
/// was opened against. This applies to ordinary commits and amend alike.
#[allow(clippy::too_many_arguments)] // Mirrors the guarded commit IPC contract.
pub fn commit_expected(
    repo: &str,
    expected_branch: Option<&str>,
    expected_oid: Option<&str>,
    summary: &str,
    description: &str,
    amend: bool,
    name: Option<&str>,
    email: Option<&str>,
    identity: &crate::git::types::CapturedIdentity,
) -> Result<String, String> {
    let _index_guard = super::super::index_lock::lock_index_writes(repo)?;
    let _identity_guard = super::super::identity::lock_identity_config(repo)?;
    super::super::head::ensure_expected_head(repo, expected_branch, expected_oid)?;
    commit_locked(repo, summary, description, amend, name, email, identity)
}
