//! Opaque Worktree Removal Lease (GL-303).
//!
//! Preview captures linked-worktree registration (private gitdir path +
//! directory identity), workdir identity, optional branch + HEAD oid, and
//! porcelain dirty path+status
//! (staged/unstaged/untracked only). Ignored entries are disclosed for UI on
//! preview only and are not leased. Execute re-captures and refuses on mismatch
//! before removal.

use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use sha2::{Digest, Sha256};

use crate::git::types::{RemoveWorktreePreview, WorktreeDirtyState, WorktreeInfo};
use crate::git::worktree_fs::{worktree_directory_identity, WorktreeDirectoryIdentity};

use super::cli::run_git_stdout;
use super::operands::ensure_operand;
use super::worktrees::{is_porcelain_record, worktrees};

const TOKEN_PREFIX: &str = "v1:";
const HASH_DOMAIN: &[u8] = b"gitlane-worktree-removal-v1\0";

pub(super) const STALE_MESSAGE: &str =
    "The worktree changed after this confirmation opened. Preview the removal again.";

struct DirtyRecord {
    /// Full porcelain line (`XY path` or rename form), excluding ignored.
    line: String,
}

struct DirtyCapture {
    records: Vec<DirtyRecord>,
    modified: u32,
    untracked: u32,
}

pub(super) struct RemovalLeaseSnapshot {
    pub expected_state: String,
    /// The canonical registered workdir this lease was taken over — the *only*
    /// path a removal may hand to git. The client-supplied pathname is not
    /// reused after validation: it can be a symlink alias that gets retargeted
    /// between the compare and the subprocess spawn, which would remove a
    /// directory the confirm never leased.
    pub workdir: PathBuf,
    pub requires_force: bool,
    pub locked: bool,
    pub branch: Option<String>,
    pub head_oid: Option<String>,
    /// Dirty counts from the leased porcelain snapshot. `ignored` is always 0
    /// here — disclosure is filled only on the preview path.
    pub dirty: WorktreeDirtyState,
}

fn hash_field(state: &mut Sha256, bytes: &[u8]) {
    state.update((bytes.len() as u64).to_le_bytes());
    state.update(bytes);
}

#[cfg(unix)]
fn filesystem_path_bytes(path: &Path) -> Vec<u8> {
    use std::os::unix::ffi::OsStrExt as _;
    path.as_os_str().as_bytes().to_vec()
}

#[cfg(windows)]
fn filesystem_path_bytes(path: &Path) -> Vec<u8> {
    use std::os::windows::ffi::OsStrExt as _;
    path.as_os_str()
        .encode_wide()
        .flat_map(u16::to_le_bytes)
        .collect()
}

#[cfg(not(any(unix, windows)))]
fn filesystem_path_bytes(path: &Path) -> Vec<u8> {
    path.to_string_lossy().into_owned().into_bytes()
}

fn same_path(a: &str, b: &str) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => a.trim_end_matches('/') == b.trim_end_matches('/'),
    }
}

fn find_registered(repo: &str, worktree_path: &str) -> Result<WorktreeInfo, String> {
    worktrees(repo)?
        .into_iter()
        .find(|w| same_path(&w.path, worktree_path))
        .ok_or_else(|| {
            format!("No worktree is registered at {worktree_path} anymore. Refresh and try again.")
        })
}

/// Resolve a linked worktree's private gitdir from its `.git` *file* pointer.
/// Registration ABA is closed by fingerprinting this admin directory's path and
/// filesystem identity (same pattern as Discard All's scope lease).
fn linked_worktree_gitdir(workdir: &Path) -> Result<PathBuf, String> {
    let git_path = workdir.join(".git");
    let meta = std::fs::symlink_metadata(&git_path)
        .map_err(|error| format!("resolve worktree registration: {error}"))?;
    if meta.is_dir() {
        return Err("Expected a linked worktree (.git file), but found a .git directory.".into());
    }
    let raw = std::fs::read_to_string(&git_path)
        .map_err(|error| format!("read worktree registration: {error}"))?;
    let target = raw
        .lines()
        .next()
        .and_then(|line| line.strip_prefix("gitdir:"))
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .ok_or_else(|| "Worktree .git file is missing a gitdir: pointer.".to_string())?;
    let gitdir = {
        let path = PathBuf::from(target);
        if path.is_absolute() {
            path
        } else {
            workdir.join(path)
        }
    };
    gitdir
        .canonicalize()
        .map_err(|error| format!("resolve worktree gitdir identity: {error}"))
}

