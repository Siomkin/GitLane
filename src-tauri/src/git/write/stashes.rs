//! Stash listing and stash mutations.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard, OnceLock};

use crate::git::types::{StashContextCommit, StashEntry};

use super::cli::run_git;
use super::operands::ensure_operand;
use super::stash_push::push_stash;
use super::worktrees::drop_stash_by_oid;

const STASH_CONTEXT_LIMIT: usize = 8;
/// What a routine stash reports. Git's own success line names the branch and
/// the subject it stashed onto ("Saved working directory and index state WIP on
/// PIS-1754: 5b43c275 fix(PIS-1754): scope agenda reorder …"), which is a
/// paragraph of noise in a toast that appears next to the new stash row anyway.
const STASHED_MESSAGE: &str = "Stashed your changes.";
static STASH_WRITE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

/// Serialize GitLane's stash-ref mutations across repositories and worktrees.
/// Git only accepts `stash@{n}` for drop/branch, so the OID-to-index lookup and
/// mutation cannot be one process. This lock closes the in-app race; a terminal
/// can still mutate the reflog, so callers continue to resolve immediately
/// before the destructive command and surface a stale/missing OID.
pub(super) fn lock_stash_writes() -> Result<MutexGuard<'static, ()>, String> {
    STASH_WRITE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "The stash operation lock is unavailable.".to_string())
}

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
            format!(
                "Stash {short} no longer exists — it may have been applied or dropped elsewhere."
            )
        })
}

/// Apply the stash with commit oid `oid` without dropping it. `git stash apply`
/// accepts any stash-shaped commit, so the oid goes straight through.
pub fn stash_apply(repo: &str, oid: &str) -> Result<String, String> {
    ensure_operand(oid)?;
    run_git(repo, &["stash", "apply", oid])
}

pub fn stash_apply_onto(
    repo: &str,
    expected_branch: Option<&str>,
    expected_oid: Option<&str>,
    oid: &str,
) -> Result<String, String> {
    super::head::ensure_expected_head(repo, expected_branch, expected_oid)?;
    stash_apply(repo, oid)
}

/// Apply the stash with commit oid `oid` restoring the staged (index) state too
/// (`--index`). Without `--index` everything lands in the working tree unstaged.
pub fn stash_apply_index(repo: &str, oid: &str) -> Result<String, String> {
    ensure_operand(oid)?;
    run_git(repo, &["stash", "apply", "--index", oid])
}

pub fn stash_apply_index_onto(
    repo: &str,
    expected_branch: Option<&str>,
    expected_oid: Option<&str>,
    oid: &str,
) -> Result<String, String> {
    super::head::ensure_expected_head(repo, expected_branch, expected_oid)?;
    stash_apply_index(repo, oid)
}

/// Check out `branch` at the stash's original parent commit and apply the stash
/// there (`git stash branch <branch> <stash>`). Useful when the stash no longer
/// applies cleanly on the current branch because history has diverged. Creates
/// the branch if it doesn't exist. Addressed via `stash@{n}` (resolved from the
/// oid at the last moment) — with a bare oid git would apply but silently skip
/// the drop.
pub fn stash_branch(repo: &str, branch: &str, oid: &str) -> Result<String, String> {
    let _guard = lock_stash_writes()?;
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
    let _guard = lock_stash_writes()?;
    let applied = stash_apply(repo, oid)?;
    drop_stash_by_oid(repo, oid)?;
    Ok(applied)
}

pub fn stash_pop_onto(
    repo: &str,
    expected_branch: Option<&str>,
    expected_oid: Option<&str>,
    oid: &str,
) -> Result<String, String> {
    super::head::ensure_expected_head(repo, expected_branch, expected_oid)?;
    stash_pop(repo, oid)
}

