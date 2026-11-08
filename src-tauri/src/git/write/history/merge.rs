//! Merging a branch into HEAD, and merging into an explicit destination.

use super::super::cli::{run_git_env, run_git_stdout_with_input};
use super::super::head::{checkout_expected_branch, ensure_expected_head, ensure_revision_at};

/// Check out the explicit destination branch at the oid the user saw, verify
/// the source revision has not moved, then merge that oid into it, always
/// creating a merge commit. The destination is carried through one backend call
/// instead of being an implicit frontend checkout.
///
/// The operand is the validated oid, not `source`, so a ref that moves after the
/// check cannot change what gets merged. Git would then title the commit after
/// the oid, so `fmt-merge-msg` is fed the line `git merge` would have fed it for
/// the ref; `--no-log` stops git appending a second shortlog under `merge.log`.
/// Conflict markers do label the incoming side with the oid: git has no way to
/// set that label, and the in-app conflict editor does not read it.
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
/// so that phrase must not be localized — which the message-locale pin every
/// git subprocess gets in `cli::git_command` guarantees.
pub fn merge_into(
    repo: &str,
    source: &str,
    expected_source_oid: &str,
    destination: Option<&str>,
    expected_destination_oid: &str,
) -> Result<String, String> {
    let _index_guard = super::super::index_lock::lock_index_writes(repo)?;
    let _identity_guard = super::super::identity::lock_identity_config(repo)?;
    let identity_args = super::super::identity::pinned_card_args(
        repo,
        super::super::identity::SigningOperation::Commit,
    )?;
    ensure_revision_at(repo, source, expected_source_oid)?;
    match destination {
        Some(branch) => checkout_expected_branch(repo, branch, expected_destination_oid)?,
        None => ensure_expected_head(repo, None, Some(expected_destination_oid))?,
    }
    let oid = ensure_revision_at(repo, source, expected_source_oid)?;
    // After the checkout: the message's "into <branch>" comes from HEAD.
    let message =
        run_git_stdout_with_input(repo, &["fmt-merge-msg"], &fmt_merge_msg_line(source, &oid))?;
    // Git names the reflog entry after its operand; keep the name a user can read.
    let name = source
        .strip_prefix("refs/heads/")
        .or_else(|| source.strip_prefix("refs/remotes/"))
        .unwrap_or(&oid);
    let mut args = identity_args.iter().map(String::as_str).collect::<Vec<_>>();
    args.extend([
        "merge",
        "--no-ff",
        "--no-edit",
        "--no-log",
        "-m",
        &message,
        &oid,
    ]);
    run_git_env(
        repo,
        &args,
        &[("GIT_REFLOG_ACTION", &format!("merge {name}"))],
    )
}

/// The `FETCH_HEAD`-format line naming `oid` the way `source` would. A commit
/// takes no ` of .`, which would garble its subject into `Merge commit commit`.
fn fmt_merge_msg_line(source: &str, oid: &str) -> String {
    if let Some(name) = source.strip_prefix("refs/heads/") {
        format!("{oid}\t\tbranch '{name}' of .\n")
    } else if let Some(name) = source.strip_prefix("refs/remotes/") {
        format!("{oid}\t\tremote-tracking branch '{name}' of .\n")
    } else {
        format!("{oid}\t\tcommit '{oid}'\n")
    }
}
