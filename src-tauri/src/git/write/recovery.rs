//! Reflog-backed recovery data and destructive-operation previews.

use std::collections::HashSet;

use crate::git::types::{DestructivePreview, ReflogEntry};

use super::cli::run_git;
use super::operands::ensure_operand;
use super::remotes::push_target;

/// Recent reflog entries for HEAD and local branches. Uses `git log -g` rather
/// than libgit2 because the CLI's reflog selectors (`HEAD@{1}`) are exactly what
/// users recognise when recovering from a bad reset/checkout.
pub fn reflog_entries(repo: &str, limit: usize) -> Result<Vec<ReflogEntry>, String> {
    // An unborn HEAD makes `git log -g HEAD …` fatal, so short-circuit to an
    // empty list — a repo with no commits has no recovery points to show.
    if run_git(repo, &["rev-parse", "--verify", "--quiet", "HEAD"]).is_err() {
        return Ok(Vec::new());
    }
    let max_count = format!("--max-count={}", limit.max(1));
    // Walk HEAD and local-branch reflogs explicitly instead of `--all`: the dialog
    // is "HEAD and branch movements", and scoping the walk means `--max-count` is
    // spent on recovery entries rather than being eaten by remote-tracking / tag /
    // stash reflogs that `--all` would include (which could starve the list in a
    // fetch-heavy repo). GL-42 review.
    let raw = run_git(
        repo,
        &[
            "log",
            "-g",
            "HEAD",
            "--branches",
            "--date=unix",
            &max_count,
            "--format=%H%x1f%gd%x1f%gD%x1f%gs%x1f%gn%x1f%ge%x1f%ct",
        ],
    )?;
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

pub fn preview_discard_all(repo: &str) -> Result<DestructivePreview, String> {
    // Fail closed: read status directly (not the lossy `status_lines`) so a stale
    // or inaccessible repo errors out instead of rendering a misleading "working
    // tree is already clean" before a discard. GL-42 review.
    let status = limited_lines(run_git(repo, &["status", "--porcelain=v1"])?, 16);
    let mut details = Vec::new();
    if status.is_empty() {
        details.push("The working tree is already clean.".to_string());
    } else {
        details.push(format!(
            "Files that will be reset or removed: {}",
            status.join("; ")
        ));
    }
    Ok(DestructivePreview {
        summary: "Discard every staged, unstaged, and untracked working-tree change".to_string(),
        details,
        warnings: vec![
            "Tracked edits may be recoverable only if they were previously committed or stashed."
                .to_string(),
            "Untracked files removed by git clean are not recoverable from the reflog.".to_string(),
        ],
    })
}

pub fn preview_delete_branch(repo: &str, branch: &str) -> Result<DestructivePreview, String> {
    ensure_operand(branch)?;
    // Fail closed on a missing branch (consistent with preview_reset): otherwise
    // the impact reads soft-fail to "unknown"/empty and the dialog looks fine for
    // a branch that doesn't exist. GL-42 review.
    // Use the fully-qualified ref for impact reads: a bare name resolves a same-
    // named tag before the branch (git ref precedence), so it could compute the
    // wrong impact while `git branch -D` deletes the branch. GL-42 review.
    let branch_ref = format!("refs/heads/{branch}");
    run_git(
        repo,
        &["rev-parse", "--verify", &format!("{branch_ref}^{{commit}}")],
    )?;
    let tip = rev_parse_short(repo, &branch_ref).unwrap_or_else(|| "unknown".to_string());
    let unmerged = limited_lines(
        run_git(
            repo,
            &[
                "log",
                "--oneline",
                "--max-count=8",
                &format!("HEAD..{branch_ref}"),
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
    Ok(DestructivePreview {
        summary: format!("Delete local branch {branch}"),
        details,
        warnings: vec![
            "The branch ref is removed; commits survive only while another ref or the reflog keeps them reachable.".to_string(),
        ],
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

pub fn preview_force_push(repo: &str, branch: &str) -> Result<DestructivePreview, String> {
    ensure_operand(branch)?;
    // Fail closed if the local branch is gone (stale menu / concurrent delete),
    // and use the qualified ref for rev reads so a same-named tag can't be
    // resolved instead. Config reads (push_target/branch_upstream) still take the
    // short branch name, since git config is keyed by it. GL-42 review.
    let branch_ref = format!("refs/heads/{branch}");
    run_git(
        repo,
        &["rev-parse", "--verify", &format!("{branch_ref}^{{commit}}")],
    )?;
    let (remote, refspec) = push_target(repo, branch);
    let upstream = branch_upstream(repo, branch).unwrap_or_else(|| {
        pushed_branch_name(&refspec)
            .map(|name| format!("refs/remotes/{remote}/{name}"))
            .unwrap_or_else(|| format!("refs/remotes/{remote}/{branch}"))
    });
    // `upstream` is derived from git config (remote name / `%(upstream)`), not from
    // a guarded UI operand, yet it flows unquoted into the `git log` rev-ranges
    // below. A config value beginning with `-` would be parsed as an option, so
    // apply the same dash-guard used for user operands. GL-42.
    ensure_operand(&upstream)?;
    // Short form for display only; reads/ranges use the fully-qualified ref so a
    // same-named local branch/tag can't shadow the remote-tracking ref. GL-42.
    let upstream_display = upstream
        .strip_prefix("refs/remotes/")
        .or_else(|| upstream.strip_prefix("refs/heads/"))
        .unwrap_or(upstream.as_str())
        .to_string();
    let local_tip = rev_parse_short(repo, &branch_ref).unwrap_or_else(|| "unknown".to_string());
    let remote_tip =
        rev_parse_short(repo, &upstream).unwrap_or_else(|| "unknown locally".to_string());
    let remote_only = limited_lines(
        run_git(
            repo,
            &[
                "log",
                "--oneline",
                "--max-count=8",
                &format!("{branch_ref}..{upstream}"),
            ],
        )
        .unwrap_or_default(),
        8,
    );
    let local_only = limited_lines(
        run_git(
            repo,
            &[
                "log",
                "--oneline",
                "--max-count=8",
                &format!("{upstream}..{branch_ref}"),
            ],
        )
        .unwrap_or_default(),
        8,
    );
    let mut details = vec![
        format!("Pushes local {branch} ({local_tip}) to {remote} using refspec {refspec}."),
        format!("Local tracking comparison target: {upstream_display} ({remote_tip})."),
    ];
    if !local_only.is_empty() {
        details.push(format!(
            "Local-only commits to publish: {}",
            local_only.join("; ")
        ));
    }
    let mut warnings = vec![
        "--force-with-lease aborts if the remote moved since the local tracking ref was updated."
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
    Ok(DestructivePreview {
        summary: format!("Force-push {branch} with lease"),
        details,
        warnings,
    })
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
    let target_paths: Vec<String> = run_git(repo, &["ls-tree", "-r", "--name-only", &target_tree])?
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(str::to_string)
        .collect();
    let untracked_paths: Vec<String> =
        run_git(repo, &["ls-files", "--others", "--exclude-standard"])?
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(str::to_string)
            .collect();

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

/// The fully-qualified upstream ref (e.g. `refs/remotes/origin/main`) of a local
/// branch, or `None` if it has no upstream. The full form (not `%(upstream:short)`)
/// is used so impact reads can't be shadowed by a same-named local branch/tag.
fn branch_upstream(repo: &str, branch: &str) -> Option<String> {
    run_git(
        repo,
        &[
            "for-each-ref",
            "--format=%(upstream)",
            &format!("refs/heads/{branch}"),
        ],
    )
    .ok()
    .map(|s| s.trim().to_string())
    .filter(|s| !s.is_empty())
}

fn pushed_branch_name(refspec: &str) -> Option<&str> {
    // The destination side of a `src:dst` refspec, or the whole spec when there's
    // no colon; with any `refs/heads/` prefix stripped.
    let dst = refspec.split(':').nth(1).unwrap_or(refspec);
    Some(dst.strip_prefix("refs/heads/").unwrap_or(dst))
}
