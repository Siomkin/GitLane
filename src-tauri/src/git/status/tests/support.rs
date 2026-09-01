//! Shared fixtures for the status tests: commit builders over a git2 repo, and
//! the status API + std imports every test module needs.

pub(super) use super::super::advanced::MAX_GITATTRIBUTES_BYTES;
pub(super) use super::super::diff::DIFF_LINE_LIMIT;
pub(super) use super::super::stash::is_stash_oid;
pub(super) use super::super::{
    commit_file_diff, commit_files, compare_file_diff, compare_refs, diff_range_file, file_blame,
    file_diff, file_history, read_binary_blob, selection_diff, selection_diff_file,
    working_changes,
};
pub(super) use git2::{Repository, Signature};
pub(super) use std::fs;
pub(super) use std::path::{Path, PathBuf};
pub(super) use std::process::Command;
pub(super) use std::sync::atomic::{AtomicU32, Ordering};

pub(super) fn commit(repo: &Repository, dir: &Path, name: &str, content: &str) -> git2::Oid {
    fs::write(dir.join(name), content).unwrap();
    let mut index = repo.index().unwrap();
    index.add_path(Path::new(name)).unwrap();
    index.write().unwrap();
    let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
    let sig = Signature::now("Bench", "bench@example.test").unwrap();
    let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    let parents: Vec<&git2::Commit> = parent.iter().collect();
    repo.commit(Some("HEAD"), &sig, &sig, name, &tree, &parents)
        .unwrap()
}

pub(super) fn commit_bytes(repo: &Repository, dir: &Path, name: &str, content: &[u8]) -> git2::Oid {
    fs::write(dir.join(name), content).unwrap();
    let mut index = repo.index().unwrap();
    index.add_path(Path::new(name)).unwrap();
    index.write().unwrap();
    let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
    let sig = Signature::now("Bench", "bench@example.test").unwrap();
    let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    let parents: Vec<&git2::Commit> = parent.iter().collect();
    repo.commit(Some("HEAD"), &sig, &sig, name, &tree, &parents)
        .unwrap()
}

pub(super) fn commit_at(
    repo: &Repository,
    dir: &Path,
    name: &str,
    content: &str,
    secs: i64,
) -> git2::Oid {
    fs::write(dir.join(name), content).unwrap();
    let mut index = repo.index().unwrap();
    index.add_path(Path::new(name)).unwrap();
    index.write().unwrap();
    let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
    let sig = Signature::new("Bench", "bench@example.test", &git2::Time::new(secs, 0)).unwrap();
    let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    let parents: Vec<&git2::Commit> = parent.iter().collect();
    repo.commit(Some("HEAD"), &sig, &sig, name, &tree, &parents)
        .unwrap()
}

pub(super) fn commit_index(repo: &Repository, message: &str) -> git2::Oid {
    let mut index = repo.index().unwrap();
    index.write().unwrap();
    let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
    let sig = Signature::now("Bench", "bench@example.test").unwrap();
    let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    let parents: Vec<&git2::Commit> = parent.iter().collect();
    repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &parents)
        .unwrap()
}

pub(super) fn remove_commit(repo: &Repository, dir: &Path, name: &str) -> git2::Oid {
    fs::remove_file(dir.join(name)).unwrap();
    let mut index = repo.index().unwrap();
    index.remove_path(Path::new(name)).unwrap();
    index.write().unwrap();
    commit_index(repo, &format!("remove {name}"))
}

/// Unique temp dir for git-CLI fixtures (stash inspect/restore).
pub(super) fn git_temp(tag: &str) -> PathBuf {
    static SEQ: AtomicU32 = AtomicU32::new(0);
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("gitlane-{tag}-{}-{n}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

pub(super) fn git_ok(dir: &Path, args: &[&str]) {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .expect("git launches in tests");
    assert!(
        out.status.success(),
        "git {args:?} failed\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr),
    );
}

pub(super) fn git_stdout(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .expect("git launches in tests");
    assert!(out.status.success(), "git {args:?} failed");
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// Empty repo on `main` with local identity and signing off.
pub(super) fn git_init(tag: &str) -> PathBuf {
    let dir = git_temp(tag);
    git_ok(&dir, &["init", "-q", "-b", "main"]);
    git_ok(&dir, &["config", "user.name", "GitLane Test"]);
    git_ok(&dir, &["config", "user.email", "gitlane@example.test"]);
    git_ok(&dir, &["config", "commit.gpgsign", "false"]);
    dir
}
