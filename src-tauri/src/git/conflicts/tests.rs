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
#[cfg(unix)]
fn conflicted_symlink_classifies_binary_and_is_not_followed() {
    // A conflicted symlink must NOT be read by following the link (it could
    // point outside the repo). It should classify as binary, and a direct
    // `conflict_file` read must return binary/empty rather than the target.
    use std::os::unix::fs::symlink;
    let repo = TempRepo::new("cf-symlink");
    repo.init();
    symlink("base-target", repo.0.join("link")).unwrap();
    repo.git(&["add", "link"]);
    repo.git(&["commit", "-qm", "base"]);
    repo.git(&["checkout", "-q", "-b", "other"]);
    std::fs::remove_file(repo.0.join("link")).unwrap();
    symlink("/etc/passwd", repo.0.join("link")).unwrap();
    repo.git(&["commit", "-qam", "theirs"]);
    repo.git(&["checkout", "-q", "main"]);
    std::fs::remove_file(repo.0.join("link")).unwrap();
    symlink("ours-target", repo.0.join("link")).unwrap();
    repo.git(&["commit", "-qam", "ours"]);
    let _ = repo.git(&["merge", "other"]);

    let status = operation_status(repo.path()).unwrap();
    let link = status
        .conflicts
        .iter()
        .find(|c| c.path == "link")
        .expect("link conflicted");
    assert_eq!(link.kind, "binary", "symlink conflict must be whole-file");
    // Even called directly, the read must not follow the link to /etc/passwd.
    let content = conflict_file(repo.path(), "link").unwrap();
    assert!(content.binary);
    assert!(content.content.is_empty());
}

#[test]
fn conflict_file_treats_non_utf8_as_binary() {
    // A conflicted file whose bytes aren't valid UTF-8 (but contain no NUL,
    // so git still line-merges it) must come back as binary with empty
    // content — lossy-decoding would corrupt it on write-back.
    let repo = conflict_repo(
        "cf-latin1",
        b"base \xff\xfe",
        b"ours \xff\xfe",
        b"theirs \xff\xfe",
    );
    // Sanity: git left a real conflict on a non-UTF-8 file.
    let content = conflict_file(repo.path(), "f.txt").unwrap();
    assert!(
        content.binary,
        "non-UTF-8 conflict should classify as binary"
    );
    assert!(content.content.is_empty());
}
