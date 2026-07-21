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

    let worktree_raw = super::cli::run_git_stdout_raw(repo, &["rev-parse", "--show-toplevel"])?;
    let worktree = String::from_utf8(worktree_raw)
        .map_err(|_| "The repository worktree path is not valid UTF-8.".to_string())?;
    let worktree = PathBuf::from(worktree.trim_end_matches(['\r', '\n']));

    for collision in 0..10_000 {
        let filename = if collision == 0 {
            format!("0001-{safe_subject}.patch")
        } else {
            format!("0001-{safe_subject}-{}.patch", collision + 1)
        };
        let path = worktree.join(&filename);
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                if let Err(error) = file.write_all(&patch) {
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
