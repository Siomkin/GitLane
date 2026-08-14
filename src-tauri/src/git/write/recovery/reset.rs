//! The reset confirm: the commits it would leave behind, and the untracked
//! work a hard reset would destroy.

use super::refs::{limited_lines, push_list, rev_parse_short};
use crate::git::types::ResetPreview;

use super::super::cli::run_git;
use super::super::hard_reset_lease;
use super::super::operands::ensure_operand;

/// Preview a reset of `source` (the ref that will be reset — `HEAD` for the
/// current branch, or a named branch when the caller checks it out first) back
/// to `target`. The impacted commits are those on `source` but not `target`, so
/// the range must be anchored on `source`, not always `HEAD`. GL-42 review.
pub fn preview_reset(
    repo: &str,
    target: &str,
    mode: &str,
    source: &str,
) -> Result<ResetPreview, String> {
    ensure_operand(target)?;
    ensure_operand(source)?;
    let mode = match mode {
        "soft" | "mixed" | "hard" => mode,
        _ => "mixed",
    };
    // Qualify a branch/tag-ambiguous target to refs/heads/ here, the one place
    // that still takes a *name*: the write executes the oid this resolves to
    // (`reset::reset_to_oid`), so the preview describes the ref the reset will
    // actually move to — otherwise a same-named tag could be shown in the
    // confirm dialog while the reset lands on the branch (GL-120 review).
    let target = super::super::branches::qualify_branch_if_ambiguous(repo, target);
    let target = target.as_str();
    // Validate both ends up front. The impact reads below tolerate git failures
    // with `unwrap_or_default()`, so an unresolvable target or source would
    // otherwise yield a confident-looking but empty preview ("No commits are
    // currently ahead of the target"). Fail loudly instead, routing the UI to its
    // error path. GL-42 review.
    let target_oid = run_git(
        repo,
        &["rev-parse", "--verify", &format!("{target}^{{commit}}")],
    )?
    .lines()
    .next()
    .unwrap_or("")
    .trim()
    .to_string();
    if target_oid.is_empty() {
        return Err(format!("Could not resolve {target} to a commit."));
    }
    // Qualify a local-branch source to refs/heads so a same-named tag can't shadow
    // it (git ref precedence resolves a bare name to the tag first); HEAD and
    // arbitrary commit-ish sources are validated and used as-is. GL-42 review.
    let source_ref = if source == "HEAD" {
        source.to_string()
    } else if run_git(
        repo,
        &[
            "rev-parse",
            "--verify",
            &format!("refs/heads/{source}^{{commit}}"),
        ],
    )
    .is_ok()
    {
        format!("refs/heads/{source}")
    } else {
        run_git(
            repo,
            &["rev-parse", "--verify", &format!("{source}^{{commit}}")],
        )?;
        source.to_string()
    };
    let expected_source_oid = run_git(
        repo,
        &["rev-parse", "--verify", &format!("{source_ref}^{{commit}}")],
    )?
    .lines()
    .next()
    .unwrap_or("")
    .trim()
    .to_string();
    if expected_source_oid.is_empty() {
        return Err(format!("Could not resolve {source_ref} to a commit."));
    }
    let target_short = rev_parse_short(repo, &target_oid).unwrap_or_else(|| target.to_string());
    let range = format!("{target_oid}..{source_ref}");
    let commits = limited_lines(
        run_git(repo, &["log", "--oneline", "--max-count=8", &range]).unwrap_or_default(),
        8,
    );
    let files = limited_lines(
        run_git(repo, &["diff", "--name-status", &range]).unwrap_or_default(),
        12,
    );
    let mut details = Vec::new();
    // Name the ref that actually moves: HEAD for a current-branch reset, or the
    // specific branch when a non-current branch is being reset. GL-42 review.
    let mover = if source == "HEAD" {
        "Current branch/HEAD".to_string()
    } else {
        source.to_string()
    };
    details.push(format!("{mover} will move to {target_short}."));
    if commits.is_empty() {
        details.push("No commits are currently ahead of the target.".to_string());
    } else {
        push_list(
            &mut details,
            "Commits no longer on the branch tip",
            &commits,
        );
    }
    if !files.is_empty() {
        push_list(&mut details, "Files changed by those commits", &files);
    }
    let mut warnings = Vec::new();
    let mut expected_state = None;
    let mut expected_head_branch = None;
    let mut expected_head_oid = None;
    match mode {
        "soft" => details.push("Soft reset keeps those commit changes staged.".to_string()),
        "mixed" => details.push(
            "Mixed reset keeps those commit changes in the working tree, unstaged.".to_string(),
        ),
        "hard" => {
            // Lease fingerprints the current worktree — refuse a named source
            // that is not checked out so the confirm cannot describe one branch
            // while binding another.
            hard_reset_lease::ensure_source_is_checked_out(repo, source)?;
            warnings.push("Hard reset also discards uncommitted tracked-file changes.".to_string());
            // Fail closed on a status read error (mirrors preview_discard_all):
            // silently dropping it could hide a dirty tree before a hard reset.
            // Ordinary untracked files stay put, but untracked files/directories
            // that obstruct tracked files in the target tree can be deleted by
            // `git reset --hard`, so report that narrower set separately.
            let tracked: Vec<String> =
                limited_lines(run_git(repo, &["status", "--porcelain=v1"])?, 16)
                    .into_iter()
                    .filter(|line| !line.starts_with("??"))
                    .collect();
            if !tracked.is_empty() {
                push_list(
                    &mut warnings,
                    "Uncommitted tracked changes that will be lost",
                    &tracked,
                );
            }
            let obstructions = hard_reset_lease::preview_untracked_obstructions(repo, &target_oid)?;
            if !obstructions.is_empty() {
                push_list(
                    &mut warnings,
                    "Untracked files or directories in the target's way that may be deleted",
                    &obstructions,
                );
            }
            // Exact-state lease for confirm→execute (GL-302). Bound to the
            // resolved target oid so a moved symbolic name cannot widen the write.
            let (state, head_branch, head_oid) = hard_reset_lease::capture(repo, &target_oid)?;
            expected_state = Some(state);
            expected_head_branch = head_branch;
            expected_head_oid = head_oid;
        }
        _ => {}
    }
    warnings.push(
        "The previous HEAD remains recoverable from the reflog while Git keeps it locally."
            .to_string(),
    );
    Ok(ResetPreview {
        summary: format!("Reset {mode} to {target_short}"),
        details,
        warnings,
        target_oid,
        expected_source_oid: Some(expected_source_oid),
        expected_state,
        expected_head_branch,
        expected_head_oid,
    })
}
