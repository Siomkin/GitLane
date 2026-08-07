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

// ---- clone (GL-355) ----
//
// `clone` used to take a `tauri::AppHandle`, so no test could call it: the pure
// helpers around it (URL validation, progress parsing, the publish/cancel state
// machine) are covered inline in `lifecycle.rs`, but the function that wires
// them to a real `git clone` was unreachable. With progress behind a sink these
// run the actual subprocess against a local source repo — no network.

use crate::git::transport_auth::TransportCredential;

/// A source repository with one commit, cloneable over a local path.
fn source_repo(tag: &str) -> TempRepo {
    let repo = TempRepo::new(tag);
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.email", "test@example.com"]);
    repo.git_ok(&["config", "user.name", "Test"]);
    std::fs::write(repo.0.join("README.md"), b"hello\n").unwrap();
    repo.git_ok(&["add", "-A"]);
    repo.git_ok(&["commit", "-qm", "seed"]);
    repo
}

#[test]
fn clone_publishes_the_repository_and_reports_progress_from_start_to_finish() {
    let source = source_repo("clone-source");
    let parent = TempRepo::new("clone-dest");
    let dest = parent.0.join("checkout");

    let sink = RecordingSink::default();
    let cloned = clone(
        &sink,
        CloneSlot::default(),
        source.path(),
        dest.to_str().unwrap(),
        &TransportCredential::None,
    )
    .expect("cloning a local repository should succeed");

    assert!(std::path::Path::new(&cloned).join(".git").is_dir());
    assert!(dest.join("README.md").exists());

    let stages = sink.stages();
    // The bar is nudged before git's first percentage and snapped when the
    // publish lands — those two are the frame the parsed phases sit inside.
    assert_eq!(
        stages.first().map(String::as_str),
        Some("Connecting to remote")
    );
    assert_eq!(stages.last().map(String::as_str), Some("Done"));
    let events = sink.events();
    assert_eq!(events.last().map(|p| p.pct), Some(100));
    // Progress never goes backwards — the whole point of blending git's phases
    // onto one bar.
    for pair in events.windows(2) {
        assert!(
            pair[0].pct <= pair[1].pct,
            "progress went backwards: {events:?}"
        );
    }
}

#[test]
fn clone_returns_gits_own_failure_line_for_an_unreachable_source() {
    let parent = TempRepo::new("clone-missing-source");
    let missing = parent.0.join("no-such-repo");
    let dest = parent.0.join("checkout");

    let err = clone(
        &RecordingSink::default(),
        CloneSlot::default(),
        missing.to_str().unwrap(),
        dest.to_str().unwrap(),
        &TransportCredential::None,
    )
    .expect_err("a missing source must fail");

    // The classification the UI keys off comes from git's `fatal:` line, picked
    // out of a stderr stream that also carried the progress ticks.
    assert!(
        err.contains("repository") || err.contains("does not exist"),
        "expected git's own failure line, got: {err}"
    );
    // The private staging sibling is cleaned up; the parent keeps only itself.
    assert!(
        !dest.exists(),
        "a failed clone must not leave the destination behind"
    );
}

#[test]
fn a_cancelled_clone_leaves_nothing_behind_and_refuses_to_publish() {
    let source = source_repo("clone-cancel-source");
    let parent = TempRepo::new("clone-cancel-dest");
    let dest = parent.0.join("checkout");
    let slot = CloneSlot::default();

    // Cancel as soon as the child is parked. The clone may or may not have
    // finished copying by then, but either way it must not publish: the user
    // asked for it to stop.
    let watcher = {
        let slot = slot.clone();
        std::thread::spawn(move || {
            for _ in 0..2000 {
                if cancel_clone(&slot).is_ok() {
                    return true;
                }
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
            false
        })
    };

    let result = clone(
        &RecordingSink::default(),
        slot,
        source.path(),
        dest.to_str().unwrap(),
        &TransportCredential::None,
    );
    let cancelled = watcher.join().expect("watcher thread");

    if cancelled {
        assert!(result.is_err(), "a cancelled clone must not report success");
        assert!(
            !dest.exists(),
            "cancellation must not leave a partial checkout"
        );
    } else {
        // The clone beat the watcher to publication — then it is a normal
        // success, and cancel correctly refused. Either outcome is legal; what
        // must never happen is "cancelled AND published".
        assert!(result.is_ok());
    }
}
