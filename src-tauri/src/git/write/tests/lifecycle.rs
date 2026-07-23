//! `lifecycle` write-path tests.

use super::support::*;

#[test]
fn init_in_place_initializes_a_non_empty_existing_directory() {
    let dir = TempRepo::new("init-in-place");
    std::fs::write(dir.0.join("existing.txt"), b"already here\n").unwrap();

    let result = init_in_place(dir.path()).expect("init_in_place should succeed");

    assert!(same_path(&result, dir.path()));
    assert!(dir.0.join(".git").is_dir());
    // The pre-existing file must survive — this is the whole point of the
    // in-place action over the empty-dir-only `init`.
    assert!(dir.0.join("existing.txt").exists());
}

#[test]
fn init_in_place_rejects_an_already_initialized_directory() {
    let dir = TempRepo::new("init-in-place-existing-repo");
    dir.git_ok(&["init", "-q"]);

    let err = init_in_place(dir.path()).expect_err("already a repo must be rejected");
    assert!(err.contains("already a Git repository"), "{err}");
    assert!(err.contains("try Retry"), "{err}");
}

#[test]
fn init_in_place_repairs_a_broken_or_partial_git_directory() {
    // A stray/interrupted `.git` (e.g. a crashed `git init`, or a folder a
    // backup tool created) satisfies a raw "does .git exist" check but isn't
    // a repo libgit2 can open — exactly the state that produces the
    // `notARepository` classification driving this recovery action. It must
    // not dead-end here (GL-153 review): `git init` repairs it in place.
    let dir = TempRepo::new("init-in-place-broken-git");
    std::fs::create_dir_all(dir.0.join(".git")).unwrap();
    std::fs::write(dir.0.join("existing.txt"), b"already here\n").unwrap();

    let result = init_in_place(dir.path()).expect("a broken .git must be repairable");

    assert!(same_path(&result, dir.path()));
    assert!(
        dir.0.join(".git/HEAD").is_file(),
        "init must have run for real"
    );
    assert!(dir.0.join("existing.txt").exists());
}

#[test]
fn init_in_place_repairs_a_dangling_git_worktree_pointer_file() {
    // A `.git` *file* (a linked worktree's gitdir pointer) left behind after
    // its parent repo/worktree entry is gone: `rev-parse` correctly rejects
    // it, but plain `git init` also refuses to run over a `.git` file at all
    // (unlike the directory case above) — this must not dead-end either.
    let dir = TempRepo::new("init-in-place-dangling-worktree-file");
    std::fs::write(dir.0.join(".git"), b"gitdir: /nonexistent/path/to/gitdir\n").unwrap();
    std::fs::write(dir.0.join("existing.txt"), b"already here\n").unwrap();

    let result = init_in_place(dir.path()).expect("a dangling .git file must be repairable");

    assert!(same_path(&result, dir.path()));
    assert!(
        dir.0.join(".git").is_dir(),
        "the stale .git file must be replaced with a real gitdir"
    );
    assert!(dir.0.join("existing.txt").exists());
}

#[test]
fn init_in_place_rejects_a_nonexistent_path() {
    let dir = TempRepo::new("init-in-place-missing");
    let gone = dir.0.join("does-not-exist");

    let err =
        init_in_place(gone.to_str().unwrap()).expect_err("a nonexistent path must be rejected");
    assert!(err.contains("not a folder"), "{err}");
}

#[test]
fn init_in_place_rejects_dash_prefixed_paths() {
    let err = init_in_place("-D").expect_err("a dash-prefixed path must be rejected");
    assert!(err.contains("Refusing unsafe git argument"), "{err}");
}

#[test]
fn init_in_place_initializes_the_exact_directory_without_trimming_whitespace() {
    // The path comes from repo state and must be treated as opaque — trimming
    // would point `git init` at a different sibling if both exist.
    let base = std::env::temp_dir().join(format!("gitlane-init-ws-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let dir_with_space = base.join("repo ");
    std::fs::create_dir_all(&dir_with_space).unwrap();
    let trimmed_sibling = base.join("repo");
    std::fs::create_dir_all(&trimmed_sibling).unwrap();
    std::fs::write(trimmed_sibling.join("wrong.txt"), b"wrong\n").unwrap();

    let path = dir_with_space.to_string_lossy().to_string();
    let result = init_in_place(&path).expect("init must target the exact path");

    assert!(same_path(&result, &path));
    assert!(
        dir_with_space.join(".git").is_dir(),
        "the spaced directory must be initialized"
    );
    assert!(
        !trimmed_sibling.join(".git").exists(),
        "the trimmed sibling must not be touched"
    );
    assert!(trimmed_sibling.join("wrong.txt").exists());

    let _ = std::fs::remove_dir_all(&base);
}
