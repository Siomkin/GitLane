//! Conflict-resolution writes and sequencer controls.

use crate::git::handoff;
use crate::git::worktree_fs::open_regular_worktree_file;

use super::cli::{run_git, run_git_env, run_git_env_stable_diagnostics, run_git_literal_paths};
use super::worktrees::{drop_stash_by_oid, worktree_git_dir};

// ---- Conflict resolution (merge / rebase / cherry-pick / revert) ----
//
// `merge`/`rebase`/`cherry_pick`/`revert` above can stop on conflicts; these
// resolve the conflicted state and drive the operation to completion. The
// *detection* side (which operation, which files) is a libgit2 read in
// `git::conflicts`; everything here shells out to real `git` so hooks, rerere,
// signing, and the sequencer's own state machine all behave exactly as the CLI.

/// Resolve a conflicted file by taking one whole side. `side` is "ours"
/// (current branch) or "theirs" (incoming). Checks that stage's content into the
/// worktree and stages it; when the chosen side *deleted* the file (so it has no
/// stage to check out) the file is removed instead — covering modify/delete and
/// add/add conflicts with one path.
pub fn accept_conflict_side(repo: &str, file: &str, side: &str) -> Result<String, String> {
    // No `ensure_operand` on `file`: every git call below passes it after `--`
    // in literal-pathspec mode, so `-foo` is safe and `:(glob)*` cannot expand.
    // `ensure_conflicted` additionally gates it to the index conflict set.
    ensure_conflicted(repo, file)?;
    let (flag, stage) = match side {
        "ours" => ("--ours", "2"),
        "theirs" => ("--theirs", "3"),
        _ => return Err(format!("unknown conflict side {side:?}")),
    };
    match run_git_literal_paths(repo, &["checkout", flag, "--", file]) {
        Ok(_) => {
            run_git_literal_paths(repo, &["add", "-A", "--", file])?;
        }
        // A failed checkout means "accept the deletion" ONLY when the chosen side
        // genuinely has no staged version — a modify/delete conflict. For any
        // other failure (a lock, a permission error, a corrupt index) we must
        // surface the error rather than force-deleting the user's file.
        Err(e) => {
            if conflict_stage_absent(repo, file, stage) {
                run_git_literal_paths(repo, &["rm", "-f", "--", file])?;
            } else {
                return Err(e);
            }
        }
    }
    Ok(format!("Resolved {file} ({side})"))
}

/// True when unmerged `stage` (2 = ours, 3 = theirs) is absent for `file` in the
/// index — i.e. that side deleted the file. Parses `git ls-files -u` lines
/// (`<mode> <oid> <stage>\t<path>`). A read failure returns false so we never
/// delete on an indeterminate state.
pub(super) fn conflict_stage_absent(repo: &str, file: &str, stage: &str) -> bool {
    match run_git_literal_paths(repo, &["ls-files", "-u", "--", file]) {
        Ok(out) => !out.lines().any(|line| {
            line.split('\t')
                .next()
                .and_then(|meta| meta.split_whitespace().nth(2))
                == Some(stage)
        }),
        Err(_) => false,
    }
}

/// True when `file` has unmerged (conflict) index entries — i.e. it is a path the
/// active operation actually left conflicted. The per-file resolution commands
/// require this so a renderer-supplied path can only touch files genuinely in the
/// conflict set, not an arbitrary (even repo-relative) file.
fn is_unmerged(repo: &str, file: &str) -> bool {
    run_git_literal_paths(repo, &["ls-files", "-u", "--", file])
        .map(|out| !out.trim().is_empty())
        .unwrap_or(false)
}

/// Reject a resolution targeting a path that isn't currently conflicted.
fn ensure_conflicted(repo: &str, file: &str) -> Result<(), String> {
    if is_unmerged(repo, file) {
        Ok(())
    } else {
        Err(format!("{file:?} is not a conflicted path"))
    }
}

/// True when `git checkout --merge` can actually recreate a conflict for `file`:
/// it is still unmerged, or git holds **resolve-undo** information for it from an
/// earlier resolution in the current operation. For any other tracked path
/// `checkout --merge` would silently overwrite the worktree with the index copy,
/// discarding unstaged edits — so those must be refused. `git ls-files
/// --resolve-undo` is git's own record of paths it can re-conflict.
fn can_reconflict(repo: &str, file: &str) -> bool {
    if is_unmerged(repo, file) {
        return true;
    }
    run_git_literal_paths(repo, &["ls-files", "--resolve-undo", "--", file])
        .map(|out| !out.trim().is_empty())
        .unwrap_or(false)
}

