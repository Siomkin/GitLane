//! Conflict + in-progress-operation detection (libgit2 reads).
//!
//! Like the other read modules, every function takes a path and opens the repo
//! fresh — `git2::Repository` is not `Send`, so we never hold one across the
//! async Tauri command boundary. This module only *reports* the conflicted
//! state; *resolving* it (accept ours/theirs, stage, continue/abort/skip)
//! shells out to the real `git` binary in [`super::write`], per the read/write
//! split.

use git2::{IndexConflict, IndexEntry, Repository, RepositoryState};

use super::read::open;
use super::types::{ConflictFile, ConflictFileContent, OperationStatus};

/// Map libgit2's `RepositoryState` to the operation key the frontend expects.
/// Anything that isn't a merge/rebase/cherry-pick/revert (Clean, Bisect,
/// ApplyMailbox, …) reports "none" — the conflict workflow only covers the
/// operations GitLane can drive to completion.
fn operation_kind(state: RepositoryState) -> &'static str {
    match state {
        RepositoryState::Merge => "merge",
        RepositoryState::Revert | RepositoryState::RevertSequence => "revert",
        RepositoryState::CherryPick | RepositoryState::CherryPickSequence => "cherry-pick",
        RepositoryState::Rebase
        | RepositoryState::RebaseInteractive
        | RepositoryState::RebaseMerge => "rebase",
        _ => "none",
    }
}

/// The active operation (if any) plus its outstanding conflicts.
pub fn operation_status(path: &str) -> Result<OperationStatus, git2::Error> {
    let repo = open(path)?;
    let kind = operation_kind(repo.state());
    // Conflicts can exist only inside an operation; skip the index walk for a
    // clean repo so the common case stays cheap.
    let conflicts = if kind == "none" {
        Vec::new()
    } else {
        conflict_files(&repo)?
    };
    Ok(OperationStatus {
        kind: kind.to_string(),
        can_skip: matches!(kind, "rebase" | "cherry-pick" | "revert"),
        conflicts,
    })
}

