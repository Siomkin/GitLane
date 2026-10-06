//! Multi-commit selection diffs: how overlapping edits net out, how the union
//! is ordered, and when a gapped selection fails closed (GL-69).

use super::support::*;
use crate::git::types::ChangeStatus;

#[test]
fn selection_diff_nets_add_then_delete_to_nothing() {
    let dir = std::env::temp_dir().join("gitlane-selection-add-del-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();
    commit(&repo, &dir, "seed.txt", "seed\n");
    let add = commit(&repo, &dir, "temp.txt", "scratch\n").to_string();
    let del = remove_commit(&repo, &dir, "temp.txt").to_string();
    let path = dir.to_str().unwrap();

    // Added then deleted within the selection → the file drops out entirely.
    let files = selection_diff(path, &[add, del]).unwrap();
    assert!(
        files.iter().all(|f| f.path != "temp.txt"),
        "temp.txt should net to no change: {:?}",
        files.iter().map(|f| &f.path).collect::<Vec<_>>()
    );

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn selection_diff_nets_add_then_modify_to_add() {
    let dir = std::env::temp_dir().join("gitlane-selection-add-mod-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();
    commit(&repo, &dir, "seed.txt", "seed\n");
    let add = commit(&repo, &dir, "f.txt", "one\n").to_string();
    let modify = commit(&repo, &dir, "f.txt", "one\ntwo\n").to_string();
    let path = dir.to_str().unwrap();
    let oids = [add, modify];

    // The earliest touch added the file, so the net status is "A" with the final
    // content — not "M".
    let files = selection_diff(path, &oids).unwrap();
    let entry = files.iter().find(|f| f.path == "f.txt").unwrap();
    assert_eq!(entry.status, ChangeStatus::Added);

    let diff = selection_diff_file(path, &oids, "f.txt", false).unwrap();
    assert_eq!(diff.status, ChangeStatus::Added);
    let adds: Vec<&str> = diff
        .hunks
        .iter()
        .flat_map(|h| &h.lines)
        .filter(|l| l.kind == "add")
        .map(|l| l.content.as_str())
        .collect();
    assert_eq!(adds, vec!["one", "two"]);

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn selection_diff_nets_modify_then_delete_to_delete() {
    let dir = std::env::temp_dir().join("gitlane-selection-mod-del-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();
    commit(&repo, &dir, "g.txt", "a\nb\n");
    let modify = commit(&repo, &dir, "g.txt", "a\nB\n").to_string();
    let del = remove_commit(&repo, &dir, "g.txt").to_string();
    let path = dir.to_str().unwrap();

    // Net from the pre-selection state ("a\nb\n") to absent → a deletion.
    let files = selection_diff(path, &[modify, del]).unwrap();
    let entry = files.iter().find(|f| f.path == "g.txt").unwrap();
    assert_eq!(entry.status, ChangeStatus::Deleted);

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn selection_diff_unions_disjoint_commits_excluding_unselected() {
    let dir = std::env::temp_dir().join("gitlane-selection-disjoint-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();
    commit(&repo, &dir, "seed.txt", "seed\n");
    let a = commit(&repo, &dir, "fa.txt", "a\n").to_string();
    // fb.txt is committed *between* the two picks but left unselected.
    commit(&repo, &dir, "fb.txt", "b\n");
    let c = commit(&repo, &dir, "fc.txt", "c\n").to_string();
    let path = dir.to_str().unwrap();

    let files = selection_diff(path, &[a, c]).unwrap();
    let names: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
    assert!(names.contains(&"fa.txt"));
    assert!(names.contains(&"fc.txt"));
    assert!(
        !names.contains(&"fb.txt"),
        "unselected commit must not leak in: {names:?}"
    );

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn selection_diff_excludes_unselected_edits_to_a_shared_file() {
    // The "sandwiched" case: selected A and C both edit f.txt, and an *unselected*
    // commit B edits it in between. The merged diff must reflect only A's and C's
    // edits — B's change must not leak in.
    let dir = std::env::temp_dir().join("gitlane-selection-gap-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();
    commit(&repo, &dir, "f.txt", "1\n2\n3\n4\n5\n"); // base (parent of A)
    let a = commit(&repo, &dir, "f.txt", "A\n2\n3\n4\n5\n").to_string(); // selected: line 1
    commit(&repo, &dir, "f.txt", "A\n2\nB\n4\n5\n"); // UNSELECTED: line 3
    let c = commit(&repo, &dir, "f.txt", "A\n2\nB\n4\nC\n").to_string(); // selected: line 5
    let path = dir.to_str().unwrap();
    let oids = [a, c];

    let diff = selection_diff_file(path, &oids, "f.txt", false).unwrap();
    assert_eq!(diff.status, ChangeStatus::Modified);
    let lines: Vec<(&str, &str)> = diff
        .hunks
        .iter()
        .flat_map(|h| &h.lines)
        .map(|l| (l.kind.as_str(), l.content.as_str()))
        .collect();
    // The selected edits are present...
    assert!(lines.contains(&("add", "A")), "missing A edit: {lines:?}");
    assert!(lines.contains(&("add", "C")), "missing C edit: {lines:?}");
    assert!(lines.contains(&("del", "1")));
    assert!(lines.contains(&("del", "5")));
    // ...and the unselected commit's edit (line 3 → "B") never appears.
    assert!(
        !lines.iter().any(|(_, c)| *c == "B"),
        "unselected edit leaked: {lines:?}"
    );
    assert!(
        !lines.contains(&("del", "3")),
        "line 3 was wrongly changed: {lines:?}"
    );

    // The file list agrees on the net status.
    let files = selection_diff(path, &oids).unwrap();
    assert_eq!(
        files.iter().find(|f| f.path == "f.txt").unwrap().status,
        ChangeStatus::Modified
    );

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn selection_diff_orders_by_ancestry_not_timestamp() {
    // Skewed history: the parent commit A has a LATER timestamp than its child B
    // (e.g. after a rebase). Timestamp order would put B before A and mis-derive
    // the base; ancestry order must keep A→B so the net is "1\n" → "1\n2\n3\n".
    let dir = std::env::temp_dir().join("gitlane-selection-skew-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();
    commit_at(&repo, &dir, "f.txt", "1\n", 1000); // base (parent of A)
    let a = commit_at(&repo, &dir, "f.txt", "1\n2\n", 3000).to_string(); // adds "2", LATER time
    let b = commit_at(&repo, &dir, "f.txt", "1\n2\n3\n", 1500).to_string(); // child of A, EARLIER time
    let path = dir.to_str().unwrap();

    let diff = selection_diff_file(path, &[a, b], "f.txt", false).unwrap();
    assert_eq!(diff.status, ChangeStatus::Modified);
    let adds: Vec<&str> = diff
        .hunks
        .iter()
        .flat_map(|h| &h.lines)
        .filter(|l| l.kind == "add")
        .map(|l| l.content.as_str())
        .collect();
    assert!(
        adds.contains(&"2"),
        "missing +2 (wrong base from timestamp order?): {adds:?}"
    );
    assert!(adds.contains(&"3"), "missing +3: {adds:?}");
    let dels: Vec<&str> = diff
        .hunks
        .iter()
        .flat_map(|h| &h.lines)
        .filter(|l| l.kind == "del")
        .map(|l| l.content.as_str())
        .collect();
    assert!(
        dels.is_empty(),
        "spurious deletions (wrong base?): {dels:?}"
    );

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn selection_diff_gapped_uncomposable_file_fails_closed() {
    // A gapped chain that can't compose (binary blobs) must NOT show a blob-range
    // diff (which would include the intervening unselected edit). The file still
    // appears in the list, but its per-file merged diff fails closed.
    let dir = std::env::temp_dir().join("gitlane-selection-gap-binary-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();
    commit_bytes(&repo, &dir, "img.bin", &[0u8, 1, 2, 0]); // base (parent of A)
    let a = commit_bytes(&repo, &dir, "img.bin", &[0u8, 2, 2, 0]).to_string(); // selected
    commit_bytes(&repo, &dir, "img.bin", &[0u8, 3, 3, 0]); // UNSELECTED, between
    let c = commit_bytes(&repo, &dir, "img.bin", &[0u8, 3, 3, 9, 0]).to_string(); // selected
    let path = dir.to_str().unwrap();
    let oids = [a, c];

    // The change isn't hidden from the list...
    let files = selection_diff(path, &oids).unwrap();
    assert!(files.iter().any(|f| f.path == "img.bin"));
    // ...but the exact per-file merged diff fails closed rather than mislead.
    assert!(selection_diff_file(path, &oids, "img.bin", false).is_err());

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn selection_diff_file_carries_blob_oids_for_content_previews() {
    let dir = std::env::temp_dir().join("gitlane-selection-oid-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();
    commit(&repo, &dir, "seed.txt", "seed\n");
    let add = commit(&repo, &dir, "README.md", "# Title\n\nfirst\n").to_string();
    commit(&repo, &dir, "other.txt", "between, does not touch README\n"); // unselected
    let v2 = "# Title\n\nsecond\n";
    let modify = commit(&repo, &dir, "README.md", v2).to_string();
    let path = dir.to_str().unwrap();
    let oids = [add, modify];

    // Non-gapped selection (the unselected commit doesn't touch the file): the
    // net text diff carries the blob oids, and the new side round-trips the
    // full file text — what the markdown preview renders (GL-100).
    let diff = selection_diff_file(path, &oids, "README.md", false).unwrap();
    assert_eq!(diff.status, ChangeStatus::Added);
    assert_eq!(diff.old_oid, None);
    let new_oid = diff
        .new_oid
        .clone()
        .expect("selection text diff carries the new-side oid");
    use base64::Engine as _;
    let blob = read_binary_blob(path, Some(&new_oid), None, None).unwrap();
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(blob.base64.unwrap())
        .unwrap();
    assert_eq!(String::from_utf8(decoded).unwrap(), v2);

    // Gapped + composed: the merged result exists only in memory — there is no
    // blob to fetch — so no oids travel and the preview falls back to its
    // "no content" state instead of showing a blob with the unselected edit.
    commit(&repo, &dir, "gap.md", "1\n2\n3\n4\n5\n"); // base (parent of A)
    let a = commit(&repo, &dir, "gap.md", "A\n2\n3\n4\n5\n").to_string(); // selected: line 1
    commit(&repo, &dir, "gap.md", "A\n2\nB\n4\n5\n"); // UNSELECTED: line 3
    let c = commit(&repo, &dir, "gap.md", "A\n2\nB\n4\nC\n").to_string(); // selected: line 5
    let composed = selection_diff_file(path, &[a, c], "gap.md", false).unwrap();
    assert_eq!(composed.old_oid, None);
    assert_eq!(composed.new_oid, None);

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn selection_diff_handles_binary_files() {
    let dir = std::env::temp_dir().join("gitlane-selection-binary-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();
    commit(&repo, &dir, "seed.txt", "seed\n");
    let v1: Vec<u8> = vec![0u8, 1, 2, 0];
    let v2: Vec<u8> = vec![0u8, 9, 8, 7, 6, 0];
    let add = commit_bytes(&repo, &dir, "img.bin", &v1).to_string();
    let modify = commit_bytes(&repo, &dir, "img.bin", &v2).to_string();
    let path = dir.to_str().unwrap();
    let oids = [add, modify];

    let files = selection_diff(path, &oids).unwrap();
    let entry = files.iter().find(|f| f.path == "img.bin").unwrap();
    assert!(entry.binary);
    assert_eq!(entry.status, ChangeStatus::Added);
    assert_eq!((entry.add, entry.del), (0, 0));

    // Added then modified → still added; the binary card shows only the new side.
    let diff = selection_diff_file(path, &oids, "img.bin", false).unwrap();
    assert!(diff.binary);
    assert_eq!(diff.status, ChangeStatus::Added);
    assert_eq!(diff.new_size, Some(v2.len() as u64));
    assert_eq!(diff.old_size, None);
    assert!(diff.hunks.is_empty());

    let _ = fs::remove_dir_all(&dir);
}

/// A linear chain of five commits, each appending a line to `f.txt`, on top of
/// a base; consecutive pairs share a committer time (as a rebase leaves them).
/// Returns the picks newest-first, the order the graph selection sends them.
fn linear_chain(dir: &Path) -> Vec<String> {
    let _ = fs::remove_dir_all(dir);
    fs::create_dir_all(dir).unwrap();
    let repo = Repository::init(dir).unwrap();
    commit_at(&repo, dir, "f.txt", "0\n", 1000); // base (parent of the oldest pick)
    let mut content = String::from("0\n");
    let mut picks = Vec::new();
    for (n, secs) in [(1, 2000), (2, 3000), (3, 3000), (4, 4000), (5, 4000)] {
        content.push_str(&format!("{n}\n"));
        picks.push(commit_at(&repo, dir, "f.txt", &content, secs).to_string());
    }
    picks.reverse();
    picks
}

fn diff_lines(diff: &crate::git::types::FileDiff, kind: &str) -> Vec<String> {
    let lines = diff.hunks.iter().flat_map(|h| &h.lines);
    lines
        .filter(|l| l.kind == kind)
        .map(|l| l.content.clone())
        .collect()
}

#[test]
fn selection_diff_contiguous_run_is_not_gapped_in_any_pick_order() {
    // Regression: a newest-first linear selection of 3+ commits was mis-ordered
    // (the walk stopped at the second-newest pick), so a file every pick edits
    // was reported as changed by unselected commits in between. The union must
    // also not depend on the order the picks arrive in.
    let dir = std::env::temp_dir().join("gitlane-selection-linear-run-test");
    let picks = linear_chain(&dir);
    let path = dir.to_str().unwrap();
    let shuffled: Vec<String> = [2, 0, 4, 1, 3].iter().map(|&i| picks[i].clone()).collect();

    for order in [&picks, &shuffled] {
        let diff = selection_diff_file(path, order, "f.txt", false).unwrap();
        assert_eq!(diff.status, ChangeStatus::Modified);
        assert_eq!(diff_lines(&diff, "add"), ["1", "2", "3", "4", "5"]);
        assert!(diff_lines(&diff, "del").is_empty());

        let files = selection_diff(path, order).unwrap();
        let f = files.iter().find(|f| f.path == "f.txt").unwrap();
        assert_eq!((f.status, f.add, f.del), (ChangeStatus::Modified, 5, 0));
    }

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn selection_diff_orders_unrelated_picks_by_time() {
    // Two root commits with no common ancestor both add f.txt. With no ancestry
    // to rank them, the later one (Y) must be the head whatever the pick order.
    let dir = std::env::temp_dir().join("gitlane-selection-unrelated-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();
    let root = |content: &str, secs: i64| {
        let blob = repo.blob(content.as_bytes()).unwrap();
        let mut tree = repo.treebuilder(None).unwrap();
        tree.insert("f.txt", blob, 0o100644).unwrap();
        let tree = repo.find_tree(tree.write().unwrap()).unwrap();
        let sig = Signature::new("Bench", "bench@example.test", &git2::Time::new(secs, 0)).unwrap();
        repo.commit(None, &sig, &sig, "root", &tree, &[])
            .unwrap()
            .to_string()
    };
    let x = root("1\n", 1000);
    let y = root("1\n2\n3\n", 2000);
    let path = dir.to_str().unwrap();

    for picks in [[x.clone(), y.clone()], [y, x]] {
        let files = selection_diff(path, &picks).unwrap();
        let f = files.iter().find(|f| f.path == "f.txt").unwrap();
        assert_eq!(
            (f.add, f.del),
            (3, 0),
            "head should be the later root: {picks:?}"
        );
    }

    let _ = fs::remove_dir_all(&dir);
}
