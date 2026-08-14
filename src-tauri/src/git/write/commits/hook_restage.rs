//! Re-staging what a pre-commit hook contributed to the landed squash, without
//! disturbing the paths the caller had staged themselves.

use std::path::Path;

use super::super::cli::{run_git_literal_paths, run_git_stdout_raw};
use super::index_snapshot::squash_temp_path;

/// Split git's NUL-delimited output without decoding it. Paths make a round trip
/// back into a pathspec file, so a non-UTF-8 name has to survive as bytes.
fn split_nul(raw: &[u8]) -> Vec<Vec<u8>> {
    raw.split(|byte| *byte == 0)
        .filter(|part| !part.is_empty())
        .map(<[u8]>::to_vec)
        .collect()
}

/// Paths the caller had staged against `tree_ish` — their pre-staged work.
pub(super) fn staged_paths_against(repo: &str, tree_ish: &str) -> Result<Vec<Vec<u8>>, String> {
    let raw = run_git_stdout_raw(
        repo,
        &["diff-index", "--cached", "-z", "--name-only", tree_ish],
    )?;
    Ok(split_nul(&raw))
}

/// Re-stage what a pre-commit hook contributed to the landed commit. The restored
/// snapshot predates the hook, so a path the hook *added* reads as a staged
/// deletion against the new HEAD, and a file it reformatted reads as a staged
/// revert — both invite the user to undo the hook on their next commit. Paths the
/// caller had staged themselves are left alone: preserving pre-staged work
/// outranks matching the hook.
pub(super) fn restage_hook_contribution(
    repo: &str,
    index_path: &Path,
    tip_oid: &str,
    landed_oid: &str,
    caller_staged: &[Vec<u8>],
) -> Result<(), String> {
    // `--no-renames` pins the invariant this depends on: both endpoints of a
    // rename must be listed, or the pre-rename path stays staged for
    // resurrection. Plumbing ignores `diff.renames` today; saying so keeps this
    // correct if that ever changes.
    let raw = run_git_stdout_raw(
        repo,
        &[
            "diff-tree",
            "-r",
            "-z",
            "--no-renames",
            "--name-only",
            tip_oid,
            landed_oid,
        ],
    )?;
    let owned: std::collections::HashSet<&[u8]> = caller_staged.iter().map(Vec::as_slice).collect();
    let mut pathspec = Vec::new();
    for path in split_nul(&raw) {
        if owned.contains(path.as_slice()) {
            continue;
        }
        pathspec.extend_from_slice(&path);
        pathspec.push(0);
    }
    if pathspec.is_empty() {
        return Ok(());
    }

    // A pathspec *file* keeps the names as bytes; `-z` output would otherwise have
    // to become UTF-8 to ride in argv.
    let spec_file = squash_temp_path(index_path, "pathspec");
    let spec_arg = match spec_file.to_str() {
        Some(path) => format!("--pathspec-from-file={path}"),
        None => return Err(restage_failure("the git directory path is not valid UTF-8")),
    };
    std::fs::write(&spec_file, &pathspec).map_err(|error| restage_failure(&error.to_string()))?;
    let reset = run_git_literal_paths(
        repo,
        &["reset", "-q", landed_oid, &spec_arg, "--pathspec-file-nul"],
    );
    let _ = std::fs::remove_file(&spec_file);
    reset.map(|_| ()).map_err(|error| restage_failure(&error))
}

fn restage_failure(cause: &str) -> String {
    format!(
        "Squash commit was created and pre-staged work was restored, but paths a pre-commit hook \
         added could not be re-staged: {cause}"
    )
}
