//! Collision-safe email patch creation in the repository worktree.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;

use super::cli::run_git;
use super::history::is_merge_commit;
use super::operands::ensure_operand;

/// Write a patch for one non-merge commit into the worktree without allowing
/// git's generated filename to overwrite an existing file. `format-patch -1`
/// silently skips merge commits and selects a nearby non-merge ancestor, so
/// merges are rejected until the UI exposes an explicit first-parent policy.
pub fn create_patch(repo: &str, sha: &str) -> Result<String, String> {
    ensure_operand(sha)?;
    if is_merge_commit(repo, sha)? {
        return Err(
            "Merge commits do not have a single email-patch delta. Review a parent diff or choose a non-merge commit."
                .to_string(),
        );
    }

    let patch = super::cli::run_git_stdout_raw(repo, &["format-patch", "--stdout", "-1", sha])?;
    let subject = run_git(
        repo,
        &["show", "-s", "--no-show-signature", "--format=%f", sha],
    )?;
    let fallback: String = sha.chars().take(12).collect();
    let safe_subject: String = subject.trim().chars().take(96).collect();
    let safe_subject = if safe_subject.is_empty() {
        fallback.as_str()
    } else {
        safe_subject.as_str()
    };

    write_collision_safe(repo, &format!("0001-{safe_subject}"), &patch)
}

/// Write a single mailbox file covering every commit in the contiguous
/// `base..head` range (`git format-patch --stdout`). Callers gate this on a
/// first-parent-contiguous selection (the same range the batch "Compare" uses),
/// so the range is a straight line; a merge inside it is rejected because
/// `format-patch` would silently drop it, producing a patch that doesn't match
/// what the user selected.
pub fn create_patch_range(repo: &str, base: &str, head: &str) -> Result<String, String> {
    ensure_operand(base)?;
    ensure_operand(head)?;
    let range = format!("{base}..{head}");

    let merges = run_git(repo, &["rev-list", "--merges", "--count", &range])?;
    if merges.trim() != "0" {
        return Err(
            "The selection includes a merge commit, which has no single email-patch delta. Choose a range of non-merge commits."
                .to_string(),
        );
    }

    let patch = super::cli::run_git_stdout_raw(repo, &["format-patch", "--stdout", &range])?;
    if patch.is_empty() {
        return Err("The selected commits produced no patch.".to_string());
    }

    let count = run_git(repo, &["rev-list", "--count", &range])?;
    let count = count.trim();
    let subject = run_git(
        repo,
        &["show", "-s", "--no-show-signature", "--format=%f", head],
    )?;
    let fallback: String = head.chars().take(12).collect();
    let safe_subject: String = subject.trim().chars().take(96).collect();
    let safe_subject = if safe_subject.is_empty() {
        fallback.as_str()
    } else {
        safe_subject.as_str()
    };

    write_collision_safe(repo, &format!("{count}-commits-{safe_subject}"), &patch)
}

/// Write `patch` into the repo worktree under `<base_name>.patch`, never
/// overwriting an existing file — a numeric suffix is appended on collision so
/// git's generated name can't clobber the user's files.
fn write_collision_safe(repo: &str, base_name: &str, patch: &[u8]) -> Result<String, String> {
    let worktree_raw = super::cli::run_git_stdout_raw(repo, &["rev-parse", "--show-toplevel"])?;
    let worktree = String::from_utf8(worktree_raw)
        .map_err(|_| "The repository worktree path is not valid UTF-8.".to_string())?;
    let worktree = PathBuf::from(worktree.trim_end_matches(['\r', '\n']));

    for collision in 0..10_000 {
        let filename = if collision == 0 {
            format!("{base_name}.patch")
        } else {
            format!("{base_name}-{}.patch", collision + 1)
        };
        let path = worktree.join(&filename);
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                if let Err(error) = file.write_all(patch) {
                    let _ = std::fs::remove_file(&path);
                    return Err(format!("Couldn't write patch {filename}: {error}"));
                }
                return Ok(filename);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("Couldn't create patch {filename}: {error}")),
        }
    }

    Err("Couldn't choose an unused patch filename in the worktree.".to_string())
}
