//! Reflog-backed recovery data and destructive-operation previews.

use std::collections::HashSet;

use crate::git::types::{DeleteBranchPreview, DestructivePreview, ForcePushPreview, ReflogEntry};

use super::cli::{run_git, run_git_allow_exit_codes, run_git_stdout_raw};
use super::operands::ensure_operand;
use super::remotes::{push_destination, push_endpoint_token};

/// Recent reflog entries for HEAD and local branches. Uses `git log -g` rather
/// than libgit2 because the CLI's reflog selectors (`HEAD@{1}`) are exactly what
/// users recognise when recovering from a bad reset/checkout.
pub fn reflog_entries(repo: &str, limit: usize) -> Result<Vec<ReflogEntry>, String> {
    run_git(repo, &["rev-parse", "--git-dir"])?;
    let head = run_git_allow_exit_codes(repo, &["rev-parse", "--verify", "--quiet", "HEAD"], &[1])?;
    let branch = run_git(
        repo,
        &[
            "for-each-ref",
            "--count=1",
            "--format=%(refname)",
            "refs/heads",
        ],
    )?;
    if head.trim().is_empty() && branch.trim().is_empty() {
        return Ok(Vec::new());
    }
    let max_count = format!("--max-count={}", limit.max(1));
    // Walk HEAD and local-branch reflogs explicitly instead of `--all`: the dialog
    // is "HEAD and branch movements", and scoping the walk means `--max-count` is
    // spent on recovery entries rather than being eaten by remote-tracking / tag /
    // stash reflogs that `--all` would include (which could starve the list in a
    // fetch-heavy repo). GL-42 review.
    let mut args = vec!["log", "-g"];
    if !head.trim().is_empty() {
        args.push("HEAD");
    }
    args.extend([
        "--branches",
        "--date=unix",
        &max_count,
        "--format=%H%x1f%gd%x1f%gD%x1f%gs%x1f%gn%x1f%ge%x1f%ct",
    ]);
    let raw = run_git(repo, &args)?;
    Ok(raw
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(7, '\u{1f}');
            let oid = parts.next()?.to_string();
            let short_selector = parts.next().unwrap_or("").to_string();
            let selector = parts.next().unwrap_or("").to_string();
            let subject = parts.next().unwrap_or("").to_string();
            let committer_name = parts.next().unwrap_or("").to_string();
            let committer_email = parts.next().unwrap_or("").to_string();
            let commit_timestamp = parts
                .next()
                .and_then(|value| value.parse().ok())
                .unwrap_or(0);
            let selector_for_ref = if selector.is_empty() {
                &short_selector
            } else {
                &selector
            };
            let timestamp = reflog_selector_timestamp(selector_for_ref).unwrap_or(commit_timestamp);
            let ref_name = selector_for_ref
                .split("@{")
                .next()
                .unwrap_or("")
                .trim_start_matches("refs/heads/")
                .to_string();
            Some(ReflogEntry {
                short_oid: short_oid(&oid),
                oid,
                selector,
                short_selector,
                ref_name,
                subject,
                committer_name,
                committer_email,
                timestamp,
            })
        })
        .collect())
}

/// Preview a reset of `source` (the ref that will be reset — `HEAD` for the
/// current branch, or a named branch when the caller checks it out first) back
/// to `target`. The impacted commits are those on `source` but not `target`, so
/// the range must be anchored on `source`, not always `HEAD`. GL-42 review.
pub fn preview_reset(
    repo: &str,
    target: &str,
    mode: &str,
    source: &str,
) -> Result<DestructivePreview, String> {
    ensure_operand(target)?;
    ensure_operand(source)?;
    let mode = match mode {
        "soft" | "mixed" | "hard" => mode,
        _ => "mixed",
    };
    // Qualify a branch/tag-ambiguous target to refs/heads/ exactly as the write
    // path (`reset::reset`) does, so the preview describes the *same* ref the
    // reset will actually move to — otherwise a same-named tag could be shown in
    // the confirm dialog while the reset lands on the branch (GL-120 review).
    let target = super::branches::qualify_branch_if_ambiguous(repo, target);
    let target = target.as_str();
    // Validate both ends up front. The impact reads below tolerate git failures
    // with `unwrap_or_default()`, so an unresolvable target or source would
    // otherwise yield a confident-looking but empty preview ("No commits are
    // currently ahead of the target"). Fail loudly instead, routing the UI to its
    // error path. GL-42 review.
    run_git(
        repo,
        &["rev-parse", "--verify", &format!("{target}^{{commit}}")],
    )?;
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
    let target_short = rev_parse_short(repo, target).unwrap_or_else(|| target.to_string());
    let range = format!("{target}..{source_ref}");
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
        details.push(format!(
            "Commits no longer on the branch tip: {}",
            commits.join("; ")
        ));
    }
    if !files.is_empty() {
        details.push(format!(
            "Files changed by those commits: {}",
            files.join("; ")
        ));
    }
    let mut warnings = Vec::new();
    match mode {
        "soft" => details.push("Soft reset keeps those commit changes staged.".to_string()),
        "mixed" => details.push(
            "Mixed reset keeps those commit changes in the working tree, unstaged.".to_string(),
        ),
        "hard" => {
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
                warnings.push(format!(
                    "Uncommitted tracked changes that will be lost: {}",
                    tracked.join("; ")
                ));
            }
            let obstructions = hard_reset_untracked_obstructions(repo, target)?;
            if !obstructions.is_empty() {
                warnings.push(format!(
                    "Untracked files or directories in the target's way that may be deleted: {}",
                    obstructions.join("; ")
                ));
            }
        }
        _ => {}
    }
    warnings.push(
        "The previous HEAD remains recoverable from the reflog while Git keeps it locally."
            .to_string(),
    );
    Ok(DestructivePreview {
        summary: format!("Reset {mode} to {target_short}"),
        details,
        warnings,
    })
}

