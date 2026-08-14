//! Snapshotting the live index, installing the squash-owned tree, and the
//! compare-and-restore that puts the caller's staging back.

use std::path::{Path, PathBuf};

use super::super::cli::{run_git, run_git_stdout};

/// The live index of `repo` — the per-worktree git dir's own `index`, so a
/// linked worktree snapshots its staging and not the main checkout's. Parsed
/// from stdout alone: [`run_git`] concatenates stderr onto the result, and a
/// warning git wrote there would land inside the path.
pub(super) fn absolute_index_path(repo: &str) -> Result<PathBuf, String> {
    let git_dir = run_git_stdout(repo, &["rev-parse", "--absolute-git-dir"])?;
    Ok(PathBuf::from(git_dir.trim()).join("index"))
}

pub(super) fn ensure_index_not_unmerged(repo: &str) -> Result<(), String> {
    let unmerged = run_git_stdout(repo, &["ls-files", "-u"])?;
    if unmerged.lines().any(|line| !line.is_empty()) {
        return Err(
            "Cannot squash while the index has unresolved conflicts. Finish or abort the conflict first."
                .to_string(),
        );
    }
    Ok(())
}

pub(super) fn read_index_bytes(path: &Path) -> Result<Vec<u8>, String> {
    std::fs::read(path).map_err(|error| format!("Could not snapshot the git index: {error}"))
}

/// A GitLane-owned scratch path beside the index. Unique per process *and* per
/// call: two squashes on one worktree would otherwise share a fixed name and
/// overwrite each other's snapshot mid-flight.
pub(super) fn squash_temp_path(index_path: &Path, kind: &str) -> PathBuf {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    index_path.with_extension(format!(
        "gitlane-squash-{kind}-{}-{}",
        std::process::id(),
        SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ))
}

fn write_index_bytes(path: &Path, bytes: &[u8]) -> Result<(), String> {
    // Deliberate exception to "writes go through the git CLI": git has no
    // porcelain that reloads an exact on-disk index, and anything short of the
    // exact bytes loses staged mode bits, intent-to-add, and partial stages.
    // Write beside the index and rename into place; `handoff.rs` is the
    // precedent for GitLane writing under `.git` via `std::fs`. This does not
    // take `index.lock`, so a terminal `git` staging inside the window is caught
    // by the tree comparison rather than serialized against — an accepted risk.
    // Ordinary staging mutations stay on `run_git`.
    let tmp = squash_temp_path(path, "restore");
    std::fs::write(&tmp, bytes)
        .map_err(|error| format!("Could not restore the git index: {error}"))?;
    std::fs::rename(&tmp, path).map_err(|error| {
        let _ = std::fs::remove_file(&tmp);
        format!("Could not restore the git index: {error}")
    })
}

/// Paths where the live index diverges from `tree_ish`. Comparing against a
/// tree — rather than a fingerprint captured before the commit — is what lets a
/// pre-commit hook stage into the index without being mistaken for a concurrent
/// writer: whatever the hook added is part of the commit we just made, so the
/// index still matches it. Empty output means nobody else staged during squash.
fn index_divergence_from(repo: &str, tree_ish: &str) -> Result<String, String> {
    run_git_stdout(repo, &["diff-index", "--cached", "--name-only", tree_ish])
}

/// Materialize the squash-owned tip tree into the index without touching the
/// worktree (`read-tree` without `-u`).
pub(super) fn install_squash_owned_tree(repo: &str, tip_oid: &str) -> Result<(), String> {
    run_git(repo, &["read-tree", tip_oid]).map(|_| ())
}

/// Restore the pre-squash index snapshot only while the live index still holds
/// exactly what this squash staged (compare-and-restore). `expected_tree_ish` is
/// the landed squash commit on success and the untouched tip on failure — in
/// both cases the tree the index must still match for a restore to be safe.
pub(super) fn restore_index_snapshot(
    repo: &str,
    index_path: &Path,
    snapshot: &[u8],
    expected_tree_ish: &str,
    commit_succeeded: bool,
) -> Result<(), String> {
    if !index_divergence_from(repo, expected_tree_ish)?
        .trim()
        .is_empty()
    {
        return Err(if commit_succeeded {
            "Squash commit was created, but the index changed during squash; pre-staged work was not reapplied."
                .to_string()
        } else {
            "Squash failed, and the index changed during squash; pre-staged work was not restored."
                .to_string()
        });
    }
    write_index_bytes(index_path, snapshot)
}
