//! `git stash push` execution with split-state recovery.
//!
//! `git stash push --include-untracked` is not atomic. Internally it stores the
//! stash entry first, then clears the working tree in two steps: a blanket
//! `git clean --force --quiet -d :/` for the untracked files it just captured,
//! followed by `git reset --hard` for the tracked ones. When that `clean` cannot
//! remove a path — an untracked directory whose parent is read-only is the case
//! users hit — git aborts **before** the reset and exits non-zero.
//!
//! The result is the worst kind of split state: the entry is in `refs/stash`
//! with every change safely inside it, yet the tracked edits are still sitting
//! in the working tree, and GitLane surfaced git's raw
//! `warning: failed to remove …: Permission denied` as a plain failure toast.
//! GL-218 fixed this same unsafe "destructive step runs after a cleanup that may
//! fail" ordering in Discard all; stash was the remaining caller with it.
//!
//! Git owns stash creation here — this module only detects that split state and
//! finishes the restore git skipped, and only once it has *proved* the working
//! tree is already inside the stored entry (see [`unproved_coverage`]). The
//! guarantee is parity: recovery leaves exactly the state a **successful**
//! `git stash push -u` would have left, never a worse one.
//!
//! Two limits are inherited from git rather than introduced here, and both apply
//! equally to a push that succeeds outright. Local changes hidden by
//! `assume-unchanged`/`skip-worktree` are invisible to the snapshot the proof
//! takes, exactly as they are to git's own stash; and the gap between that
//! snapshot and the reset is a window an external terminal could write into,
//! much like git's own gap between its cleanup and its reset. The tracked
//! content is in `refs/stash` throughout, so neither window risks losing work
//! that was not already at risk.
//!
//! GL-218's *other* half — that same blanket `clean -d` also deleting empty
//! untracked directories no stash can restore — is handled by [`empty_dirs`],
//! which records them before the push and puts back whichever git took. That
//! runs around the push rather than inside it, so it applies whether the push
//! succeeds, recovers here, or fails outright.

use super::cli::{run_git, run_git_allow_exit_codes};
use super::empty_dirs;

/// A completed `git stash push`.
pub(super) struct StashPush {
    /// Git's own output, or GitLane's account of the restore it had to finish.
    pub message: String,
    /// The stash commit this push created, when it created one.
    pub oid: Option<String>,
    /// Whether GitLane had to say something about this push beyond "it worked":
    /// it completed a restore git abandoned, or could not put an empty untracked
    /// directory back. `message` then carries the detail and has to reach the
    /// user verbatim rather than being normalised away as a routine success.
    pub recovered: bool,
}

impl StashPush {
    /// Fold in the directories the push took that could not be put back. Their
    /// content was never at risk — a file-free directory has none — but the
    /// layout change is the user's to know about, so it outranks a quiet
    /// success and never silently disappears.
    fn qualified_with(mut self, unpreserved: &[String]) -> Self {
        if unpreserved.is_empty() {
            return self;
        }
        let names = unpreserved.join(", ");
        self.message = format!(
            "{} Git's cleanup also removed empty untracked director{} GitLane could not recreate: {names}. They held no files, so nothing was lost but the folders themselves.",
            self.message.trim_end(),
            if unpreserved.len() == 1 { "y" } else { "ies" },
        );
        self.recovered = true;
        self
    }
}

/// Run a `git stash push …` argument list, recovering from the interrupted
/// cleanup described in the module docs. `args` is the full argument list so
/// callers keep control of their own flags (`-m <message>` for worktree
/// handoff, plain `--include-untracked` for the Stash action).
pub(super) fn push_stash(repo: &str, args: &[&str]) -> Result<StashPush, String> {
    let before = stash_tip(repo)?;
    // Captured before anything is mutated, and put back below whatever the push
    // does — git's cleanup runs early enough to take these even on a push that
    // then fails, so the restore cannot be conditional on success.
    //
    // This sits in the shared helper because the worktree handoff stashes twice
    // and loses directories both times. Each worktree keeps its own: an empty
    // directory is local filesystem layout, not branch content — git records
    // none anywhere, which is the whole reason a stash cannot carry one — so it
    // stays put rather than following the branch. For the destination that is a
    // plain stash-and-reapply round trip inside one worktree; for the source it
    // is the scratch layout of the checkout it goes on being.
    let empty_dirs = empty_dirs::capture(repo)?;
    let outcome = run_push(repo, args, before.as_deref());
    let unpreserved = empty_dirs::restore(repo, &empty_dirs);
    outcome.map(|push| push.qualified_with(&unpreserved))
}

fn run_push(repo: &str, args: &[&str], before: Option<&str>) -> Result<StashPush, String> {
    match run_git(repo, args) {
        Ok(message) => Ok(StashPush {
            message,
            oid: created_stash(repo, before)?,
            recovered: false,
        }),
        Err(error) => {
            // Recovery needs an entry that provably holds the working tree, and
            // the moved ref is the usual way to find one. It is not the only
            // way: a stash commit's oid embeds its message, and git timestamps
            // commits only to the second, so re-stashing identical changes
            // reproduces the previous oid and leaves the tip standing still.
            // The worktree caller sidesteps that with a unique message; the
            // plain Stash action has no message to make unique, so fall back to
            // the standing tip. Coverage — not ref movement — is what makes the
            // restore safe, and every candidate goes through the same proof.
            let created = created_stash(repo, before)?;
            let Some(oid) = created.clone().or(stash_tip(repo)?) else {
                return Err(error);
            };
            match unproved_coverage(repo, &oid) {
                // Nothing stored and nothing that covers the tree: an ordinary
                // failure — a locked index, an unborn HEAD, a bad pathspec.
                // Report git's own diagnosis rather than a split-state story.
                Some(_) if created.is_none() => Err(error),
                Some(reason) => Err(split_state_error(&oid, &reason, &error)),
                None => Ok(StashPush {
                    message: finish_interrupted_push(repo, &oid, &error)?,
                    oid: created,
                    recovered: true,
                }),
            }
        }
    }
}

