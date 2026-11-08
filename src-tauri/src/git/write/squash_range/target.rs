//! Preconditions for rewriting a branch without checking it out.

pub(super) fn ensure_target(repo: &str, branch: &str, expected: &str) -> Result<(), String> {
    let repository = git2::Repository::discover(repo).map_err(|e| e.to_string())?;
    let reference = repository
        .find_reference(&format!("refs/heads/{branch}"))
        .map_err(|_| "Target branch changed or was deleted. Refresh and try again.".to_string())?;
    let oid = git2::Oid::from_str(expected).map_err(|e| e.to_string())?;
    // Symbolic refs have no direct target, even if they resolve to this oid.
    if reference.target() != Some(oid) {
        return Err("Target branch changed. Refresh and try again.".to_string());
    }
    super::super::worktrees::ensure_branch_unclaimed(repo, branch, "squash")
}
