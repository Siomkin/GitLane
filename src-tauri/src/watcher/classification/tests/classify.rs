//! Which refresh a path set asks for: worktree, graph, or the conservative
//! full re-sync an ambiguous or empty one forces.

use super::super::*;
use super::support::*;
use crate::watcher::WatchRoots;
use std::path::Path;

#[test]
fn refs_head_and_unknown_git_metadata_request_full_refresh() {
    let roots = WatchRoots::plain("/repo");
    for path in [
        "/repo/.git/HEAD",
        "/repo/.git/refs/heads/main",
        "/repo/.git/packed-refs",
        "/repo/.git/objects/ab/cdef",
    ] {
        assert_eq!(
            classify_paths(&roots, &paths(&[path]), none_ignored),
            PathImpact::Graph,
            "{path}"
        );
    }
}

/// The index sorts by raw path bytes, so `dir.txt` sits between `dir` and
/// `dir/…`. The descendant probe must not mistake such a neighbour for a
/// tracked child, and must still find a real one.
#[test]
fn descendant_probe_is_not_fooled_by_byte_order_neighbours() {
    let dir = std::env::temp_dir().join(format!("gitlane-watch-probe-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("dir")).expect("create dirs");
    let repo = git2::Repository::init(&dir).expect("init repo");
    std::fs::write(dir.join("dir.txt"), "neighbour").expect("write neighbour");
    std::fs::write(dir.join("dir/keep"), "child").expect("write child");

    let mut index = repo.index().expect("index");
    index.add_path(Path::new("dir.txt")).expect("add neighbour");
    assert!(index_has_path_or_descendant(&index, "dir.txt"));
    assert!(
        !index_has_path_or_descendant(&index, "dir"),
        "a byte-order neighbour is not a descendant"
    );
    assert!(!index_has_path_or_descendant(&index, "di"));

    index.add_path(Path::new("dir/keep")).expect("add child");
    assert!(index_has_path_or_descendant(&index, "dir"));
    assert!(index_has_path_or_descendant(&index, "dir/keep"));
    assert!(!index_has_path_or_descendant(&index, "dir/k"));

    drop(index);
    drop(repo);
    let _ = std::fs::remove_dir_all(&dir);
}