/// The stash entry a push created, or `None` when `refs/stash` did not move.
fn created_stash(repo: &str, before: Option<&str>) -> Result<Option<String>, String> {
    Ok(stash_tip(repo)?.filter(|after| Some(after.as_str()) != before))
}

/// `refs/stash`, or `None` in a repository that has never stashed. `rev-parse
/// --verify --quiet` exits 1 for a missing ref, which is not a failure here.
fn stash_tip(repo: &str) -> Result<Option<String>, String> {
    let oid = run_git_allow_exit_codes(
        repo,
        &["rev-parse", "--verify", "--quiet", "refs/stash"],
        &[1],
    )?;
    let oid = oid.trim();
    Ok((!oid.is_empty()).then(|| oid.to_string()))
}

/// What to report when a stored entry cannot be proved to cover the working
/// tree. Deliberately does not claim the working tree is *untouched* — git's
/// cleanup already ran and may have removed some of the untracked files it
/// captured before it failed. What GitLane did not do is the tracked reset.
fn split_state_error(oid: &str, reason: &str, error: &str) -> String {
    let short: String = oid.chars().take(7).collect();
    format!(
        "Your changes were saved to stash {short}, but Git stopped before clearing the working tree and GitLane could not confirm the stash still matches it ({reason}) — the tracked edits were left in place rather than reset, so nothing is lost. Review stash {short}, then drop it or discard the working-tree copy. Git reported: {error}"
    )
}

/// Complete the working-tree restore git skipped. The caller has already proved
/// the entry covers the working tree. Returns the message to surface on success.
fn finish_interrupted_push(repo: &str, oid: &str, error: &str) -> Result<String, String> {
    // Match the reset `git stash push` performs itself, so a dirty submodule is
    // left alone exactly as a clean push would leave it.
    run_git(repo, &["reset", "--hard", "-q", "--no-recurse-submodules"]).map_err(|reset_error| {
        let short: String = oid.chars().take(7).collect();
        format!(
            "Your changes were saved to stash {short}, but the working tree could not be cleared: {reset_error}"
        )
    })?;
    Ok(format!(
        "Stashed your changes. Git could not remove every untracked path and stopped before clearing the working tree, so GitLane finished it. Git reported: {error}"
    ))
}

/// Prove that resetting the working tree cannot lose work. `None` means proved;
/// `Some(reason)` means it is not safe to reset, and says why.
///
/// `git stash create` snapshots the current tracked state into a dangling stash
/// commit **without touching the working tree**, so it yields exactly the trees
/// a reset is about to discard. When those match the stored entry's, every
/// tracked edit and staged change still on disk is already inside the stash:
///
/// * `<commit>^{tree}` — the working-tree state,
/// * `<commit>^2^{tree}` — the index state (a stash entry's second parent),
/// * `<commit>^1` — the base commit, so a HEAD that moved under us fails the
///   check instead of being reset away.
///
/// The untracked commit (`^3`) is deliberately not compared. `reset --hard`
/// leaves untracked files alone *except* where one obstructs a tracked path it
/// must restore, which it overwrites — verified on git 2.55 for both untracked
/// and ignored obstructions. That is not a hole this check should close: the
/// bar here is the state a **successful** `git stash push -u` would have left,
/// and a successful push runs this very same `reset --hard` against the very
/// same obstructions. Recovery reproduces git's own outcome, never a worse one.
///
/// A probe that cannot be taken is "not proved", never a hard error — the
/// caller still has the original push failure to report, and swallowing it for
/// a secondary diagnostic would cost the user the real diagnosis.
fn unproved_coverage(repo: &str, oid: &str) -> Option<String> {
    let probe = match run_git(repo, &["stash", "create"]) {
        Ok(probe) => probe.trim().to_string(),
        Err(error) => {
            return Some(format!(
                "the working tree could not be snapshotted: {error}"
            ))
        }
    };
    if probe.is_empty() {
        // Nothing left to stash: git got far enough that the working tree
        // already matches HEAD, so there is no restore left to finish.
        return None;
    }
    for suffix in ["^{tree}", "^2^{tree}", "^1"] {
        let (stored, current) = match (resolve(repo, oid, suffix), resolve(repo, &probe, suffix)) {
            (Ok(stored), Ok(current)) => (stored, current),
            (Err(error), _) | (_, Err(error)) => {
                return Some(format!("{suffix} could not be resolved: {error}"))
            }
        };
        if stored != current {
            return Some(format!("{suffix} no longer matches the stash"));
        }
    }
    None
}

fn resolve(repo: &str, commit: &str, suffix: &str) -> Result<String, String> {
    Ok(run_git(
        repo,
        &["rev-parse", "--verify", &format!("{commit}{suffix}")],
    )?
    .trim()
    .to_string())
}
