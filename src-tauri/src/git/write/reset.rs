//! Guarded soft, mixed, and hard reset writes.

use super::cli::run_git;
use super::hard_reset_lease;
use super::head::{
    checkout_expected_branch, ensure_commit_exists, ensure_expected_branch_tip,
    ensure_expected_head,
};
use super::operands::ensure_exact_oid;

/// Reset onto an exact captured oid, with **no** ref-name qualification
/// (GL-302).
///
/// Every reset caller now resolves its target up front — `preview_reset`
/// qualifies and resolves the user's ref, and squash carries the parent oid it
/// already verified — so nothing here takes a name. That matters: a bare full
/// oid resolves to the object itself, but `refs/heads/<oid>` — what
/// `qualify_branch_if_ambiguous` would produce if a branch *and* a tag are both
/// named after the 40-hex string, which git permits — resolves to that branch's
/// tip, which can move out from under the caller after it resolved the target.
///
/// [`ensure_exact_oid`] makes that a checked precondition rather than a caller
/// convention: a ref name reaching here would sidestep the preview's
/// qualification and reintroduce exactly the bug the unqualified operand avoids.
///
/// Soft and mixed only — hard reset mutates through its validated scope in
/// [`reset_branch`], not through a repo path git would re-resolve.
pub(super) fn reset_to_oid(repo: &str, target_oid: &str, mode: &str) -> Result<String, String> {
    ensure_exact_oid(target_oid)?;
    let flag = if mode == "soft" { "--soft" } else { "--mixed" };
    run_git(repo, &["reset", flag, target_oid])
}

/// Tip/HEAD compare-and-swap for hard reset without switching branches.
///
/// The hard-reset lease fingerprints the already-checked-out worktree. A
/// `git switch` here would mutate that worktree before the lease is
/// revalidated, leaving the repo on the wrong branch if validation then fails.
fn prepare_hard_reset_subject(
    repo: &str,
    source: Option<&str>,
    expected_source_oid: Option<&str>,
) -> Result<(), String> {
    match (source, expected_source_oid) {
        (Some(branch), Some(oid)) => {
            ensure_expected_branch_tip(repo, branch, oid)?;
            hard_reset_lease::ensure_source_is_checked_out(repo, branch)?;
            ensure_expected_head(repo, Some(branch), Some(oid))
        }
        (None, oid) => ensure_expected_head(repo, None, oid),
        (Some(_), None) => {
            Err("The branch has no expected commit. Refresh and try again.".to_string())
        }
    }
}

/// Reset the explicit source branch/HEAD snapshot to a captured target oid.
/// Soft/mixed mode checks out a named source branch when needed. Hard mode
/// never switches — it only resets the already-checked-out worktree the lease
/// covered.
///
/// Hard mode requires [`expected_state`] — the opaque lease from
/// [`preview_reset`] — and re-validates it immediately before `git reset
/// --hard` so tip/HEAD probes cannot open a window for unleased worktree
/// edits (GL-302).
#[allow(clippy::too_many_arguments)] // Internal half of the guarded reset IPC contract.
pub fn reset_branch(
    repo: &str,
    source: Option<&str>,
    expected_source_oid: Option<&str>,
    target_oid: &str,
    mode: &str,
    expected_state: Option<&str>,
    expected_head_branch: Option<&str>,
    expected_head_oid: Option<&str>,
) -> Result<String, String> {
    let mode = match mode {
        "soft" | "mixed" | "hard" => mode,
        _ => "mixed",
    };
    if mode == "hard" {
        let expected_state = expected_state.ok_or_else(|| {
            "Hard reset requires the exact-state lease from its confirmation. Preview again."
                .to_string()
        })?;
        ensure_exact_oid(target_oid)?;
        // Tip/HEAD CAS first (no switch), then lease — never mutate the worktree
        // before the lease re-capture that sits next to `git reset --hard`.
        prepare_hard_reset_subject(repo, source, expected_source_oid)?;
        ensure_commit_exists(repo, target_oid)?;
        hard_reset_lease::run_before_mutation_test_hook();
        let validated = hard_reset_lease::validate_at_mutation_boundary(
            repo,
            target_oid,
            expected_state,
            expected_head_branch,
            expected_head_oid,
        )?;
        hard_reset_lease::run_after_validation_test_hook();
        // Mutate through the scope the lease just proved current — passing `repo`
        // would let git re-resolve it, and a `.git`-file retarget in this window
        // would redirect the reset out of the leased worktree (GL-302 review).
        // `--no-replace-objects` keeps a mid-flight refs/replace entry from
        // landing the leased oid on a different tree. Residual TOCTOU between
        // the re-capture and the process launch is the same accepted class as
        // discard-all: no worktree lock without a larger design change.
        return validated.run(&["--no-replace-objects", "reset", "--hard", target_oid]);
    }
    if expected_state.is_some() {
        return Err(
            "Soft/mixed reset does not accept a hard-reset worktree lease. Preview again."
                .to_string(),
        );
    }
    match (source, expected_source_oid) {
        (Some(branch), Some(oid)) => checkout_expected_branch(repo, branch, oid)?,
        (None, oid) => ensure_expected_head(repo, None, oid)?,
        (Some(_), None) => {
            return Err("The branch has no expected commit. Refresh and try again.".to_string())
        }
    }
    ensure_commit_exists(repo, target_oid)?;
    reset_to_oid(repo, target_oid, mode)
}