/// One porcelain status for both lease fingerprint rows and dirty counts so
/// preview never discloses a clean tree while leasing a dirty one (or the reverse).
fn dirty_porcelain_capture(worktree_path: &str) -> Result<DirtyCapture, String> {
    let raw = run_git_stdout(
        worktree_path,
        &["status", "--porcelain", "--untracked-files=all"],
    )?;
    let mut records = Vec::new();
    let mut modified = 0u32;
    let mut untracked = 0u32;
    for line in raw.lines().filter(|line| is_porcelain_record(line)) {
        // Ignored (`!!`) is never leased — disclosed via a separate collapsed probe.
        if line.starts_with("!!") {
            continue;
        }
        if line.starts_with("??") {
            untracked += 1;
        } else {
            modified += 1;
        }
        records.push(DirtyRecord {
            line: line.to_string(),
        });
    }
    records.sort_by(|a, b| a.line.cmp(&b.line));
    Ok(DirtyCapture {
        records,
        modified,
        untracked,
    })
}

/// Collapsed ignored count for preview disclosure only (not part of the lease).
/// Failures are fatal on preview so a local `.env` cannot be deleted undiscussed.
fn ignored_disclosure_count(worktree_path: &str) -> Result<u32, String> {
    let raw = run_git_stdout(worktree_path, &["status", "--porcelain", "--ignored"])?;
    Ok(raw
        .lines()
        .filter(|line| is_porcelain_record(line) && line.starts_with("!!"))
        .count() as u32)
}

fn digest_identity(state: &mut Sha256, identity: WorktreeDirectoryIdentity) {
    identity.hash_into(state);
}

fn capture(repo: &str, worktree_path: &str) -> Result<RemovalLeaseSnapshot, String> {
    ensure_operand(worktree_path)?;
    let info = find_registered(repo, worktree_path)?;
    if info.is_main {
        return Err("The main worktree cannot be removed.".into());
    }
    if info.bare {
        return Err("A bare repository has no working tree to remove.".into());
    }
    if info.prunable {
        return Err(
            "The worktree's directory is missing (prunable). Refresh and try again.".into(),
        );
    }

    let workdir = std::fs::canonicalize(&info.path)
        .map_err(|error| format!("resolve worktree identity: {error}"))?;
    let workdir_identity = worktree_directory_identity(&workdir)
        .map_err(|error| format!("resolve worktree directory identity: {error}"))?;
    let gitdir = linked_worktree_gitdir(&workdir)?;
    let gitdir_identity = worktree_directory_identity(&gitdir)
        .map_err(|error| format!("resolve worktree gitdir identity: {error}"))?;

    let dirty_capture = dirty_porcelain_capture(worktree_path)?;
    let dirty = WorktreeDirtyState {
        modified: dirty_capture.modified,
        untracked: dirty_capture.untracked,
        ignored: 0,
    };
    let uncommitted = dirty.modified + dirty.untracked > 0;
    let requires_force = uncommitted || info.locked;

    let mut state = Sha256::new();
    state.update(HASH_DOMAIN);
    let repo_canon = std::fs::canonicalize(repo)
        .map_err(|error| format!("resolve repository identity: {error}"))?;
    hash_field(&mut state, &filesystem_path_bytes(&repo_canon));
    hash_field(&mut state, &filesystem_path_bytes(&workdir));
    digest_identity(&mut state, workdir_identity);
    // Registration half: private admin gitdir path + inode (ABA on re-attach).
    hash_field(&mut state, &filesystem_path_bytes(&gitdir));
    digest_identity(&mut state, gitdir_identity);
    state.update([u8::from(info.locked)]);
    state.update([u8::from(info.bare)]);
    state.update([u8::from(info.prunable)]);
    match &info.branch {
        Some(branch) => {
            state.update([1u8]);
            hash_field(&mut state, branch.as_bytes());
        }
        None => state.update([0u8]),
    }
    match &info.head {
        Some(oid) => {
            state.update([1u8]);
            hash_field(&mut state, oid.as_bytes());
        }
        None => state.update([0u8]),
    }
    state.update((dirty_capture.records.len() as u64).to_le_bytes());
    for record in &dirty_capture.records {
        hash_field(&mut state, record.line.as_bytes());
    }

    Ok(RemovalLeaseSnapshot {
        expected_state: format!("{TOKEN_PREFIX}{}", URL_SAFE_NO_PAD.encode(state.finalize())),
        workdir,
        requires_force,
        locked: info.locked,
        branch: info.branch,
        head_oid: info.head,
        dirty,
    })
}

