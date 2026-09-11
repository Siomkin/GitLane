//! Detecting merge commits, and grouping a selection into same-kind runs —
//! `git cherry-pick`/`git revert` accept `-m 1` only when every named commit is
//! a merge.

use super::super::cli::run_git;

/// Whether `commit` is a merge commit (more than one parent). Git refuses to
/// cherry-pick or revert a merge without `-m <parent>`, so those callers probe
/// this first and pass `-m 1`. Uses `git rev-list --parents -n 1`, whose first
/// output line is `<sha> <parent>…` — it fails loudly on an unresolvable
/// commit instead of silently reading "not a merge".
pub(in crate::git::write) fn is_merge_commit(repo: &str, commit: &str) -> Result<bool, String> {
    let out = run_git(repo, &["rev-list", "--parents", "-n", "1", commit])?;
    // run_git returns stdout followed by stderr; the commit line is first, any
    // stderr warnings (e.g. an ambiguous refname) land on later lines.
    let parents = out
        .lines()
        .next()
        .unwrap_or("")
        .split_whitespace()
        .count()
        .saturating_sub(1);
    Ok(parents > 1)
}

/// Whether every commit in `commits` is a merge, refusing a mixed selection.
///
/// `git cherry-pick`/`git revert` accept `-m 1` only when *every* named commit
/// is a merge, so a mixed selection cannot be one invocation. Splitting it into
/// per-kind runs — what this used to do — is worse than refusing: a conflict in
/// one run returns before the later runs are queued, and once the user resolves
/// it `--continue` finishes only the run git knows about. The remaining commits
/// are then never applied and never reported, so the operation looks complete.
/// Tracking a remainder across an interactive resolution means persisting
/// sequencer state across restarts; refusing up front costs one check.
pub(super) fn uniform_mergeness(repo: &str, commits: &[String]) -> Result<bool, String> {
    let mut kinds = Vec::with_capacity(commits.len());
    for c in commits {
        kinds.push(is_merge_commit(repo, c)?);
    }
    let merge = kinds.first().copied().unwrap_or(false);
    if kinds.iter().any(|kind| *kind != merge) {
        return Err(
            "Merge commits have to be applied on their own. Select only merges, or only ordinary commits."
                .to_string(),
        );
    }
    Ok(merge)
}
