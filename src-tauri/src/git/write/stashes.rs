//! Stash listing and stash mutations.

use std::collections::HashMap;

use crate::git::types::{StashContextCommit, StashEntry};

use super::cli::run_git;
use super::operands::ensure_operand;
use super::worktrees::drop_stash_by_oid;

const STASH_CONTEXT_LIMIT: usize = 8;

/// List stashes via `git stash list`. Each line is
/// `<oid>\x1f<parents>\x1f<committer-time>\x1f<subject>`; the line index is the
/// stash index (0 = most recent). A stash commit's first parent is the base commit.
pub fn stash_list(repo: &str) -> Result<Vec<StashEntry>, String> {
    let raw = run_git(repo, &["stash", "list", "--format=%H%x1f%P%x1f%ct%x1f%s"])?;
    let mut parsed = Vec::new();
    let mut base_oids = Vec::new();
    for (index, line) in raw.lines().enumerate() {
        if line.is_empty() {
            continue;
        }
        let mut parts = line.splitn(4, '\u{1f}');
        let oid = parts.next().unwrap_or("").to_string();
        let parents = parts.next().unwrap_or("");
        let base_oid = parents.split_whitespace().next().map(str::to_string);
        // Keep this `None` on a malformed `%ct` so the mapping below can fall
        // back to the base commit's time rather than 0 (which would sort a real
        // stash below every commit and risk pushing it to the fallback row).
        let timestamp = parts.next().and_then(|value| value.parse::<i64>().ok());
        let message = parts.next().unwrap_or("").to_string();
        if let Some(base) = &base_oid {
            base_oids.push(base.clone());
        }
        parsed.push((index, message, oid, timestamp, base_oid));
    }

    let base_timestamps = stash_base_timestamps(repo, &base_oids);
    let mut context_by_base: HashMap<String, Vec<StashContextCommit>> = HashMap::new();
    for base in &base_oids {
        context_by_base
            .entry(base.clone())
            .or_insert_with(|| stash_context_commits(repo, base));
    }
    Ok(parsed
        .into_iter()
        .map(|(index, message, oid, timestamp, base_oid)| {
            let base_timestamp = base_oid
                .as_ref()
                .and_then(|base| base_timestamps.get(base).copied());
            let context = base_oid
                .as_ref()
                .and_then(|base| context_by_base.get(base))
                .cloned()
                .unwrap_or_default();
            StashEntry {
                index,
                message,
                oid,
                // A stash commit is always created on top of its base, so the
                // base time is the safest stand-in if `%ct` somehow didn't parse.
                timestamp: timestamp.or(base_timestamp).unwrap_or(0),
                base_oid,
                base_timestamp,
                context,
            }
        })
        .collect())
}

fn stash_base_timestamps(repo: &str, base_oids: &[String]) -> HashMap<String, i64> {
    if base_oids.is_empty() {
        return HashMap::new();
    }
    let mut args = vec![
        "show".to_string(),
        "-s".to_string(),
        "--format=%H%x1f%ct".to_string(),
    ];
    args.extend(base_oids.iter().cloned());
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let Ok(raw) = run_git(repo, &arg_refs) else {
        return HashMap::new();
    };

    raw.lines()
        .filter_map(|line| {
            let (oid, timestamp) = line.split_once('\u{1f}')?;
            Some((oid.to_string(), timestamp.parse().ok()?))
        })
        .collect()
}

