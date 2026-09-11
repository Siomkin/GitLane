//! Lane assignment around HEAD: keeping the checked-out ancestor on the WIP
//! mainline, and not lending or retargeting a blocked lane.

use super::support::*;

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

#[test]
fn blocked_head_lane_does_not_retarget_an_existing_merge_connector_through_a_later_tip() {
    let dir = std::env::temp_dir().join("gitlane-blocked-head-cross-connector-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();

    let a = commit_on(&repo, &dir, "refs/heads/e", "A.txt", "A\n", &[], 1000);
    let b = commit_on(&repo, &dir, "refs/heads/c-temp", "B.txt", "B\n", &[], 900);
    let d = commit_on(&repo, &dir, "refs/heads/e", "D.txt", "D\n", &[a], 1500);
    let c = commit_on(
        &repo,
        &dir,
        "refs/heads/c-temp",
        "C.txt",
        "C\n",
        &[b, a],
        1400,
    );
    let _e = commit_on(&repo, &dir, "refs/heads/e", "E.txt", "E\n", &[d], 1700);
    let h = commit_on(
        &repo,
        &dir,
        "refs/heads/checked-out",
        "H.txt",
        "H\n",
        &[d, c],
        1600,
    );
    let f = commit_on(&repo, &dir, "refs/heads/f", "F.txt", "F\n", &[a], 1300);
    repo.find_reference("refs/heads/c-temp")
        .unwrap()
        .delete()
        .unwrap();
    repo.set_head("refs/heads/checked-out").unwrap();

    let graph = build(&repo, 100).unwrap();
    let summaries: Vec<_> = graph
        .commits
        .iter()
        .map(|node| node.summary.as_str())
        .collect();
    assert_eq!(
        summaries,
        vec!["E.txt", "H.txt", "D.txt", "C.txt", "F.txt", "A.txt", "B.txt"]
    );

    let node = |oid: Oid| {
        graph
            .commits
            .iter()
            .find(|candidate| candidate.id == oid.to_string())
            .unwrap()
    };
    let h_node = node(h);
    let c_node = node(c);
    let f_node = node(f);
    let a_node = node(a);
    let edge = graph
        .edges
        .iter()
        .find(|edge| {
            edge.from_row == c_node.row && edge.to_row == a_node.row && edge.parent_index == 1
        })
        .expect("C has its second-parent connector to A");

    assert!(h_node.row < c_node.row);
    assert!(c_node.row < f_node.row && f_node.row < a_node.row);
    assert_ne!(
        f_node.lane, edge.to_lane,
        "C's merge connector to A must not run vertically through unrelated F"
    );

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn merge_connector_does_not_run_through_a_branch_stacked_on_head() {
    // The checked-out branch is merged into trunk *and* carries a further branch
    // stacked on its tip. Both a branch-root lane (the merge's second parent) and
    // a first-parent continuation lane (the stacked branch) await HEAD; the
    // branch-root lane must win, or the merge's connector is drawn down the
    // stacked branch's column and reads as if the merge absorbed that branch.
    let dir = std::env::temp_dir().join("gitlane-head-stacked-branch-lane-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();

    let base = commit_on(&repo, &dir, "refs/heads/trunk", "t.txt", "0\n", &[], 1000);
    // An intermediate commit between HEAD and the trunk base, as in the reported
    // repository — it keeps HEAD's own first-parent hand-off from applying.
    let mid = commit_on(
        &repo,
        &dir,
        "refs/heads/feature",
        "m.txt",
        "mid\n",
        &[base],
        1100,
    );
    let head = commit_on(
        &repo,
        &dir,
        "refs/heads/feature",
        "f.txt",
        "feature\n",
        &[mid],
        1200,
    );
    let stacked_first = commit_on(
        &repo,
        &dir,
        "refs/heads/stacked",
        "s.txt",
        "s1\n",
        &[head],
        1300,
    );
    let stacked_tip = commit_on(
        &repo,
        &dir,
        "refs/heads/stacked",
        "s.txt",
        "s2\n",
        &[stacked_first],
        1400,
    );
    let merge = commit_on(
        &repo,
        &dir,
        "refs/heads/trunk",
        "t.txt",
        "merge\n",
        &[base, head],
        1500,
    );
    repo.set_head("refs/heads/feature").unwrap();

    let graph = build(&repo, 100).unwrap();
    let node = |oid: Oid| {
        graph
            .commits
            .iter()
            .find(|c| c.id == oid.to_string())
            .unwrap_or_else(|| panic!("{oid} is in the graph"))
    };
    let head_node = node(head);
    let merge_node = node(merge);

    assert_eq!(
        graph.wip_lane,
        Some(head_node.lane),
        "WIP still continues the checked-out HEAD lane",
    );
    assert!(
        merge_node.lane > head_node.lane,
        "the trunk merge stays right of the checked-out lane",
    );
    assert!(
        merge_node.row < head_node.row,
        "the merge renders above the commit it merged",
    );
    // The merge's second-parent connector runs straight down HEAD's lane from the
    // merge row to HEAD's row; nothing else may render in that stretch.
    let trespassers: Vec<&str> = graph
        .commits
        .iter()
        .filter(|c| c.lane == head_node.lane && c.row > merge_node.row && c.row < head_node.row)
        .map(|c| c.summary.as_str())
        .collect();
    assert!(
        trespassers.is_empty(),
        "the merge connector to HEAD must not cross other commits, found {trespassers:?}",
    );
    for oid in [stacked_first, stacked_tip] {
        assert_ne!(
            node(oid).lane,
            head_node.lane,
            "the branch stacked on HEAD keeps its own column",
        );
    }

    let _ = fs::remove_dir_all(&dir);
}
