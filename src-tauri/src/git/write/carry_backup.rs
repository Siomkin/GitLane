//! The recovery stash written before a worktree-handoff carry is aborted.

use std::path::Path;

use super::cli::{run_git, run_git_env_stdout, run_git_stdout, run_git_with_index_file};

pub(super) const CARRY_BACKUP_NAME: &str = "GitLane: carry abort backup";

/// A recovery object, never published, and it must not fail for want of a
/// configured identity (`git stash` has its own fallback for the same reason).
const CARRY_BACKUP_IDENTITY: &[(&str, &str)] = &[
    ("GIT_AUTHOR_NAME", "GitLane"),
    ("GIT_AUTHOR_EMAIL", "gitlane@localhost"),
    ("GIT_COMMITTER_NAME", "GitLane"),
    ("GIT_COMMITTER_EMAIL", "gitlane@localhost"),
];

/// Windows' argv limit is 32K characters.
const PATHS_PER_ADD: usize = 100;

struct RemoveOnDrop<'a>(&'a Path);

impl Drop for RemoveOnDrop<'_> {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(self.0);
    }
}

/// Save tracked work to a stash and report whether there was any. Built from a
/// copy of the real index so the index stays untouched; `git stash create`
/// refuses unmerged entries. The stash's index parent keeps what was staged and
/// its tree keeps the working files, the same split `git stash` makes.
pub(super) fn stash_carry_backup(repo: &str, git_dir: &Path, head: &str) -> Result<bool, String> {
    // Per process: a lock left by a crash must not block the next abort.
    let index = git_dir.join(format!("gitlane-carry-abort-index-{}", std::process::id()));
    let _remove_index = RemoveOnDrop(&index);
    std::fs::copy(git_dir.join("index"), &index)
        .map_err(|error| format!("Failed to copy the index for the backup: {error}"))?;
    let staged = staged_tree(repo, &index)?;
    run_git_with_index_file(repo, &index, &["add", "-u", "--", ":/"])?;
    let work = run_git_with_index_file(repo, &index, &["write-tree"])?;
    let (staged, work) = (staged.trim(), work.trim());
    let head_tree = run_git_stdout(repo, &["rev-parse", &format!("{head}^{{tree}}")])?;
    let head_tree = head_tree.trim();
    if staged == head_tree && work == head_tree {
        return Ok(false);
    }
    // The reset after this can fail and be retried with the same content.
    let top = run_git_stdout(
        repo,
        &["log", "-g", "-1", "--format=%T%x09%gs", "refs/stash"],
    )
    .unwrap_or_default();
    if top.trim() == format!("{work}\t{CARRY_BACKUP_NAME}") {
        return Ok(true);
    }
    let index_commit = backup_commit(repo, staged, &[head])?;
    // `stash store` rejects anything but a two-parent commit.
    let work_commit = backup_commit(repo, work, &[head, index_commit.trim()])?;
    run_git(
        repo,
        &[
            "stash",
            "store",
            "-m",
            CARRY_BACKUP_NAME,
            work_commit.trim(),
        ],
    )?;
    Ok(true)
}

/// The tree of what is staged in `index`. An unmerged path has no single staged
/// version, so it takes its working file (conflict markers included).
fn staged_tree(repo: &str, index: &Path) -> Result<String, String> {
    let listing = run_git_with_index_file(repo, index, &["ls-files", "-u", "-z"])?;
    let mut paths: Vec<&str> = listing
        .split('\0')
        .filter_map(|entry| entry.split_once('\t'))
        .map(|(_, path)| path)
        .collect();
    paths.dedup();
    for batch in paths.chunks(PATHS_PER_ADD) {
        let mut args = vec!["--literal-pathspecs", "add", "--"];
        args.extend(batch);
        run_git_with_index_file(repo, index, &args)?;
    }
    run_git_with_index_file(repo, index, &["write-tree"])
}

fn backup_commit(repo: &str, tree: &str, parents: &[&str]) -> Result<String, String> {
    let mut args = vec!["commit-tree", tree, "-m", CARRY_BACKUP_NAME];
    for parent in parents {
        args.extend(["-p", parent]);
    }
    run_git_env_stdout(repo, &args, CARRY_BACKUP_IDENTITY)
}
