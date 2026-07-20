use super::{build, build_profiled};
use git2::{ObjectType, Oid, Repository, Signature, Time};
use std::env;
use std::fs;
use std::path::Path;
use std::time::{Duration, Instant};

fn sig(seconds: i64) -> Signature<'static> {
    Signature::new("Bench", "bench@example.test", &Time::new(seconds, 0)).unwrap()
}

fn commit_on(
    repo: &Repository,
    dir: &Path,
    reference: &str,
    name: &str,
    content: &str,
    parents: &[Oid],
    seconds: i64,
) -> Oid {
    fs::write(dir.join(name), content).unwrap();
    let mut index = repo.index().unwrap();
    index.add_path(Path::new(name)).unwrap();
    index.write().unwrap();
    let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
    let parent_commits: Vec<git2::Commit> = parents
        .iter()
        .map(|p| repo.find_commit(*p).unwrap())
        .collect();
    let parent_refs: Vec<&git2::Commit> = parent_commits.iter().collect();
    let signature = sig(seconds);
    repo.commit(
        Some(reference),
        &signature,
        &signature,
        name,
        &tree,
        &parent_refs,
    )
    .unwrap()
}

#[test]
fn fetched_tag_ref_labels_the_visible_commit() {
    let dir = std::env::temp_dir().join("gitlane-tag-ref-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();

    let tagged = commit_on(&repo, &dir, "HEAD", "a.txt", "v1\n", &[], 100);
    repo.reference("refs/tags/0.1.1", tagged, true, "test tag")
        .unwrap();

    let graph = build(&repo, 100).unwrap();
    let tagged_node = graph
        .commits
        .iter()
        .find(|node| node.id == tagged.to_string())
        .expect("tagged commit is in the graph");

    assert!(
        tagged_node
            .refs
            .iter()
            .any(|r| r.kind == "tag" && r.name == "0.1.1"),
        "fetched local tag should be exposed as a tag ref",
    );

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn annotated_tag_only_commit_is_included_in_the_graph() {
    let dir = std::env::temp_dir().join("gitlane-tag-only-commit-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();

    let base = commit_on(&repo, &dir, "HEAD", "a.txt", "v1\n", &[], 100);
    let tagged = commit_on(
        &repo,
        &dir,
        "refs/heads/release-only",
        "a.txt",
        "release\n",
        &[base],
        200,
    );
    let object = repo
        .find_object(tagged, Some(ObjectType::Commit))
        .expect("tagged commit object");
    repo.tag("v0.1.1", &object, &sig(210), "release tag", false)
        .unwrap();
    repo.find_reference("refs/heads/release-only")
        .unwrap()
        .delete()
        .unwrap();

    let graph = build(&repo, 100).unwrap();
    let tagged_node = graph
        .commits
        .iter()
        .find(|node| node.id == tagged.to_string())
        .expect("tag-only commit is seeded into the graph");

    assert!(
        tagged_node
            .refs
            .iter()
            .any(|r| r.kind == "tag" && r.name == "v0.1.1"),
        "annotated tag should label the tag-only commit",
    );

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn detached_worktree_only_commit_is_included_in_the_graph() {
    // A detached worktree can park on a commit no ref reaches any more (its
    // branch was rebased away/deleted). That worktree HEAD must seed the walk,
    // or the commit never enters the graph — no worktree pill, and navigating
    // to it pages through all of history and gives up.
    let dir = std::env::temp_dir().join("gitlane-wt-only-commit-test");
    let wt_dir = std::env::temp_dir().join("gitlane-wt-only-commit-wt");
    let _ = fs::remove_dir_all(&dir);
    let _ = fs::remove_dir_all(&wt_dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();

    let base = commit_on(&repo, &dir, "HEAD", "a.txt", "v1\n", &[], 100);
    let stranded = commit_on(
        &repo,
        &dir,
        "refs/heads/temp",
        "a.txt",
        "wt\n",
        &[base],
        200,
    );

    // Check the temp branch out in a linked worktree, then detach that
    // worktree at the commit and drop the branch — the worktree HEAD is now
    // the only thing keeping `stranded` reachable.
    let temp_ref = repo.find_reference("refs/heads/temp").unwrap();
    let mut opts = git2::WorktreeAddOptions::new();
    opts.reference(Some(&temp_ref));
    repo.worktree("wt-only", &wt_dir, Some(&opts)).unwrap();
    fs::write(
        dir.join(".git/worktrees/wt-only/HEAD"),
        format!("{stranded}\n"),
    )
    .unwrap();
    repo.find_reference("refs/heads/temp")
        .unwrap()
        .delete()
        .unwrap();

    let graph = build(&repo, 100).unwrap();
    assert!(
        graph.commits.iter().any(|c| c.id == stranded.to_string()),
        "detached worktree HEAD should seed its commit into the graph",
    );

    let _ = fs::remove_dir_all(&dir);
    let _ = fs::remove_dir_all(&wt_dir);
}

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

#[test]
fn checked_out_head_ancestor_stays_on_wip_mainline() {
    let dir = std::env::temp_dir().join("gitlane-head-lane-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();

    let c1 = commit_on(&repo, &dir, "HEAD", "a.txt", "v1\n", &[], 100);
    let c2 = commit_on(&repo, &dir, "HEAD", "a.txt", "v2\n", &[c1], 200);
    let feature = commit_on(
        &repo,
        &dir,
        "refs/heads/feature",
        "a.txt",
        "feature\n",
        &[c2],
        300,
    );
    let merge = commit_on(
        &repo,
        &dir,
        "refs/heads/staging",
        "a.txt",
        "merge\n",
        &[c2, feature],
        400,
    );
    let _staging_tip = commit_on(
        &repo,
        &dir,
        "refs/heads/staging",
        "a.txt",
        "staging\n",
        &[merge],
        500,
    );
    repo.set_head("refs/heads/feature").unwrap();

    let graph = build(&repo, 100).unwrap();
    let head_node = graph
        .commits
        .iter()
        .find(|node| node.id == feature.to_string())
        .expect("feature HEAD is in the graph");
    let merge_node = graph
        .commits
        .iter()
        .find(|node| node.id == merge.to_string())
        .expect("staging merge is in the graph");
    let base_node = graph
        .commits
        .iter()
        .find(|node| node.id == c2.to_string())
        .expect("shared base is in the graph");

    assert_eq!(graph.head.as_deref(), Some(feature.to_string().as_str()));
    assert_eq!(
        graph.wip_lane,
        Some(head_node.lane),
        "WIP continues the checked-out HEAD mainline",
    );
    assert!(
        merge_node.lane > head_node.lane,
        "newer first-parent staging lane goes right of the checked-out mainline",
    );
    assert_eq!(
        base_node.lane, merge_node.lane,
        "checked-out branch hands off to the already-open staging first-parent lane below HEAD",
    );
    assert!(
        graph.edges.iter().any(|edge| {
            edge.from_row == merge_node.row
                && edge.to_row == head_node.row
                && edge.parent_index == 1
        }),
        "the merge reaches the checked-out branch as a second-parent edge",
    );
    assert!(
        head_node
            .refs
            .iter()
            .any(|r| r.kind == "head" && r.name == "feature"),
        "the checked-out branch still labels the real HEAD commit",
    );

    let _ = fs::remove_dir_all(&dir);
}

#[test]
#[ignore = "run explicitly against a generated fixture in release mode"]
fn benchmark_fixture() {
    let path = env::var("GITLANE_BENCH_REPO")
        .expect("set GITLANE_BENCH_REPO to a generated benchmark repository");
    let limit = env::var("GITLANE_BENCH_LIMIT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(10_000);
    let iterations = env::var("GITLANE_BENCH_ITERATIONS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(5);
    let repo = Repository::discover(&path).expect("open benchmark repository");

    let mut refs = Duration::ZERO;
    let mut revwalk = Duration::ZERO;
    let mut layout = Duration::ZERO;
    let mut edges = Duration::ZERO;
    let mut total = Duration::ZERO;
    let mut serialization = Duration::ZERO;
    let mut payload_bytes = 0usize;
    let mut commits = 0usize;
    let mut lanes = 0usize;

    for _ in 0..iterations {
        let (graph, metrics) = build_profiled(&repo, limit).expect("build graph");
        let serialize_started = Instant::now();
        let payload = serde_json::to_vec(&graph).expect("serialize graph");
        serialization += serialize_started.elapsed();
        payload_bytes = payload.len();
        commits = graph.commits.len();
        lanes = graph.lane_count;
        refs += metrics.refs;
        revwalk += metrics.revwalk;
        layout += metrics.layout;
        edges += metrics.edges;
        total += metrics.total;
    }

    let average_ms = |duration: Duration| duration.as_secs_f64() * 1_000.0 / iterations as f64;
    println!(
        "GITLANE_GRAPH_BENCH {}",
        serde_json::json!({
            "path": path,
            "limit": limit,
            "iterations": iterations,
            "commits": commits,
            "lanes": lanes,
            "payloadBytes": payload_bytes,
            "averageMs": {
                "refs": average_ms(refs),
                "revwalk": average_ms(revwalk),
                "layout": average_ms(layout),
                "edges": average_ms(edges),
                "graphTotal": average_ms(total),
                "serialization": average_ms(serialization),
            }
        })
    );
}

#[test]
fn head_handoff_does_not_lend_its_lane_to_a_sibling_branch() {
    // Regression: the checked-out branch hands its first parent off to the lane
    // already awaiting it, but its own connector is still drawn straight down its
    // column. Releasing that column let the next branch root allocate it, so the
    // connector ran through an unrelated branch's commits and the graph read as
    // though HEAD descended from that branch instead of from trunk.
    let dir = std::env::temp_dir().join("gitlane-head-handoff-lane-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();

    let root = commit_on(&repo, &dir, "refs/heads/trunk", "m.txt", "0\n", &[], 1000);
    let base = commit_on(
        &repo,
        &dir,
        "refs/heads/trunk",
        "m.txt",
        "1\n",
        &[root],
        1100,
    );

    // A sibling topic branch off `base`, older than HEAD so it renders *below* it.
    let mut sibling = base;
    let mut sibling_oids = Vec::new();
    for i in 0..4 {
        sibling = commit_on(
            &repo,
            &dir,
            "refs/heads/sibling",
            "a.txt",
            &format!("{i}\n"),
            &[sibling],
            1200 + i,
        );
        sibling_oids.push(sibling);
    }

    // The checked-out branch: a single commit off the same `base`.
    let head = commit_on(
        &repo,
        &dir,
        "refs/heads/checked-out",
        "b.txt",
        "x\n",
        &[base],
        1300,
    );

    // A third branch off `base`, newest — it renders above HEAD and is what opens
    // the lane that already awaits `base`, triggering the hand-off.
    let mut newest = base;
    for i in 0..3 {
        newest = commit_on(
            &repo,
            &dir,
            "refs/heads/newest",
            "c.txt",
            &format!("{i}\n"),
            &[newest],
            1400 + i,
        );
    }
    repo.set_head("refs/heads/checked-out").unwrap();

    let graph = build(&repo, 100).unwrap();
    let node = |oid: Oid| {
        graph
            .commits
            .iter()
            .find(|c| c.id == oid.to_string())
            .unwrap_or_else(|| panic!("{oid} is in the graph"))
    };
    let head_node = node(head);
    let base_node = node(base);
    let sibling_nodes: Vec<_> = sibling_oids.iter().map(|&oid| node(oid)).collect();

    assert_eq!(
        graph.wip_lane,
        Some(head_node.lane),
        "WIP still continues the checked-out HEAD mainline",
    );
    assert_ne!(
        base_node.lane, head_node.lane,
        "the hand-off still lets the shared base render in the already-open lane",
    );

    // The connector runs down HEAD's lane from HEAD's row to the base's row, so
    // no other commit may occupy that lane in between.
    let trespassers: Vec<_> = graph
        .commits
        .iter()
        .filter(|c| c.lane == head_node.lane && c.row > head_node.row && c.row <= base_node.row)
        .map(|c| (c.row, c.summary.clone()))
        .collect();
    assert!(
        trespassers.is_empty(),
        "HEAD's lane must stay blocked until its parent renders, found {trespassers:?}",
    );
    assert!(
        sibling_nodes.iter().all(|c| c.lane != head_node.lane),
        "the sibling branch must not be allocated HEAD's in-flight lane",
    );

    let _ = fs::remove_dir_all(&dir);
}
