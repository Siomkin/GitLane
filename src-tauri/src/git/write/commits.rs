//! Commit, amend, and squash writes.

use super::cli::{run_git, run_git_literal_paths, run_git_stdout, run_git_stdout_raw};
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

/// The live index of `repo` — the per-worktree git dir's own `index`, so a
/// linked worktree snapshots its staging and not the main checkout's. Parsed
/// from stdout alone: [`run_git`] concatenates stderr onto the result, and a
/// warning git wrote there would land inside the path.
fn absolute_index_path(repo: &str) -> Result<PathBuf, String> {
    let git_dir = run_git_stdout(repo, &["rev-parse", "--absolute-git-dir"])?;
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

/// A GitLane-owned scratch path beside the index. Unique per process *and* per
/// call: two squashes on one worktree would otherwise share a fixed name and
/// overwrite each other's snapshot mid-flight.
fn squash_temp_path(index_path: &Path, kind: &str) -> PathBuf {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    index_path.with_extension(format!(
        "gitlane-squash-{kind}-{}-{}",
        std::process::id(),
        SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ))
}

fn write_index_bytes(path: &Path, bytes: &[u8]) -> Result<(), String> {
    // Deliberate exception to "writes go through the git CLI": git has no
    // porcelain that reloads an exact on-disk index, and anything short of the
    // exact bytes loses staged mode bits, intent-to-add, and partial stages.
    // Write beside the index and rename into place; `handoff.rs` is the
    // precedent for GitLane writing under `.git` via `std::fs`. This does not
    // take `index.lock`, so a terminal `git` staging inside the window is caught
    // by the tree comparison rather than serialized against — an accepted risk.
    // Ordinary staging mutations stay on `run_git`.
    let tmp = squash_temp_path(path, "restore");
    std::fs::write(&tmp, bytes)
        .map_err(|error| format!("Could not restore the git index: {error}"))?;
    std::fs::rename(&tmp, path).map_err(|error| {
        let _ = std::fs::remove_file(&tmp);
        format!("Could not restore the git index: {error}")
    })
}

/// Paths where the live index diverges from `tree_ish`. Comparing against a
/// tree — rather than a fingerprint captured before the commit — is what lets a
/// pre-commit hook stage into the index without being mistaken for a concurrent
/// writer: whatever the hook added is part of the commit we just made, so the
/// index still matches it. Empty output means nobody else staged during squash.
fn index_divergence_from(repo: &str, tree_ish: &str) -> Result<String, String> {
    run_git_stdout(repo, &["diff-index", "--cached", "--name-only", tree_ish])
}

/// Materialize the squash-owned tip tree into the index without touching the
/// worktree (`read-tree` without `-u`).
fn install_squash_owned_tree(repo: &str, tip_oid: &str) -> Result<(), String> {
    run_git(repo, &["read-tree", tip_oid]).map(|_| ())
}

/// Split git's NUL-delimited output without decoding it. Paths make a round trip
/// back into a pathspec file, so a non-UTF-8 name has to survive as bytes.
fn split_nul(raw: &[u8]) -> Vec<Vec<u8>> {
    raw.split(|byte| *byte == 0)
        .filter(|part| !part.is_empty())
        .map(<[u8]>::to_vec)
        .collect()
}

/// Paths the caller had staged against `tree_ish` — their pre-staged work.
fn staged_paths_against(repo: &str, tree_ish: &str) -> Result<Vec<Vec<u8>>, String> {
    let raw = run_git_stdout_raw(
        repo,
        &["diff-index", "--cached", "-z", "--name-only", tree_ish],
    )?;
    Ok(split_nul(&raw))
}

/// Re-stage what a pre-commit hook contributed to the landed commit. The restored
/// snapshot predates the hook, so a path the hook *added* reads as a staged
/// deletion against the new HEAD, and a file it reformatted reads as a staged
/// revert — both invite the user to undo the hook on their next commit. Paths the
/// caller had staged themselves are left alone: preserving pre-staged work
/// outranks matching the hook.
fn restage_hook_contribution(
    repo: &str,
    index_path: &Path,
    tip_oid: &str,
    landed_oid: &str,
    caller_staged: &[Vec<u8>],
) -> Result<(), String> {
    // `--no-renames` pins the invariant this depends on: both endpoints of a
    // rename must be listed, or the pre-rename path stays staged for
    // resurrection. Plumbing ignores `diff.renames` today; saying so keeps this
    // correct if that ever changes.
    let raw = run_git_stdout_raw(
        repo,
        &[
            "diff-tree",
            "-r",
            "-z",
            "--no-renames",
            "--name-only",
            tip_oid,
            landed_oid,
        ],
    )?;
    let owned: std::collections::HashSet<&[u8]> = caller_staged.iter().map(Vec::as_slice).collect();
    let mut pathspec = Vec::new();
    for path in split_nul(&raw) {
        if owned.contains(path.as_slice()) {
            continue;
        }
        pathspec.extend_from_slice(&path);
        pathspec.push(0);
    }
    if pathspec.is_empty() {
        return Ok(());
    }

    // A pathspec *file* keeps the names as bytes; `-z` output would otherwise have
    // to become UTF-8 to ride in argv.
    let spec_file = squash_temp_path(index_path, "pathspec");
    let spec_arg = match spec_file.to_str() {
        Some(path) => format!("--pathspec-from-file={path}"),
        None => return Err(restage_failure("the git directory path is not valid UTF-8")),
    };
    std::fs::write(&spec_file, &pathspec).map_err(|error| restage_failure(&error.to_string()))?;
    let reset = run_git_literal_paths(
        repo,
        &["reset", "-q", landed_oid, &spec_arg, "--pathspec-file-nul"],
    );
    let _ = std::fs::remove_file(&spec_file);
    reset.map(|_| ()).map_err(|error| restage_failure(&error))
}

fn restage_failure(cause: &str) -> String {
    format!(
        "Squash commit was created and pre-staged work was restored, but paths a pre-commit hook \
         added could not be re-staged: {cause}"
    )
}

/// Restore the pre-squash index snapshot only while the live index still holds
/// exactly what this squash staged (compare-and-restore). `expected_tree_ish` is
/// the landed squash commit on success and the untouched tip on failure — in
/// both cases the tree the index must still match for a restore to be safe.
fn restore_index_snapshot(
    repo: &str,
    index_path: &Path,
    snapshot: &[u8],
    expected_tree_ish: &str,
    commit_succeeded: bool,
) -> Result<(), String> {
    if !index_divergence_from(repo, expected_tree_ish)?
        .trim()
        .is_empty()
    {
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
    static SQUASH_AFTER_READ_TREE_TEST_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
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

/// Derail the guarded phase right after the tip tree lands in the index, so a
/// test can prove a failure between `read-tree` and the commit still restores
/// the caller's pre-staged work (GL-307).
#[cfg(test)]
pub(crate) fn set_squash_after_read_tree_test_hook(hook: impl FnOnce() + 'static) {
    SQUASH_AFTER_READ_TREE_TEST_HOOK.with(|slot| {
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

#[cfg(test)]
fn run_after_read_tree_test_hook() {
    SQUASH_AFTER_READ_TREE_TEST_HOOK.with(|slot| {
        if let Some(hook) = slot.borrow_mut().take() {
            hook();
        }
    });
}

#[cfg(not(test))]
fn run_after_commit_test_hook() {}

#[cfg(not(test))]
fn run_after_read_tree_test_hook() {}

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
    // Captured before the tip tree replaces the caller's staging, so the hook
    // reconciliation below can tell their staged paths from the hook's.
    let caller_staged = staged_paths_against(repo, expected_oid)?;
    install_squash_owned_tree(repo, expected_oid)?;

    // The live index now holds the squash-owned tip tree instead of the caller's
    // staging, so every exit below has to reach compare-and-restore. Collecting
    // the guarded phase into one `Result` is what keeps a `?` on the soft reset
    // or the HEAD guard from returning early and dropping pre-staged work.
    let committed = (|| {
        run_after_read_tree_test_hook();
        super::reset::reset_to_oid(repo, parent_oid, "soft")?;
        super::head::ensure_expected_head(repo, expected_branch, Some(parent_oid))?;
        commit_locked(
            repo,
            summary,
            description,
            false,
            name,
            email,
            identity,
            identity_captured,
        )
    })();

    match committed {
        Ok(output) => {
            // Pin the commit we just made. Everything below would otherwise read
            // the moving `HEAD`, and a concurrent checkout between two of those
            // reads could compare — or re-stage from — a different commit.
            let landed_oid = run_git_stdout(repo, &["rev-parse", "HEAD"])?
                .trim()
                .to_string();
            run_after_commit_test_hook();
            // Compare against the commit we just made, not the pre-commit tip: a
            // pre-commit hook may legitimately have staged into the index, and
            // whatever it added is already part of this commit.
            restore_index_snapshot(repo, &index_path, &snapshot, &landed_oid, true)?;
            restage_hook_contribution(
                repo,
                &index_path,
                expected_oid,
                &landed_oid,
                &caller_staged,
            )?;
            Ok(output)
        }
        Err(error) => {
            if super::head::ensure_expected_head(repo, expected_branch, Some(parent_oid)).is_ok() {
                let _ = super::reset::reset_to_oid(repo, expected_oid, "soft");
            }
            // Nothing landed, so the index must still be the tip tree we installed
            // — regardless of whether the HEAD rollback above was ours to make.
            match restore_index_snapshot(repo, &index_path, &snapshot, expected_oid, false) {
                Ok(()) => Err(error),
                Err(restore_error) => Err(format!("{error}\n{restore_error}")),
            }
        }
    }
}
