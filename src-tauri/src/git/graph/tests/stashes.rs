//! Where a stash lands: the lane it reserves against its base, how a shared
//! timestamp is ordered, and not injecting one the walk already emitted.

use super::support::*;

/// An in-window stash is injected as a node that reserves its own lane: a
/// concurrent branch commit rendered between the stash and its base is pushed
/// off the stash's lane, and the stash carries a dashed edge to the base.
#[test]
fn in_window_stash_reserves_a_lane_to_its_base() {
    let dir = std::env::temp_dir().join("gitlane-stash-lane-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let mut repo = Repository::init(&dir).unwrap();

    let c1 = commit_on(&repo, &dir, "HEAD", "a.txt", "v1\n", &[], 100);
    let base = commit_on(&repo, &dir, "HEAD", "a.txt", "v2\n", &[c1], 200);
    // A concurrent branch tip whose time (220) lands between the base (200)
    // and the stash (250), so it shares the stash's vertical span.
    let b1 = commit_on(&repo, &dir, "refs/heads/b", "a.txt", "vb\n", &[base], 220);

    // Dirty the worktree (HEAD is still `base`) and stash at t=250.
    fs::write(dir.join("a.txt"), "dirty\n").unwrap();
    repo.stash_save2(&sig(250), Some("WIP on master"), None)
        .unwrap();
    // A newer commit on top so history extends above the stash too.
    let _c3 = commit_on(&repo, &dir, "HEAD", "a.txt", "v3\n", &[base], 300);

    let graph = build(&repo, 100).unwrap();

    let stash_node = graph
        .commits
        .iter()
        .find(|node| node.stash.is_some())
        .expect("stash injected as a graph node");
    let stash_ref = stash_node.stash.as_ref().unwrap();
    assert_eq!(stash_ref.index, 0, "most-recent stash is stash@{{0}}");
    assert_eq!(
        stash_node.parents,
        vec![base.to_string()],
        "stash's only layout parent is its base",
    );

    let base_node = graph
        .commits
        .iter()
        .find(|node| node.id == base.to_string())
        .expect("base commit is in the window");
    let b1_node = graph
        .commits
        .iter()
        .find(|node| node.id == b1.to_string())
        .expect("concurrent branch tip is in the window");

    // The reserved lane is held from the stash down to its base: no other node
    // in that span reuses it — in particular the concurrent branch is shoved off.
    assert_ne!(
        b1_node.lane, stash_node.lane,
        "concurrent branch is pushed off the stash's reserved lane",
    );
    for node in &graph.commits {
        if node.row > stash_node.row && node.row < base_node.row {
            assert_ne!(
                node.lane, stash_node.lane,
                "node {} reused the held stash lane",
                node.id,
            );
        }
    }

    // The dashed connector to the base exists as a real edge from the stash row.
    assert!(
        graph
            .edges
            .iter()
            .any(|edge| edge.from_row == stash_node.row && edge.to_row == base_node.row),
        "stash node has an edge to its base",
    );

    let _ = fs::remove_dir_all(&dir);
}

/// A stash whose committer time equals its base's still renders *above* the
/// base (synthetic child before parent), so the reserved lane/edge don't invert.
#[test]
fn stash_sharing_its_base_timestamp_renders_above_the_base() {
    let dir = std::env::temp_dir().join("gitlane-stash-eqts-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let mut repo = Repository::init(&dir).unwrap();

    let c1 = commit_on(&repo, &dir, "HEAD", "a.txt", "v1\n", &[], 100);
    let base = commit_on(&repo, &dir, "HEAD", "a.txt", "v2\n", &[c1], 200);
    fs::write(dir.join("a.txt"), "dirty\n").unwrap();
    // Stash committer time == base committer time (200).
    repo.stash_save2(&sig(200), Some("WIP same second"), None)
        .unwrap();
    let _c3 = commit_on(&repo, &dir, "HEAD", "a.txt", "v3\n", &[base], 300);

    let graph = build(&repo, 100).unwrap();
    let stash_node = graph
        .commits
        .iter()
        .find(|n| n.stash.is_some())
        .expect("stash node");
    let base_node = graph
        .commits
        .iter()
        .find(|n| n.id == base.to_string())
        .expect("base node");

    assert!(
        stash_node.row < base_node.row,
        "stash (row {}) must render above its base (row {})",
        stash_node.row,
        base_node.row,
    );
    assert!(
        graph
            .edges
            .iter()
            .any(|e| e.from_row == stash_node.row && e.to_row == base_node.row),
        "stash edge runs down to the base",
    );

    let _ = fs::remove_dir_all(&dir);
}

/// A stash commit that is itself reachable (HEAD detached at it) is laid out as
/// a normal commit and must NOT also be injected — no duplicate node id.
#[test]
fn stash_already_in_the_walk_is_not_injected_twice() {
    let dir = std::env::temp_dir().join("gitlane-stash-dup-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let mut repo = Repository::init(&dir).unwrap();

    let c1 = commit_on(&repo, &dir, "HEAD", "a.txt", "v1\n", &[], 100);
    let _base = commit_on(&repo, &dir, "HEAD", "a.txt", "v2\n", &[c1], 200);
    fs::write(dir.join("a.txt"), "dirty\n").unwrap();
    repo.stash_save2(&sig(250), Some("WIP detached"), None)
        .unwrap();
    let stash_oid = repo.find_reference("refs/stash").unwrap().target().unwrap();
    // Detach HEAD onto the stash commit so the revwalk sees it as a commit.
    repo.set_head_detached(stash_oid).unwrap();

    let graph = build(&repo, 100).unwrap();
    let with_stash_id = graph
        .commits
        .iter()
        .filter(|n| n.id == stash_oid.to_string())
        .count();
    assert_eq!(
        with_stash_id, 1,
        "the stash commit appears exactly once, not duplicated"
    );
    assert!(
        graph.commits.iter().all(|n| n.stash.is_none()),
        "the reachable stash commit is laid out as a plain commit, not injected",
    );

    let _ = fs::remove_dir_all(&dir);
}
