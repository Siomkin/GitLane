//! Merging a branch into HEAD, and merging into an explicit destination.

use super::super::branches::{qualify_branch_if_ambiguous, resolve_rev};
use super::super::head::{checkout_expected_branch, ensure_expected_head, ensure_revision_at};
use super::super::operands::ensure_operand;
use super::commit_runner::run_commit_git_stable_locked;

/// Merge `branch` into the current HEAD, always creating a merge commit.
///
/// The UI offers Fast-forward as a separate, explicit action and labels this
/// operation "Create a merge commit" (`src/lib/graphActions.ts`), so `--no-ff`
/// pins that outcome against the user's `merge.ff` config: default `--ff` would
/// silently fast-forward (no merge commit, contradicting the label) whenever the
/// move was a fast-forward, and `merge.ff=only` would fail an otherwise-mergeable
/// branch. `--no-edit` keeps git from ever launching an editor for the merge
/// message inside this GUI subprocess (there is no TTY to drive it).
///
/// Even under `--no-ff`, merging a branch whose tip is already reachable from
/// HEAD (equal tips included) creates nothing — git exits 0 with "Already up to
/// date." The store keys its toast off that phrase (`src/lib/mergeOutcome.ts`),
/// so diagnostics are pinned to `LC_ALL=C` to keep it locale-stable, same as
/// the tag-clobber detection in `remotes.rs`.
#[cfg(test)]
pub fn merge(repo: &str, branch: &str) -> Result<String, String> {
    let _index_guard = super::super::index_lock::lock_index_writes(repo)?;
    ensure_operand(branch)?;
    let _identity_guard = super::super::identity::lock_identity_config(repo)?;
    let identity_args = super::super::identity::pinned_commit_args(repo)?;
    merge_locked(repo, branch, &identity_args)
}

fn merge_locked(repo: &str, branch: &str, identity_args: &[String]) -> Result<String, String> {
    let target = qualify_branch_if_ambiguous(repo, branch);
    run_commit_git_stable_locked(
        repo,
        identity_args,
        &["merge", "--no-ff", "--no-edit", &target],
    )
}

/// Check out the explicit destination branch at the oid the user saw, verify
/// the source revision has not moved, then merge. The destination is carried
/// through one backend call instead of being an implicit frontend checkout.
pub fn merge_into(
    repo: &str,
    source: &str,
    expected_source_oid: &str,
    destination: Option<&str>,
    expected_destination_oid: &str,
) -> Result<String, String> {
    let _index_guard = super::super::index_lock::lock_index_writes(repo)?;
    let _identity_guard = super::super::identity::lock_identity_config(repo)?;
    let identity_args = super::super::identity::pinned_commit_args(repo)?;
    ensure_revision_at(repo, source, expected_source_oid)?;
    match destination {
        Some(branch) => checkout_expected_branch(repo, branch, expected_destination_oid)?,
        None => ensure_expected_head(repo, None, Some(expected_destination_oid))?,
    }
    ensure_revision_at(repo, source, expected_source_oid)?;
    merge_locked(repo, &merge_source_operand(repo, source), &identity_args)
}

/// The operand handed to `git merge` for a validated fully-qualified `source`.
/// Git copies the operand verbatim into the generated merge subject, so the
/// qualified form would leave "Merge branch 'refs/heads/feature'" in history.
/// Use the short human name whenever git would resolve it (and any
/// re-qualification in [`merge`]) to the exact validated commit; every other
/// case keeps the unambiguous qualified form — an accurate if uglier subject.
fn merge_source_operand(repo: &str, source: &str) -> String {
    let Some(short) = source
        .strip_prefix("refs/heads/")
        .or_else(|| source.strip_prefix("refs/remotes/"))
    else {
        return source.to_string();
    };
    let resolves_identically = ensure_operand(short).is_ok()
        && qualify_branch_if_ambiguous(repo, short) == short
        && matches!(
            (resolve_rev(repo, short), resolve_rev(repo, source)),
            (Ok(via_short), Ok(via_source)) if via_short == via_source
        );
    if resolves_identically {
        short.to_string()
    } else {
        source.to_string()
    }
}
