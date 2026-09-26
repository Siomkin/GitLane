//! The fixture the lease golden-digest tests pin their bytes against.
//!
//! Every input that reaches a digest is fixed here — file names, content,
//! modes, `core.ignorecase` — so a digest that changes means the encoding
//! changed, not the fixture. The scope (paths, directory identities) is the
//! one thing a temp directory cannot fix; the full-token tests read it back
//! through `discover_scope` and spell the rest of the layout out literally.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU32, Ordering};

use sha2::{Digest, Sha256};

use super::hash_field;

pub(in crate::git::write) struct GoldenRepo(pub(in crate::git::write) PathBuf);

impl GoldenRepo {
    pub(in crate::git::write) fn path(&self) -> &str {
        self.0.to_str().expect("temp path is UTF-8")
    }

    fn git(&self, args: &[&str]) {
        let out = Command::new("git")
            .arg("-C")
            .arg(&self.0)
            .args(args)
            .output()
            .expect("git launches in tests");
        assert!(out.status.success(), "git {args:?} failed: {out:?}");
    }

    fn write(&self, name: &str, content: &[u8]) {
        let path = self.0.join(name);
        std::fs::write(&path, content).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
    }
}

impl Drop for GoldenRepo {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Committed `a.txt`, `b.txt`, `c.txt`; then `a.txt` modified in the worktree,
/// `b.txt` renamed to `d.txt` in the index, and `e.txt` staged as new.
/// No untracked files, so neither lease has a cleanup or obstruction set.
pub(in crate::git::write) fn golden_repo(tag: &str) -> GoldenRepo {
    static SEQ: AtomicU32 = AtomicU32::new(0);
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("gitlane-golden-{tag}-{}-{n}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let repo = GoldenRepo(dir);
    repo.git(&["init", "-q", "-b", "main"]);
    for (key, value) in [
        ("user.name", "T"),
        ("user.email", "t@t.t"),
        ("commit.gpgsign", "false"),
        ("core.ignorecase", "false"),
        ("core.autocrlf", "false"),
        ("core.filemode", "true"),
    ] {
        repo.git(&["config", key, value]);
    }
    repo.write("a.txt", b"one\n");
    repo.write("b.txt", b"bee\n");
    repo.write("c.txt", b"sea\n");
    repo.git(&["add", "a.txt", "b.txt", "c.txt"]);
    repo.git(&["commit", "-qm", "base"]);
    repo.write("a.txt", b"two\n");
    repo.git(&["mv", "b.txt", "d.txt"]);
    repo.write("e.txt", b"new\n");
    repo.git(&["add", "e.txt"]);
    repo
}

/// The porcelain records `git status -z` reports for [`golden_repo`], as the
/// leases hash them (a rename's second path joined by NUL).
pub(in crate::git::write) fn golden_records() -> Vec<Vec<u8>> {
    vec![
        b" M a.txt".to_vec(),
        b"R  d.txt\0b.txt".to_vec(),
        b"A  e.txt".to_vec(),
    ]
}

/// Every path those records name, in byte order.
pub(in crate::git::write) fn golden_paths() -> Vec<Vec<u8>> {
    ["a.txt", "b.txt", "d.txt", "e.txt"]
        .iter()
        .map(|path| path.as_bytes().to_vec())
        .collect()
}

/// The fingerprint encoding of each golden path, spelled out: `a.txt` holds
/// `two\n`, `b.txt` is gone, `d.txt` holds `bee\n`, `e.txt` holds `new\n`.
pub(in crate::git::write) fn hash_golden_leaf(state: &mut Sha256, path: &[u8]) {
    let content: Option<&[u8]> = match path {
        b"a.txt" => Some(b"two\n"),
        b"b.txt" => None,
        b"d.txt" => Some(b"bee\n"),
        b"e.txt" => Some(b"new\n"),
        other => panic!("not a golden path: {other:?}"),
    };
    match content {
        None => state.update([0]),
        Some(bytes) => {
            state.update([1]);
            state.update((bytes.len() as u64).to_le_bytes());
            state.update(0o100644u64.to_le_bytes());
            state.update(Sha256::digest(bytes));
        }
    }
}

/// Hash `Some(value)` / `None` the way both lease headers do.
pub(in crate::git::write) fn hash_optional(state: &mut Sha256, value: Option<&str>) {
    match value {
        Some(value) => {
            state.update([1]);
            hash_field(state, value.as_bytes());
        }
        None => state.update([0]),
    }
}

/// HEAD's branch, commit and tree, read independently of the lease code.
pub(in crate::git::write) fn golden_head(path: &Path) -> (String, String, String) {
    let repository = git2::Repository::open(path).unwrap();
    let head = repository.head().unwrap();
    let commit = head.peel_to_commit().unwrap();
    (
        head.shorthand().unwrap().to_string(),
        commit.id().to_string(),
        commit.tree_id().to_string(),
    )
}
