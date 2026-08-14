//! Branch-deletion confirms, local and remote.

use super::refs::{limited_lines, push_list, rev_parse_short};
use crate::git::types::{DeleteBranchPreview, DestructivePreview};

use super::super::cli::run_git;
use super::super::operands::ensure_operand;

pub fn preview_delete_branch(repo: &str, branch: &str) -> Result<DeleteBranchPreview, String> {
    ensure_operand(branch)?;
    // Fail closed on a missing branch (consistent with preview_reset): otherwise
    // the impact reads soft-fail to "unknown"/empty and the dialog looks fine for
    // a branch that doesn't exist. GL-42 review.
    // Use the fully-qualified ref for impact reads: a bare name resolves a same-
    // named tag before the branch (git ref precedence), so it could compute the
    // wrong impact while `git branch -D` deletes the branch. GL-42 review.
    let branch_ref = super::super::branches::checked_branch_ref(repo, branch)?;
    // The lease currently models a direct local ref plus its exact object id.
    // Reject symbolic local refs rather than previewing one representation and
    // later deleting a same-target replacement with different semantics.
    super::super::branches::ensure_branch_ref_is_direct(repo, branch)?;
    // Keep the impact preview commit-specific. The raw ref oid below is the CAS
    // lease, while this peeled check rejects a malformed/non-commit heads ref.
    run_git(
        repo,
        &["rev-parse", "--verify", &format!("{branch_ref}^{{commit}}")],
    )?;
    let expected_oid = run_git(repo, &["rev-parse", "--verify", &branch_ref])?
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    if expected_oid.is_empty() {
        return Err(format!("Could not resolve {branch_ref}"));
    }
    // Every impact read is pinned to the captured object, not the live ref. A
    // concurrent A -> B -> A move must not let the dialog show B's commits while
    // carrying an A lease that can later succeed.
    let tip = rev_parse_short(repo, &expected_oid).unwrap_or_else(|| "unknown".to_string());
    let unmerged = limited_lines(
        run_git(
            repo,
            &[
                "log",
                "--oneline",
                "--max-count=8",
                &format!("HEAD..{expected_oid}"),
            ],
        )
        .unwrap_or_default(),
        8,
    );
    let mut details = vec![format!("Local branch {branch} points at {tip}.")];
    if unmerged.is_empty() {
        details.push("No commits are shown ahead of the current HEAD.".to_string());
    } else {
        push_list(&mut details, "Commits ahead of current HEAD", &unmerged);
    }
    Ok(DeleteBranchPreview {
        summary: format!("Delete local branch {branch}"),
        details,
        warnings: vec![
            "The branch ref is removed; commits survive only while another ref or the reflog keeps them reachable.".to_string(),
        ],
        expected_oid,
    })
}

pub fn preview_delete_remote_branch(
    repo: &str,
    remote: &str,
    branch: &str,
) -> Result<DestructivePreview, String> {
    ensure_operand(remote)?;
    ensure_operand(branch)?;
    let remote_short = format!("{remote}/{branch}");
    // Qualify to refs/remotes for the lookup so a same-named tag/branch can't be
    // resolved instead; keep the short form for display. GL-42 review.
    let remote_ref = format!("refs/remotes/{remote_short}");
    let tip = rev_parse_short(repo, &remote_ref).unwrap_or_else(|| "unknown locally".to_string());
    Ok(DestructivePreview {
        summary: format!("Delete {branch} on {remote}"),
        details: vec![
            format!("Remote-tracking ref {remote_short} currently points at {tip}."),
            "The server-side branch is deleted for everyone using that remote.".to_string(),
        ],
        warnings: vec!["GitLane cannot recover a deleted server-side branch unless its commit is still available locally or on another remote ref.".to_string()],
    })
}
