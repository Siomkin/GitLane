//! Churn inside ignored trees: dropped without fingerprinting or re-arming,
//! but never at the cost of a real change in the same event.

use super::super::*;
use super::support::*;
use crate::watcher::WatchRoots;
use std::cell::Cell;
use std::path::Path;

/// The Windows regression (GL-101): `ReadDirectoryChangesW` reports every
/// file a `cargo build` / `bun install` touches, so churn confined to
/// ignored trees must classify as `Ignored` — not `Worktree` — or each
/// event re-arms the throttle and drives a redundant status re-sync.
#[test]
fn churn_inside_ignored_trees_is_dropped() {
    let roots = WatchRoots::plain("/repo");
    assert_eq!(
        classify_paths(
            &roots,
            &paths(&[
                "/repo/src-tauri/target/debug/incremental/foo.o",
                "/repo/node_modules/react/index.js",
            ]),
            build_dirs_ignored
        ),
        PathImpact::Ignored
    );
}

#[test]
fn ignored_churn_does_not_mask_real_changes_in_the_same_event() {
    let roots = WatchRoots::plain("/repo");
    // A tracked worktree file alongside build churn still refreshes status…
    assert_eq!(
        classify_paths(
            &roots,
            &paths(&["/repo/node_modules/react/index.js", "/repo/src/main.ts"]),
            build_dirs_ignored
        ),
        PathImpact::Worktree
    );
    // …and git metadata alongside build churn still rebuilds the graph.
    assert_eq!(
        classify_paths(
            &roots,
            &paths(&["/repo/src-tauri/target/debug/app", "/repo/.git/HEAD"]),
            build_dirs_ignored
        ),
        PathImpact::Graph
    );
}

#[test]
fn ignored_events_are_suppressed_without_fingerprinting_or_rearming() {
    let calls = Cell::new(0);
    let mut fp = Some(1);
    for throttled in [false, true] {
        assert_eq!(
            decide_emission(
                throttled,
                ChangeKind::Worktree,
                PathImpact::Ignored,
                &mut fp,
                counting(Some(2), &calls),
            ),
            None
        );
    }
    assert_eq!(calls.get(), 0, "ignored churn must never pay the ref hash");
    assert_eq!(fp, Some(1), "ignored churn must not move the baseline");
}

/// `is_ignored` honours the repository's real `.gitignore` (rather than a
/// hardcoded denylist), and fails open when there is no repo to consult.
#[test]
fn ignore_checks_use_the_repositorys_gitignore() {
    let dir = std::env::temp_dir().join(format!("gitlane-watch-ignore-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("create temp dir");
    let repo = git2::Repository::init(&dir).expect("init repo");
    std::fs::write(dir.join(".gitignore"), "target/\nnode_modules/\n").expect("write ignore");

    assert!(is_ignored(Some(&repo), Path::new("target/debug/app.o")));
    assert!(is_ignored(
        Some(&repo),
        Path::new("node_modules/react/index.js")
    ));
    assert!(!is_ignored(Some(&repo), Path::new("src/main.rs")));
    assert!(!is_ignored(Some(&repo), Path::new(".gitignore")));
    // Without a repository the filter fails open: nothing is dropped.
    assert!(!is_ignored(None, Path::new("target/debug/app.o")));

    drop(repo);
    let _ = std::fs::remove_dir_all(&dir);
}

/// `is_path_ignored` is `git check-ignore --no-index` semantics: it flags
/// tracked files too. A force-added (`git add -f`) file under an ignored
/// pattern is still status-affecting, so it — and any directory event
/// naming one of its parents — must fail open rather than be dropped.
#[test]
fn force_added_files_under_ignored_patterns_are_not_dropped() {
    let dir = std::env::temp_dir().join(format!("gitlane-watch-forced-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("target/debug")).expect("create dirs");
    let repo = git2::Repository::init(&dir).expect("init repo");
    std::fs::write(dir.join(".gitignore"), "target/\n").expect("write ignore");
    std::fs::write(dir.join("target/debug/keep.txt"), "pinned").expect("write keep");

    // Before the force-add, the whole tree is droppable churn.
    assert!(is_ignored(Some(&repo), Path::new("target/debug/keep.txt")));

    let mut index = repo.index().expect("index");
    index
        .add_path(Path::new("target/debug/keep.txt"))
        .expect("force-add ignored file");
    index.write().expect("write index");

    // The tracked file itself, and directory-level events (FSEvents) for
    // its parents, all stay relevant…
    assert!(!is_ignored(Some(&repo), Path::new("target/debug/keep.txt")));
    assert!(!is_ignored(Some(&repo), Path::new("target/debug")));
    assert!(!is_ignored(Some(&repo), Path::new("target")));
    // …while untracked churn elsewhere under target/ is still dropped.
    assert!(is_ignored(Some(&repo), Path::new("target/debug/app.o")));
    assert!(is_ignored(Some(&repo), Path::new("target/release")));

    drop(repo);
    let _ = std::fs::remove_dir_all(&dir);
}
