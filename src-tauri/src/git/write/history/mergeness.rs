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

/// Partition `commits` into runs of consecutive commits that agree on
/// merge-ness, preserving order. `git cherry-pick`/`git revert` accept `-m 1`
/// only when *every* named commit is a merge, so a mixed selection has to be
/// split into per-kind invocations.
pub(super) fn group_by_mergeness<'a>(
    repo: &str,
    commits: &'a [String],
) -> Result<Vec<(bool, Vec<&'a str>)>, String> {
    let mut runs: Vec<(bool, Vec<&str>)> = Vec::new();
    for c in commits {
        let merge = is_merge_commit(repo, c)?;
        match runs.last_mut() {
            Some((kind, run)) if *kind == merge => run.push(c.as_str()),
            _ => runs.push((merge, vec![c.as_str()])),
        }
    }
    Ok(runs)
}