/// Drop the stash with commit oid `oid`.
pub fn stash_drop(repo: &str, oid: &str) -> Result<String, String> {
    let _guard = lock_stash_writes()?;
    let stash_ref = stash_ref_for_oid(repo, oid)?;
    run_git(repo, &["stash", "drop", &stash_ref])
}

/// Stash every visible working-tree change: staged, unstaged, and untracked.
/// Ignored files stay in place because GitLane does not surface them as changes.
/// Routed through [`push_stash`] so a cleanup git cannot finish reports the real
/// outcome instead of a raw failure over a stash it already stored.
pub fn stash(repo: &str) -> Result<String, String> {
    let _guard = lock_stash_writes()?;
    let push = push_stash(repo, &["stash", "push", "--include-untracked"])?;
    // Normalise only a routine success, and only once an entry demonstrably
    // exists. "No local changes to save" — and the rare push that reproduces an
    // existing stash's oid, which leaves `refs/stash` standing still — reach the
    // user as git worded them rather than being claimed as a fresh stash. A
    // recovered push always keeps its own account of what git could not finish.
    if !push.recovered && push.oid.is_some() {
        return Ok(STASHED_MESSAGE.to_string());
    }
    Ok(push.message)
}

pub fn stash_expected(
    repo: &str,
    expected_branch: Option<&str>,
    expected_oid: Option<&str>,
) -> Result<String, String> {
    super::head::ensure_expected_head(repo, expected_branch, expected_oid)?;
    stash(repo)
}

/// Stash one literal path (staged, unstaged, and — when present — untracked).
/// Uses `git stash push --include-untracked -- <path>` so an untracked leaf is
/// included when that is the change being reviewed.
///
/// Deliberately does **not** route through [`push_stash`]: that helper's
/// interrupted-cleanup recovery finishes with a whole-tree `reset --hard`, which
/// would wipe unrelated dirty paths that a pathspec stash intentionally left
/// alone. Empty-directory preservation still wraps the push — git's pathspec
/// cleanup can remove a just-emptied parent the same way a full-tree stash can.
pub fn stash_paths(repo: &str, paths: &[String]) -> Result<String, String> {
    if paths.is_empty() {
        return Err("No paths to stash".to_string());
    }
    for path in paths {
        ensure_operand(path)?;
    }
    let _guard = lock_stash_writes()?;
    let empty_dirs = super::empty_dirs::capture(repo)?;
    let mut args: Vec<&str> = vec!["stash", "push", "--include-untracked", "--"];
    args.extend(paths.iter().map(String::as_str));
    // Literal pathspecs: a real filename like `:(glob)*` must not expand.
    let mut literal: Vec<&str> = Vec::with_capacity(args.len() + 1);
    literal.push("--literal-pathspecs");
    literal.extend_from_slice(&args);
    let outcome = run_git(repo, &literal);
    let unpreserved = super::empty_dirs::restore(repo, &empty_dirs);
    let message = outcome?;
    if !unpreserved.is_empty() {
        let names = unpreserved.join(", ");
        return Ok(format!(
            "{message} Git's cleanup also removed empty untracked director{} GitLane could not recreate: {names}. They held no files, so nothing was lost but the folders themselves.",
            if unpreserved.len() == 1 { "y" } else { "ies" },
        ));
    }
    let label = if paths.len() == 1 {
        paths[0].as_str()
    } else {
        "selected files"
    };
    // Prefer a short toast on routine success; keep git's wording when it said
    // there was nothing to save (or any other non-empty diagnostic).
    if message.is_empty()
        || message
            .to_ascii_lowercase()
            .contains("saved working directory")
    {
        return Ok(format!("Stashed {label}."));
    }
    Ok(message)
}

pub fn stash_paths_expected(
    repo: &str,
    expected_branch: Option<&str>,
    expected_oid: Option<&str>,
    paths: &[String],
) -> Result<String, String> {
    super::head::ensure_expected_head(repo, expected_branch, expected_oid)?;
    stash_paths(repo, paths)
}
