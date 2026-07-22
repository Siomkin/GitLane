//! Commit, amend, and squash writes.

use super::cli::{run_git, run_git_stdout};
use std::path::{Path, PathBuf};

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
    identity: Option<&crate::git::types::RepoIdentity>,
    identity_captured: bool,
) -> Result<String, String> {
    let _identity_guard = super::identity::lock_identity_config(repo)?;
    commit_locked(
        repo,
        summary,
        description,
        amend,
        name,
        email,
        identity,
        identity_captured,
    )
}

#[allow(clippy::too_many_arguments)] // Internal half of the guarded IPC contract.
fn commit_locked(
    repo: &str,
    summary: &str,
    description: &str,
    amend: bool,
    name: Option<&str>,
    email: Option<&str>,
    identity: Option<&crate::git::types::RepoIdentity>,
    identity_captured: bool,
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
    args.extend(super::identity::pinned_signing_args(
        repo,
        expected_author,
        identity,
        identity_captured,
        super::identity::SigningOperation::Commit,
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
    identity: Option<&crate::git::types::RepoIdentity>,
    identity_captured: bool,
) -> Result<String, String> {
    let _identity_guard = super::identity::lock_identity_config(repo)?;
    super::head::ensure_expected_head(repo, expected_branch, expected_oid)?;
    commit_locked(
        repo,
        summary,
        description,
        amend,
        name,
        email,
        identity,
        identity_captured,
    )
}

fn absolute_index_path(repo: &str) -> Result<PathBuf, String> {
    let git_dir = run_git(repo, &["rev-parse", "--absolute-git-dir"])?;
    Ok(PathBuf::from(git_dir.trim()).join("index"))
}

fn ensure_index_not_unmerged(repo: &str) -> Result<(), String> {
    let unmerged = run_git_stdout(repo, &["ls-files", "-u"])?;
    if unmerged.lines().any(|line| !line.is_empty()) {
        return Err(
            "Cannot squash while the index has unresolved conflicts. Finish or abort the conflict first."
                .to_string(),
        );
    }
    Ok(())
}

fn read_index_bytes(path: &Path) -> Result<Vec<u8>, String> {
    std::fs::read(path).map_err(|error| format!("Could not snapshot the git index: {error}"))
}

fn write_index_bytes(path: &Path, bytes: &[u8]) -> Result<(), String> {
    // Git has no porcelain that reloads an exact on-disk index; GL-307 / ADR 0001
    // deliberately copy the file (siblings already write handoff markers under
    // `.git` via `std::fs`). Ordinary staging mutations stay on `run_git`.
    let tmp = path.with_extension("gitlane-squash-restore");
    std::fs::write(&tmp, bytes)
        .map_err(|error| format!("Could not restore the git index: {error}"))?;
    std::fs::rename(&tmp, path).map_err(|error| {
        let _ = std::fs::remove_file(&tmp);
        format!("Could not restore the git index: {error}")
    })
}

/// Staged identity of the live index (`ls-files -s`). Prefer this over raw
/// index bytes (`git commit` refreshes cache fields) and over `write-tree`
/// alone (intent-to-add / staged path churn still counts as divergence).
fn index_stage_fingerprint(repo: &str) -> Result<String, String> {
    run_git_stdout(repo, &["ls-files", "-s"])
}

/// Materialize the squash-owned tip tree into the index without touching the
/// worktree (`read-tree` without `-u`).
fn install_squash_owned_tree(repo: &str, tip_oid: &str) -> Result<(), String> {
    run_git(repo, &["read-tree", tip_oid]).map(|_| ())
}

/// Restore the pre-squash index snapshot only while the live index still holds
/// the tip-tree staging we installed for the commit (compare-and-restore).
fn restore_index_snapshot(
    repo: &str,
    index_path: &Path,
    snapshot: &[u8],
    tip_stage_fingerprint: &str,
    commit_succeeded: bool,
) -> Result<(), String> {
    let live_fingerprint = index_stage_fingerprint(repo)?;
    if live_fingerprint != tip_stage_fingerprint {
        return Err(if commit_succeeded {
            "Squash commit was created, but the index changed during squash; pre-staged work was not reapplied."
                .to_string()
        } else {
            "Squash failed, and the index changed during squash; pre-staged work was not restored."
                .to_string()
        });
    }
    write_index_bytes(index_path, snapshot)
}

#[cfg(test)]
std::thread_local! {
    static SQUASH_AFTER_COMMIT_TEST_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
}

/// Inject concurrent index mutation after the squash commit lands, before
/// compare-and-restore (GL-307).
#[cfg(test)]
pub(crate) fn set_squash_after_commit_test_hook(hook: impl FnOnce() + 'static) {
    SQUASH_AFTER_COMMIT_TEST_HOOK.with(|slot| {
        assert!(slot.borrow_mut().replace(Box::new(hook)).is_none());
    });
}

#[cfg(test)]
fn run_after_commit_test_hook() {
    SQUASH_AFTER_COMMIT_TEST_HOOK.with(|slot| {
        if let Some(hook) = slot.borrow_mut().take() {
            hook();
        }
    });
}

#[cfg(not(test))]
fn run_after_commit_test_hook() {}

/// Replace the current tip range with one commit behind a single guarded IPC
/// contract. Preserves pre-staged work via an exact index snapshot (GL-307):
/// strip the tip tree into the index, soft-reset onto the parent, commit, then
/// compare-and-restore. Rollback of HEAD is attempted only while the same
/// branch still owns the soft-reset state; a landed squash is never undone when
/// index restore fails.
#[allow(clippy::too_many_arguments)] // Mirrors the guarded squash IPC contract.
pub fn squash_commits(
    repo: &str,
    expected_branch: Option<&str>,
    expected_oid: &str,
    parent_oid: &str,
    summary: &str,
    description: &str,
    name: Option<&str>,
    email: Option<&str>,
    identity: Option<&crate::git::types::RepoIdentity>,
    identity_captured: bool,
) -> Result<String, String> {
    let _identity_guard = super::identity::lock_identity_config(repo)?;
    super::head::ensure_expected_head(repo, expected_branch, Some(expected_oid))?;
    super::head::ensure_commit_exists(repo, parent_oid)?;
    ensure_index_not_unmerged(repo)?;

    let index_path = absolute_index_path(repo)?;
    let snapshot = read_index_bytes(&index_path)?;
    install_squash_owned_tree(repo, expected_oid)?;
    let tip_stage_fingerprint = index_stage_fingerprint(repo)?;
    super::reset::reset_to_oid(repo, parent_oid, "soft")?;
    super::head::ensure_expected_head(repo, expected_branch, Some(parent_oid))?;

    match commit_locked(
        repo,
        summary,
        description,
        false,
        name,
        email,
        identity,
        identity_captured,
    ) {
        Ok(output) => {
            run_after_commit_test_hook();
            restore_index_snapshot(repo, &index_path, &snapshot, &tip_stage_fingerprint, true)
                .map(|_| output)
        }
        Err(error) => {
            if super::head::ensure_expected_head(repo, expected_branch, Some(parent_oid)).is_ok() {
                let _ = super::reset::reset_to_oid(repo, expected_oid, "soft");
            }
            match restore_index_snapshot(
                repo,
                &index_path,
                &snapshot,
                &tip_stage_fingerprint,
                false,
            ) {
                Ok(()) => Err(error),
                Err(restore_error) => Err(format!("{error}\n{restore_error}")),
            }
        }
    }
}