/// Write the merged `content` to a conflicted file and stage it — backs the
/// in-app hunk editor, which reconstructs the resolved text from the user's
/// per-hunk choices. The path is resolved against the worktree root (and checked
/// to stay inside it) so it is correct for linked worktrees and never escapes.
pub fn resolve_conflict_file(repo: &str, file: &str, content: &str) -> Result<String, String> {
    // `file` is staged after `--` in literal mode and resolved through held
    // no-follow directory handles, so no `ensure_operand` dash-guard is needed
    // — and it would wrongly block `-foo`.
    ensure_conflicted(repo, file)?;
    let root = run_git(repo, &["rev-parse", "--show-toplevel"])?;
    let target = open_regular_worktree_file(std::path::Path::new(root.trim()), file)
        .map_err(|e| format!("open {file}: {e}"))?;
    target
        .replace_atomic(content.as_bytes())
        .map_err(|e| format!("write {file}: {e}"))?;
    run_git_literal_paths(repo, &["add", "--", file])?;
    Ok(format!("Resolved {file}"))
}

/// Mark a conflicted file resolved by staging it as it currently sits on disk
/// (after the user edited it in their own editor). `-A` also stages a deletion.
pub fn mark_conflict_resolved(repo: &str, file: &str) -> Result<String, String> {
    // `file` passes after `--` in literal mode and is gated by
    // `ensure_conflicted`. No dash-guard (see `accept_conflict_side`) so a
    // conflicted `-foo` can be staged.
    ensure_conflicted(repo, file)?;
    run_git_literal_paths(repo, &["add", "-A", "--", file])?;
    Ok(format!("Staged {file}"))
}

/// Restore the conflict markers for a file that was already resolved/staged so
/// it can be re-resolved (`git checkout --merge`) — the inverse of staging a
/// resolution, exposed as the per-file "Unstage" affordance.
pub fn reconflict_file(repo: &str, file: &str) -> Result<String, String> {
    // `file` is passed after `--` in literal mode, so no dash-guard is needed
    // (it would block a conflicted `-foo`).
    // Guard against clobbering: `git checkout --merge` on a path git can't
    // re-conflict (an unrelated tracked file) silently overwrites the worktree
    // with the index copy, discarding unstaged edits. Only allow it for paths
    // that are still unmerged or carry resolve-undo info (the inverse of staging
    // a resolution).
    if !can_reconflict(repo, file) {
        return Err(format!(
            "cannot restore the conflict in {file:?} — it is not an unresolved or just-resolved conflict path"
        ));
    }
    run_git_literal_paths(repo, &["checkout", "--merge", "--", file])?;
    Ok(format!("Restored conflict in {file}"))
}

/// Recognise the state git reports when a cherry-pick/revert patch becomes
/// **empty** after conflict resolution — git prints "The previous cherry-pick
/// (or revert) is now empty…" and stops, asking for `--skip` or `git commit
/// --allow-empty`. Matched on the specific "is now empty" phrase so unrelated
/// `--continue` failures (e.g. a hook rejecting an otherwise non-empty commit)
/// are NOT mistaken for empty and silently skipped.
pub(super) fn is_empty_after_resolution(msg: &str) -> bool {
    msg.to_lowercase().contains("is now empty")
}

fn pinned_operation_identity_args(
    repo: &str,
    name: Option<&str>,
    email: Option<&str>,
    identity: Option<&crate::git::types::RepoIdentity>,
    identity_captured: bool,
) -> Result<Vec<String>, String> {
    let expected_author = match (name, email) {
        (Some(n), Some(e)) if !n.is_empty() && !e.is_empty() => Some((n, e)),
        _ => None,
    };
    let mut args = Vec::new();
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
    Ok(args)
}

