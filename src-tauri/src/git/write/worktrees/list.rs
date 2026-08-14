//! Listing the repository's linked worktrees.

use crate::git::types::WorktreeInfo;

use super::super::cli::run_git_stdout_raw;

/// List linked worktrees via `git worktree list --porcelain`. This is a read,
/// but uses the CLI's stable porcelain output rather than libgit2's awkward
/// worktree API. The first entry is always the primary (main) worktree.
pub fn worktrees(repo: &str) -> Result<Vec<WorktreeInfo>, String> {
    let raw = run_git_stdout_raw(repo, &["worktree", "list", "--porcelain", "-z"])?;
    let mut out = Vec::new();
    let mut path: Option<String> = None;
    let mut branch: Option<String> = None;
    let mut head: Option<String> = None;
    // Per-entry attribute flags, reset at each `worktree` boundary. `bare`
    // (main is a bare repo) and `prunable` (directory gone) both mean the entry
    // has no usable working tree — a branch can't be checked out into it.
    // `locked` means git refuses removal without `--force --force`.
    let mut bare = false;
    let mut prunable = false;
    let mut locked = false;
    let mut first = true;

    let mut flush = |path: &mut Option<String>,
                     branch: &mut Option<String>,
                     head: &mut Option<String>,
                     bare: &mut bool,
                     prunable: &mut bool,
                     locked: &mut bool,
                     first: &mut bool| {
        if let Some(p) = path.take() {
            let name = std::path::Path::new(&p)
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or(&p)
                .to_string();
            out.push(WorktreeInfo {
                name,
                path: p,
                branch: branch.take(),
                head: head.take(),
                is_main: std::mem::replace(first, false),
                bare: std::mem::replace(bare, false),
                prunable: std::mem::replace(prunable, false),
                locked: std::mem::replace(locked, false),
            });
        } else {
            *branch = None;
            *head = None;
            *bare = false;
            *prunable = false;
            *locked = false;
        }
    };

    for field in raw
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty())
    {
        let line = String::from_utf8_lossy(field);
        if let Some(p) = line.strip_prefix("worktree ") {
            flush(
                &mut path,
                &mut branch,
                &mut head,
                &mut bare,
                &mut prunable,
                &mut locked,
                &mut first,
            );
            path = Some(p.to_string());
        } else if let Some(b) = line.strip_prefix("branch ") {
            branch = Some(b.trim_start_matches("refs/heads/").to_string());
        } else if let Some(h) = line.strip_prefix("HEAD ") {
            head = Some(h.to_string());
        } else if line.as_ref() == "bare" {
            bare = true;
        } else if line.as_ref() == "prunable" || line.starts_with("prunable ") {
            prunable = true;
        } else if line.as_ref() == "locked" || line.starts_with("locked ") {
            locked = true;
        }
    }
    flush(
        &mut path,
        &mut branch,
        &mut head,
        &mut bare,
        &mut prunable,
        &mut locked,
        &mut first,
    );
    Ok(out)
}
