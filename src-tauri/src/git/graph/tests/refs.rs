//! Which refs pull a commit into the graph: fetched tags, annotated-tag-only
//! commits, and a commit reachable only from a detached worktree.

use super::support::*;

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

    let label = tagged_node
        .refs
        .iter()
        .find(|r| r.kind == "tag" && r.name == "0.1.1")
        .expect("fetched local tag should be exposed as a tag ref");
    assert_eq!(
        label.target_oid.as_deref(),
        Some(tagged.to_string().as_str()),
        "a lightweight tag's exact ref target is its commit",
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
    let tag_object = repo
        .tag("v0.1.1", &object, &sig(210), "release tag", false)
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

    let label = tagged_node
        .refs
        .iter()
        .find(|r| r.kind == "tag" && r.name == "v0.1.1")
        .expect("annotated tag should label the tag-only commit");
    assert_ne!(tag_object, tagged, "annotated tag must name a tag object");
    assert_eq!(
        label.target_oid.as_deref(),
        Some(tag_object.to_string().as_str()),
        "the destructive guard needs the raw tag-object oid, not the peeled commit",
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