/// Continue the active operation once its conflicts are resolved and staged.
/// `kind` is the operation key from `git::conflicts::operation_status`. `GIT_EDITOR=true`
/// keeps the prepared message (MERGE_MSG / the replayed commit) without opening
/// an editor, and the bound identity is pinned with `-c user.*` exactly as
/// [`commit`] does so the resulting commit carries the repo's account identity.
///
/// If a cherry-pick/revert patch resolved to an empty change, git refuses to
/// `--continue` and asks for `--skip`; we do exactly that — the change is already
/// present, so the now-empty patch is skipped and the operation advances. This
/// keeps "Continue" working instead of surfacing a raw git error.
pub fn continue_operation(
    repo: &str,
    kind: &str,
    name: Option<&str>,
    email: Option<&str>,
    identity: Option<&crate::git::types::RepoIdentity>,
    identity_captured: bool,
) -> Result<String, String> {
    // A worktree-handoff carry (GL-74) isn't a git sequencer — finishing it drops
    // the kept stashes and clears the marker rather than running `--continue`.
    if kind == handoff::CARRY_KIND {
        return continue_carry(repo);
    }
    let _identity_guard = super::identity::lock_identity_config(repo)?;
    let pre = pinned_operation_identity_args(repo, name, email, identity, identity_captured)?;
    let sub: &[&str] = match kind {
        "merge" => &["merge", "--continue"],
        "rebase" => &["rebase", "--continue"],
        "cherry-pick" => &["cherry-pick", "--continue"],
        "revert" => &["revert", "--continue"],
        _ => return Err(format!("no active operation to continue ({kind})")),
    };
    let mut args: Vec<&str> = pre.iter().map(String::as_str).collect();
    args.extend_from_slice(sub);
    match run_git_env_stable_diagnostics(repo, &args, &[("GIT_EDITOR", "true")]) {
        Ok(out) => Ok(out),
        Err(e) if matches!(kind, "cherry-pick" | "revert") && is_empty_after_resolution(&e) => {
            let mut skip_args: Vec<&str> = pre.iter().map(String::as_str).collect();
            skip_args.extend([kind, "--skip"]);
            run_git_env_stable_diagnostics(repo, &skip_args, &[("GIT_EDITOR", "true")])
        }
        Err(e) => Err(e),
    }
}

/// Abort the active operation, restoring the pre-operation state. `kind` is the
/// operation key from `git::conflicts::operation_status`.
pub fn abort_operation(repo: &str, kind: &str) -> Result<String, String> {
    if kind == handoff::CARRY_KIND {
        return abort_carry(repo);
    }
    let sub: &[&str] = match kind {
        "merge" => &["merge", "--abort"],
        "rebase" => &["rebase", "--abort"],
        "cherry-pick" => &["cherry-pick", "--abort"],
        "revert" => &["revert", "--abort"],
        _ => return Err(format!("no active operation to abort ({kind})")),
    };
    run_git(repo, sub)?;
    Ok(format!("Aborted {kind}"))
}

/// Finish a worktree-handoff carry once its conflicts are resolved and staged:
/// drop the stashes the handoff kept for recovery, then clear the marker. The
/// resolved changes stay in the working tree — that's the whole point of the
/// carry. Refuses while any unmerged path remains (the workspace also gates this).
fn continue_carry(repo: &str) -> Result<String, String> {
    if !run_git(repo, &["ls-files", "-u"])?.trim().is_empty() {
        return Err("Resolve and stage the remaining conflicts before finishing the carry.".into());
    }
    let git_dir = worktree_git_dir(repo)?;
    if let Some(marker) = handoff::read_marker(&git_dir) {
        for oid in marker
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
        {
            drop_stash_by_oid(repo, oid)?;
        }
    }
    handoff::clear_marker(&git_dir);
    Ok("Carried changes applied".to_string())
}

/// Abort a worktree-handoff carry: discard the conflicted re-application back to
/// the branch tip and clear the marker. The kept stashes are left on the stack
/// (they were recorded in the marker), so the carried work is preserved and can
/// be re-applied — nothing is dropped here.
fn abort_carry(repo: &str) -> Result<String, String> {
    let git_dir = worktree_git_dir(repo)?;
    run_git(repo, &["reset", "--hard", "HEAD"])?;
    handoff::clear_marker(&git_dir);
    Ok("Discarded the carry — your changes are preserved in a stash".to_string())
}

/// Skip the current commit in a sequencer operation (rebase/cherry-pick/revert).
/// Merge has no skip and is rejected. `kind` is the operation key.
pub fn skip_operation(
    repo: &str,
    kind: &str,
    name: Option<&str>,
    email: Option<&str>,
    identity: Option<&crate::git::types::RepoIdentity>,
    identity_captured: bool,
) -> Result<String, String> {
    let sub: &[&str] = match kind {
        "rebase" => &["rebase", "--skip"],
        "cherry-pick" => &["cherry-pick", "--skip"],
        "revert" => &["revert", "--skip"],
        _ => return Err(format!("cannot skip a {kind} operation")),
    };
    let _identity_guard = super::identity::lock_identity_config(repo)?;
    let pre = pinned_operation_identity_args(repo, name, email, identity, identity_captured)?;
    let mut args: Vec<&str> = pre.iter().map(String::as_str).collect();
    args.extend_from_slice(sub);
    run_git_env(repo, &args, &[("GIT_EDITOR", "true")])
}