pub fn preview_delete_branch(repo: &str, branch: &str) -> Result<DeleteBranchPreview, String> {
    ensure_operand(branch)?;
    // Fail closed on a missing branch (consistent with preview_reset): otherwise
    // the impact reads soft-fail to "unknown"/empty and the dialog looks fine for
    // a branch that doesn't exist. GL-42 review.
    // Use the fully-qualified ref for impact reads: a bare name resolves a same-
    // named tag before the branch (git ref precedence), so it could compute the
    // wrong impact while `git branch -D` deletes the branch. GL-42 review.
    let branch_ref = super::branches::checked_branch_ref(repo, branch)?;
    // The lease currently models a direct local ref plus its exact object id.
    // Reject symbolic local refs rather than previewing one representation and
    // later deleting a same-target replacement with different semantics.
    super::branches::ensure_branch_ref_is_direct(repo, branch)?;
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
        details.push(format!(
            "Commits ahead of current HEAD: {}",
            unmerged.join("; ")
        ));
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
        details.push(format!(
            "Local-only commits to publish: {}",
            local_only.join("; ")
        ));
    }
    let mut warnings = vec![
        "--force-with-lease aborts if the remote destination no longer matches this preview."
            .to_string(),
    ];
    if remote_only.is_empty() {
        details.push("No remote-only commits are visible from the local tracking ref.".to_string());
    } else {
        warnings.push(format!(
            "Remote-only commits that may be replaced: {}",
            remote_only.join("; ")
        ));
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

fn rev_parse_optional(repo: &str, revision: &str) -> Result<Option<String>, String> {
    ensure_operand(revision)?;
    let oid =
        run_git_allow_exit_codes(repo, &["rev-parse", "--verify", "--quiet", revision], &[1])?
            .trim()
            .to_string();
    Ok((!oid.is_empty()).then_some(oid))
}

fn short_oid(oid: &str) -> String {
    oid.chars().take(7).collect()
}

fn rev_parse_short(repo: &str, rev: &str) -> Option<String> {
    ensure_operand(rev).ok()?;
    run_git(repo, &["rev-parse", "--short", rev])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn limited_lines(raw: String, limit: usize) -> Vec<String> {
    let mut lines: Vec<String> = raw
        .lines()
        .filter(|line| !line.trim().is_empty())
        .take(limit + 1)
        .map(|line| line.trim().to_string())
        .collect();
    if lines.len() > limit {
        lines.truncate(limit);
        lines.push("…".to_string());
    }
    lines
}

fn path_conflicts_with_reset_target(untracked: &str, target_path: &str) -> bool {
    untracked == target_path
        || untracked
            .strip_prefix(target_path)
            .is_some_and(|rest| rest.starts_with('/'))
        || target_path
            .strip_prefix(untracked)
            .is_some_and(|rest| rest.starts_with('/'))
}

fn hard_reset_untracked_obstructions(repo: &str, target: &str) -> Result<Vec<String>, String> {
    let target_tree = format!("{target}^{{tree}}");
    let parse_paths = |raw: Vec<u8>| {
        raw.split(|byte| *byte == 0)
            .filter(|path| !path.is_empty())
            .map(|path| String::from_utf8_lossy(path).into_owned())
            .collect::<Vec<_>>()
    };
    let target_paths = parse_paths(run_git_stdout_raw(
        repo,
        &["ls-tree", "-r", "-z", "--name-only", &target_tree],
    )?);
    // Deliberately omit `--exclude-standard`: ignored files are still untracked,
    // and reset --hard overwrites them when the target tree tracks that path.
    let untracked_paths = parse_paths(run_git_stdout_raw(repo, &["ls-files", "--others", "-z"])?);

    let mut seen = HashSet::new();
    let mut obstructions = Vec::new();
    for untracked in untracked_paths {
        if target_paths
            .iter()
            .any(|target_path| path_conflicts_with_reset_target(&untracked, target_path))
            && seen.insert(untracked.clone())
        {
            obstructions.push(format!("?? {untracked}"));
        }
    }
    Ok(obstructions.into_iter().take(16).collect())
}

fn reflog_selector_timestamp(selector: &str) -> Option<i64> {
    let start = selector.rfind("@{")? + 2;
    let end = selector[start..].find('}')? + start;
    selector[start..end].parse().ok()
}