fn impact_copy(snapshot: &RemovalLeaseSnapshot, worktree_path: &str) -> RemoveWorktreePreview {
    let name = Path::new(worktree_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(worktree_path);
    let mut details = vec![format!(
        "The linked worktree at {worktree_path} will be removed."
    )];
    let mut warnings = Vec::new();
    match &snapshot.branch {
        Some(branch) => {
            details.push(format!(
                "Its branch {branch} and that branch's commits are kept."
            ));
        }
        None => {
            let short = snapshot
                .head_oid
                .as_deref()
                .map(|oid| format!(" {}", &oid[..oid.len().min(7)]))
                .unwrap_or_default();
            warnings.push(format!(
                "This worktree is detached (no branch) — its commit{short} may become unreachable unless a branch or tag points to it."
            ));
        }
    }
    let uncommitted = snapshot.dirty.modified + snapshot.dirty.untracked;
    if uncommitted > 0 {
        let mut parts = Vec::new();
        if snapshot.dirty.modified > 0 {
            parts.push(format!(
                "{} modified file{}",
                snapshot.dirty.modified,
                if snapshot.dirty.modified == 1 {
                    ""
                } else {
                    "s"
                }
            ));
        }
        if snapshot.dirty.untracked > 0 {
            parts.push(format!(
                "{} untracked file{}",
                snapshot.dirty.untracked,
                if snapshot.dirty.untracked == 1 {
                    ""
                } else {
                    "s"
                }
            ));
        }
        warnings.push(format!(
            "{} in this worktree will be permanently deleted. This work was never committed, so it cannot be recovered afterwards.",
            parts.join(" and ")
        ));
    }
    if snapshot.dirty.ignored > 0 {
        warnings.push(format!(
            "{} ignored entr{} (such as build output or a local .env) will also be deleted. Git treats ignored files as regenerable, so this does not need a forced removal.",
            snapshot.dirty.ignored,
            if snapshot.dirty.ignored == 1 {
                "y"
            } else {
                "ies"
            }
        ));
    }
    if snapshot.locked {
        warnings.push("This worktree is locked; removing it will override the lock.".into());
    }
    let summary = if uncommitted > 0 {
        format!("{name} has uncommitted work that removing it would discard.")
    } else {
        format!("Remove the linked worktree {name}?")
    };
    RemoveWorktreePreview {
        summary,
        details,
        warnings,
        expected_state: snapshot.expected_state.clone(),
        requires_force: snapshot.requires_force,
        locked: snapshot.locked,
        branch: snapshot.branch.clone(),
        head_oid: snapshot.head_oid.clone(),
        dirty: snapshot.dirty.clone(),
    }
}

/// Preview Linked Worktree Removal and capture the Worktree Removal Lease.
pub fn preview_remove_worktree(
    repo: &str,
    worktree_path: &str,
) -> Result<RemoveWorktreePreview, String> {
    let mut snapshot = capture(repo, worktree_path)?;
    snapshot.dirty.ignored = ignored_disclosure_count(worktree_path)?;
    Ok(impact_copy(&snapshot, worktree_path))
}

/// Re-capture and compare the lease. On match, returns whether the server must
/// force (`dirty || locked`).
pub(super) fn validate_removal_lease(
    repo: &str,
    worktree_path: &str,
    expected_state: &str,
) -> Result<RemovalLeaseSnapshot, String> {
    if !expected_state.starts_with(TOKEN_PREFIX) {
        return Err(STALE_MESSAGE.to_string());
    }
    let snapshot = capture(repo, worktree_path).map_err(|error| {
        if error.contains("No worktree is registered")
            || error.contains("prunable")
            || error.contains("missing")
            || error.contains("registration")
            || error.contains("gitdir")
        {
            format!("{STALE_MESSAGE} {error}")
        } else {
            error
        }
    })?;
    if snapshot.expected_state != expected_state {
        return Err(STALE_MESSAGE.to_string());
    }
    Ok(snapshot)
}
