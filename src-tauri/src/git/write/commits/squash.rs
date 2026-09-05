//! Replacing the current tip range with one commit behind a single guarded
//! IPC contract, and the test hooks that derail it mid-flight.

use super::super::cli::run_git_stdout;
use super::create::commit_locked;
use super::hook_restage::{restage_hook_contribution, staged_paths_against};
use super::index_snapshot::{
    absolute_index_path, ensure_index_not_unmerged, install_squash_owned_tree, read_index_bytes,
    restore_index_snapshot,
};
use crate::git::types::{CommitRequest, SquashCommitsRequest};

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
pub fn squash_commits(repo: &str, request: &SquashCommitsRequest) -> Result<String, String> {
    let _index_guard = super::super::index_lock::lock_index_writes(repo)?;
    let _identity_guard = super::super::identity::lock_identity_config(repo)?;
    super::super::head::ensure_expected_head(
        repo,
        request.expected_branch.as_deref(),
        Some(&request.expected_oid),
    )?;
    super::super::head::ensure_commit_exists(repo, &request.parent_oid)?;
    ensure_index_not_unmerged(repo)?;

    let index_path = absolute_index_path(repo)?;
    let snapshot = read_index_bytes(&index_path)?;
    // Captured before the tip tree replaces the caller's staging, so the hook
    // reconciliation below can tell their staged paths from the hook's.
    let caller_staged = staged_paths_against(repo, &request.expected_oid)?;
    install_squash_owned_tree(repo, &request.expected_oid)?;

    // The live index now holds the squash-owned tip tree instead of the caller's
    // staging, so every exit below has to reach compare-and-restore. Collecting
    // the guarded phase into one `Result` is what keeps a `?` on the soft reset
    // or the HEAD guard from returning early and dropping pre-staged work.
    let committed = (|| {
        run_after_read_tree_test_hook();
        super::super::reset::reset_to_oid(
            repo,
            &request.parent_oid,
            super::super::reset::ResetMode::Soft,
        )?;
        super::super::head::ensure_expected_head(
            repo,
            request.expected_branch.as_deref(),
            Some(&request.parent_oid),
        )?;
        commit_locked(
            repo,
            &CommitRequest {
                expected_branch: None,
                expected_oid: None,
                summary: request.summary.clone(),
                description: request.description.clone(),
                amend: false,
                name: request.name.clone(),
                email: request.email.clone(),
                identity: request.identity.clone(),
            },
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
                &request.expected_oid,
                &landed_oid,
                &caller_staged,
            )?;
            Ok(output)
        }
        Err(error) => {
            if super::super::head::ensure_expected_head(
                repo,
                request.expected_branch.as_deref(),
                Some(&request.parent_oid),
            )
            .is_ok()
            {
                let _ = super::super::reset::reset_to_oid(
                    repo,
                    &request.expected_oid,
                    super::super::reset::ResetMode::Soft,
                );
            }
            // Nothing landed, so the index must still be the tip tree we installed
            // — regardless of whether the HEAD rollback above was ours to make.
            match restore_index_snapshot(repo, &index_path, &snapshot, &request.expected_oid, false)
            {
                Ok(()) => Err(error),
                Err(restore_error) => Err(format!("{error}\n{restore_error}")),
            }
        }
    }
}