/// Every unmerged path in the index, classified as text / binary / deleted.
fn conflict_files(repo: &Repository) -> Result<Vec<ConflictFile>, git2::Error> {
    let index = repo.index()?;
    if !index.has_conflicts() {
        return Ok(Vec::new());
    }

    let mut out = Vec::new();
    for entry in index.conflicts()? {
        let conflict = entry?;
        // Take the path from whichever stage exists (a deletion leaves one side
        // empty); skip the pathological all-empty conflict.
        let path = conflict
            .our
            .as_ref()
            .or(conflict.their.as_ref())
            .or(conflict.ancestor.as_ref())
            .map(|e| String::from_utf8_lossy(&e.path).to_string());
        let Some(path) = path else { continue };
        let (kind, deleted_side) = classify(repo, &conflict);
        out.push(ConflictFile {
            path,
            kind: kind.to_string(),
            deleted_side: deleted_side.to_string(),
        });
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

/// Classify a single index conflict: a missing side means a delete/modify
/// conflict; otherwise it's a content conflict, binary when either present side
/// is a binary blob.
fn classify(repo: &Repository, conflict: &IndexConflict) -> (&'static str, &'static str) {
    match (&conflict.our, &conflict.their) {
        (Some(_), None) => ("deleted", "theirs"),
        (None, Some(_)) => ("deleted", "ours"),
        (Some(our), Some(their)) => {
            if is_binary(repo, our) || is_binary(repo, their) {
                ("binary", "")
            } else {
                ("text", "")
            }
        }
        // Both sides deleted (DD) — nothing to merge; treat as a deletion both
        // already agree on, surfaced as "deleted by theirs" for the UI's card.
        (None, None) => ("deleted", "theirs"),
    }
}

/// True when an index entry's blob is binary (libgit2's NUL-byte heuristic).
fn is_binary(repo: &Repository, entry: &IndexEntry) -> bool {
    repo.find_blob(entry.id)
        .map(|blob| blob.is_binary())
        .unwrap_or(false)
}

/// The worktree copy of a conflicted text file, including git's merge markers,
/// for the in-app editor to parse. Binary files come back with empty content and
/// `binary: true` (the UI offers a whole-file choice instead of a line editor).
pub fn conflict_file(path: &str, file: &str) -> Result<ConflictFileContent, git2::Error> {
    let repo = open(path)?;
    let workdir = repo
        .workdir()
        .ok_or_else(|| git2::Error::from_str("bare repository has no worktree"))?;
    // `file` crosses the IPC boundary; reject absolute paths and `..`/prefix
    // traversal so a read can never escape the worktree (conflicted paths come
    // from git's index, which already forbids these — validated defensively).
    let rel = std::path::Path::new(file);
    if rel.is_absolute()
        || rel.components().any(|c| {
            matches!(
                c,
                std::path::Component::ParentDir | std::path::Component::Prefix(_)
            )
        })
    {
        return Err(git2::Error::from_str(&format!(
            "refusing unsafe path outside the worktree: {file:?}"
        )));
    }
    // Only a genuine unmerged path may be read here — not any safe relative file.
    let conflicted = repo.index()?.conflicts()?.flatten().any(|c| {
        c.our
            .as_ref()
            .or(c.their.as_ref())
            .or(c.ancestor.as_ref())
            .map_or(false, |entry| &*String::from_utf8_lossy(&entry.path) == file)
    });
    if !conflicted {
        return Err(git2::Error::from_str(&format!(
            "{file:?} is not a conflicted path"
        )));
    }
    let bytes = std::fs::read(workdir.join(rel))
        .map_err(|e| git2::Error::from_str(&format!("read {file}: {e}")))?;
    // Treat NUL-containing or non-UTF-8 files as binary. Lossy-decoding invalid
    // UTF-8 would replace bytes with U+FFFD and silently corrupt the file when
    // the resolved text is written back; a binary classification routes to the
    // whole-file side picker (which never round-trips the bytes through a String).
    let (binary, content) = if bytes.contains(&0) {
        (true, String::new())
    } else {
        match String::from_utf8(bytes) {
            Ok(text) => (false, text),
            Err(_) => (true, String::new()),
        }
    };
    Ok(ConflictFileContent {
        path: file.to_string(),
        content,
        binary,
    })
}

#[cfg(test)]
mod tests {
    use super::{conflict_file, operation_status};
    use std::path::PathBuf;
    use std::process::Command;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// A throwaway temp directory that cleans itself up on drop (mirrors the
    /// dependency-free harness in `write.rs` tests).
    struct TempRepo(PathBuf);
    impl TempRepo {
        fn new(tag: &str) -> Self {
            static SEQ: AtomicU32 = AtomicU32::new(0);
            let n = SEQ.fetch_add(1, Ordering::Relaxed);
            let dir = std::env::temp_dir().join(format!("gitlane-{tag}-{}-{n}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            TempRepo(dir)
        }
        fn path(&self) -> &str {
            self.0.to_str().unwrap()
        }
        fn git(&self, args: &[&str]) -> std::process::Output {
            Command::new("git")
                .arg("-C")
                .arg(&self.0)
                .args(args)
                .output()
                .expect("git launches in tests")
        }
        fn init(&self) {
            self.git(&["init", "-q", "-b", "main"]);
            self.git(&["config", "user.email", "t@t.t"]);
            self.git(&["config", "user.name", "T"]);
            self.git(&["config", "commit.gpgsign", "false"]);
        }
    }
    impl Drop for TempRepo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// Stop a merge on a content conflict in `f.txt`. `base`/`ours`/`theirs` are
    /// the middle line each commit writes; surrounding bytes are shared context.
    fn conflict_repo(tag: &str, base: &[u8], ours: &[u8], theirs: &[u8]) -> TempRepo {
        let repo = TempRepo::new(tag);
        repo.init();
        let body = |mid: &[u8]| {
            let mut v = b"top\n".to_vec();
            v.extend_from_slice(mid);
            v.extend_from_slice(b"\nbottom\n");
            v
        };
        std::fs::write(repo.0.join("f.txt"), body(base)).unwrap();
        repo.git(&["add", "f.txt"]);
        repo.git(&["commit", "-qm", "base"]);
        repo.git(&["checkout", "-q", "-b", "other"]);
        std::fs::write(repo.0.join("f.txt"), body(theirs)).unwrap();
        repo.git(&["commit", "-qam", "theirs"]);
        repo.git(&["checkout", "-q", "main"]);
        std::fs::write(repo.0.join("f.txt"), body(ours)).unwrap();
        repo.git(&["commit", "-qam", "ours"]);
        let _ = repo.git(&["merge", "other"]);
        repo
    }

    #[test]
    fn operation_status_reports_merge_with_conflicts() {
        let repo = conflict_repo("op-status", b"base", b"ours", b"theirs");
        let status = operation_status(repo.path()).unwrap();
        assert_eq!(status.kind, "merge");
        assert!(!status.can_skip, "merge has no --skip");
        assert_eq!(status.conflicts.len(), 1);
        assert_eq!(status.conflicts[0].path, "f.txt");
        assert_eq!(status.conflicts[0].kind, "text");
    }

    #[test]
    fn operation_status_clean_repo_reports_none() {
        let repo = TempRepo::new("op-clean");
        repo.init();
        std::fs::write(repo.0.join("a.txt"), b"hi\n").unwrap();
        repo.git(&["add", "a.txt"]);
        repo.git(&["commit", "-qm", "init"]);
        let status = operation_status(repo.path()).unwrap();
        assert_eq!(status.kind, "none");
        assert!(status.conflicts.is_empty());
    }

    #[test]
    fn conflict_file_returns_text_with_markers() {
        let repo = conflict_repo("cf-text", b"base", b"ours", b"theirs");
        let content = conflict_file(repo.path(), "f.txt").unwrap();
        assert!(!content.binary);
        assert!(content.content.contains("<<<<<<<"));
        assert!(content.content.contains(">>>>>>>"));
    }

    #[test]
    fn conflict_file_treats_non_utf8_as_binary() {
        // A conflicted file whose bytes aren't valid UTF-8 (but contain no NUL,
        // so git still line-merges it) must come back as binary with empty
        // content — lossy-decoding would corrupt it on write-back.
        let repo = conflict_repo("cf-latin1", b"base \xff\xfe", b"ours \xff\xfe", b"theirs \xff\xfe");
        // Sanity: git left a real conflict on a non-UTF-8 file.
        let content = conflict_file(repo.path(), "f.txt").unwrap();
        assert!(content.binary, "non-UTF-8 conflict should classify as binary");
        assert!(content.content.is_empty());
    }
}
