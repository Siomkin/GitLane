//! The force-push confirm and the route lease it captures.

use super::refs::{limited_lines, push_list, rev_parse_optional, short_oid};
use crate::git::types::ForcePushPreview;

use super::super::cli::run_git;
use super::super::operands::ensure_operand;
use super::super::remotes::{push_destination, push_endpoint_token};

pub fn preview_force_push(repo: &str, branch: &str) -> Result<ForcePushPreview, String> {
    ensure_operand(branch)?;
    // Fail closed if the local branch is gone (stale menu / concurrent delete),
    // and use the qualified ref for rev reads so a same-named tag can't be
    // resolved instead. Config reads still take the short branch name, since git
    // config is keyed by it. GL-42 review.
    let branch_ref = format!("refs/heads/{branch}");
    let expected_oid = run_git(
        repo,
        &["rev-parse", "--verify", &format!("{branch_ref}^{{commit}}")],
    )?
    .trim()
    .to_string();
    if expected_oid.is_empty() {
        return Err(format!(
            "Could not resolve local branch '{branch}' to a commit."
        ));
    }

    let (remote, destination_ref) = push_destination(repo, branch);
    ensure_operand(&remote)?;
    ensure_operand(&destination_ref)?;
    let push_endpoint_token = push_endpoint_token(repo, &remote)?;
    // Force-push is a branch operation. Reject a hostile/mistaken merge config
    // that points at another namespace even for Git's local `.` remote; without
    // this, refs/tags/* could be force-updated through the branch menu.
    let destination_branch = destination_ref
        .strip_prefix("refs/heads/")
        .ok_or_else(|| format!("Unsupported force-push destination {destination_ref}."))?;
    let destination_tracking_ref = if remote == "." {
        destination_ref.clone()
    } else {
        format!("refs/remotes/{remote}/{destination_branch}")
    };
    ensure_operand(&destination_tracking_ref)?;
    let destination_oid = rev_parse_optional(repo, &destination_tracking_ref)?;

    // Use the captured object ids for the impact ranges rather than mutable refs;
    // a concurrent fetch can move the remote-tracking ref while the preview is
    // being assembled, but it must not change either the dialog or its lease.
    let (remote_only, local_only) = match destination_oid.as_deref() {
        Some(destination_oid) => (
            limited_lines(
                run_git(
                    repo,
                    &[
                        "log",
                        "--oneline",
                        "--max-count=8",
                        &format!("{expected_oid}..{destination_oid}"),
                    ],
                )
                .unwrap_or_default(),
                8,
            ),
            limited_lines(
                run_git(
                    repo,
                    &[
                        "log",
                        "--oneline",
                        "--max-count=8",
                        &format!("{destination_oid}..{expected_oid}"),
                    ],
                )
                .unwrap_or_default(),
                8,
            ),
        ),
        None => (Vec::new(), Vec::new()),
    };
    let local_tip = short_oid(&expected_oid);
    let destination_tip = destination_oid
        .as_deref()
        .map(short_oid)
        .unwrap_or_else(|| "absent locally".to_string());
    let tracking_display = destination_tracking_ref
        .strip_prefix("refs/remotes/")
        .or_else(|| destination_tracking_ref.strip_prefix("refs/heads/"))
        .unwrap_or(destination_tracking_ref.as_str());
    let mut details = vec![
        format!(
            "Pushes local {branch} ({local_tip}) to {remote} at {destination_ref} using refspec {expected_oid}:{destination_ref}."
        ),
        format!("Push-destination tracking snapshot: {tracking_display} ({destination_tip})."),
    ];
    if !local_only.is_empty() {
        push_list(&mut details, "Local-only commits to publish", &local_only);
    }
    let mut warnings = vec![
        "--force-with-lease aborts if the remote destination no longer matches this preview."
            .to_string(),
    ];
    if remote_only.is_empty() {
        details.push("No remote-only commits are visible from the local tracking ref.".to_string());
    } else {
        push_list(
            &mut warnings,
            "Remote-only commits that may be replaced",
            &remote_only,
        );
    }
    Ok(ForcePushPreview {
        summary: format!("Force-push {branch} with lease"),
        details,
        warnings,
        expected_oid,
        remote,
        destination_ref,
        destination_oid,
        push_endpoint_token,
    })
}
