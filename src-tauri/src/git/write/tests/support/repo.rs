//! The temporary repository every write-path test builds on: creating one,
//! running git in it, and the small reads the assertions use.

use super::*;

/// A throwaway temp directory that cleans itself up on drop — keeps the test
/// dependency-free (no `tempfile` dev-dep) while never leaking dirs.
pub(in crate::git::write::tests) struct TempRepo(pub(in crate::git::write::tests) PathBuf);

impl TempRepo {
    pub(in crate::git::write::tests) fn new(tag: &str) -> Self {
        static SEQ: AtomicU32 = AtomicU32::new(0);
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("gitlane-{tag}-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        TempRepo(dir)
    }
    pub(in crate::git::write::tests) fn path(&self) -> &str {
        self.0.to_str().unwrap()
    }
    pub(in crate::git::write::tests) fn git(&self, args: &[&str]) -> std::process::Output {
        Command::new("git")
            .arg("-C")
            .arg(&self.0)
            .args(args)
            .output()
            .expect("git launches in tests")
    }
    pub(in crate::git::write::tests) fn git_ok(&self, args: &[&str]) {
        let out = self.git(args);
        assert!(
            out.status.success(),
            "git {:?} failed\nstdout:\n{}\nstderr:\n{}",
            args,
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr),
        );
    }
}

impl Drop for TempRepo {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub(in crate::git::write::tests) fn rev_parse(repo: &TempRepo, rev: &str) -> String {
    let out = repo.git(&["rev-parse", rev]);
    assert!(out.status.success(), "rev-parse {rev} should resolve");
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

pub(in crate::git::write::tests) fn git_at(
    dir: &std::path::Path,
    args: &[&str],
) -> std::process::Output {
    Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .expect("git launches in tests")
}

pub(in crate::git::write::tests) fn git_ok_at(dir: &std::path::Path, args: &[&str]) {
    let out = git_at(dir, args);
    assert!(
        out.status.success(),
        "git {:?} failed\nstderr:\n{}",
        args,
        String::from_utf8_lossy(&out.stderr),
    );
}

/// A repo with one commit on `main` and a configured (but offline) origin.
/// `git config` here keeps commits unsigned so CI without a signing key works.
pub(in crate::git::write::tests) fn repo_with_base_commit(tag: &str) -> (TempRepo, String) {
    let repo = TempRepo::new(tag);
    repo.git(&["init", "-q", "-b", "main"]);
    repo.git(&["config", "user.email", "t@t.t"]);
    repo.git(&["config", "user.name", "T"]);
    repo.git(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("f.txt"), b"base\n").unwrap();
    repo.git(&["add", "f.txt"]);
    repo.git(&["commit", "-qm", "base"]);
    repo.git(&["remote", "add", "origin", "https://example.test/r.git"]);
    let head = String::from_utf8(repo.git(&["rev-parse", "HEAD"]).stdout).unwrap();
    (repo, head.trim().to_string())
}

/// Index entries (`git ls-files`) as owned lines, for asserting what is staged.
pub(in crate::git::write::tests) fn index_entries(repo: &TempRepo) -> Vec<String> {
    let out = repo.git(&["ls-files"]);
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::to_string)
        .collect()
}

/// Path compare that survives macOS `/var` → `/private/var` canonicalization.
pub(in crate::git::write::tests) fn same_path(a: &str, b: &str) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => a.trim_end_matches('/') == b.trim_end_matches('/'),
    }
}

/// A minimal committed repo with one text file, for the file-editor writes.
pub(in crate::git::write::tests) fn repo_with_file(
    tag: &str,
    name: &str,
    contents: &[u8],
) -> TempRepo {
    let repo = TempRepo::new(tag);
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join(name), contents).unwrap();
    repo.git_ok(&["add", name]);
    repo.git_ok(&["commit", "-q", "-m", "seed"]);
    repo
}