fn stash_context_commits(repo: &str, base_oid: &str) -> Vec<StashContextCommit> {
    let limit = STASH_CONTEXT_LIMIT.to_string();
    let raw = run_git(
        repo,
        &[
            "log",
            "--first-parent",
            &format!("--max-count={limit}"),
            "--format=%H%x1f%P%x1f%ct%x1f%an%x1f%ae%x1f%s",
            base_oid,
        ],
    );
    let Ok(raw) = raw else {
        return Vec::new();
    };

    raw.lines()
        .filter_map(|line| {
            let mut parts = line.splitn(6, '\u{1f}');
            let id = parts.next()?.to_string();
            let parents = parts
                .next()
                .unwrap_or("")
                .split_whitespace()
                .map(str::to_string)
                .collect();
            let timestamp = parts.next().and_then(|value| value.parse().ok())?;
            let author_name = parts.next().unwrap_or("").to_string();
            let author_email = parts.next().unwrap_or("").to_string();
            let summary = parts.next().unwrap_or("").to_string();
            Some(StashContextCommit {
                short_id: id.chars().take(7).collect(),
                id,
                summary,
                author_name,
                author_email,
                timestamp,
                parents,
            })
        })
        .collect()
}

/// Resolve a stash commit oid to its *current* `stash@{n}` reflog reference.
/// Stash indices are reflog-relative and global across worktrees, so an index
/// captured with an earlier `stash_list` snapshot goes stale the moment any
/// stash is created or dropped elsewhere (sibling worktree, terminal). `drop`
/// and `branch` only accept reflog references, so re-resolve the oid immediately
/// before each mutation instead of trusting a stored index.
fn stash_ref_for_oid(repo: &str, oid: &str) -> Result<String, String> {
    ensure_operand(oid)?;
    let list = run_git(repo, &["stash", "list", "--format=%H"])?;
    list.lines()
        .position(|line| line.trim() == oid)
        .map(|index| format!("stash@{{{index}}}"))
        .ok_or_else(|| {
            let short: String = oid.chars().take(7).collect();
            format!("Stash {short} no longer exists — it may have been applied or dropped elsewhere.")
        })
}

/// Apply the stash with commit oid `oid` without dropping it. `git stash apply`
/// accepts any stash-shaped commit, so the oid goes straight through.
pub fn stash_apply(repo: &str, oid: &str) -> Result<String, String> {
    ensure_operand(oid)?;
    run_git(repo, &["stash", "apply", oid])
}

/// Apply the stash with commit oid `oid` restoring the staged (index) state too
/// (`--index`). Without `--index` everything lands in the working tree unstaged.
pub fn stash_apply_index(repo: &str, oid: &str) -> Result<String, String> {
    ensure_operand(oid)?;
    run_git(repo, &["stash", "apply", "--index", oid])
}

/// Check out `branch` at the stash's original parent commit and apply the stash
/// there (`git stash branch <branch> <stash>`). Useful when the stash no longer
/// applies cleanly on the current branch because history has diverged. Creates
/// the branch if it doesn't exist. Addressed via `stash@{n}` (resolved from the
/// oid at the last moment) — with a bare oid git would apply but silently skip
/// the drop.
pub fn stash_branch(repo: &str, branch: &str, oid: &str) -> Result<String, String> {
    ensure_operand(branch)?;
    let stash_ref = stash_ref_for_oid(repo, oid)?;
    run_git(repo, &["stash", "branch", branch, &stash_ref])
}

/// Apply and drop the stash with commit oid `oid`. Implemented as apply-then-drop
/// (rather than `git stash pop stash@{n}`) so the destructive drop re-resolves the
/// oid at the very last moment — this closes the narrow window where a stash pushed
/// concurrently between resolving `stash@{n}` and running `pop` would shift indices
/// under us. A conflicting apply errors out *before* the drop, so the stash is kept
/// exactly as `git stash pop` would. Mirrors `restore_stash` in worktrees.rs.
pub fn stash_pop(repo: &str, oid: &str) -> Result<String, String> {
    let applied = stash_apply(repo, oid)?;
    drop_stash_by_oid(repo, oid)?;
    Ok(applied)
}

/// Drop the stash with commit oid `oid`.
pub fn stash_drop(repo: &str, oid: &str) -> Result<String, String> {
    let stash_ref = stash_ref_for_oid(repo, oid)?;
    run_git(repo, &["stash", "drop", &stash_ref])
}

/// Stash the working tree and index.
pub fn stash(repo: &str) -> Result<String, String> {
    run_git(repo, &["stash", "push"])
}
