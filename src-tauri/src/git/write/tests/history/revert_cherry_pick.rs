//! Revert and cherry-pick, including the mainline a merge commit needs and the
//! split a mixed selection forces.

use super::super::support::*;

#[test]
fn revert_of_a_merge_commit_defaults_to_mainline_one() {
    // Without `-m 1` git refuses outright: "commit … is a merge but no -m
    // option was given" — the swimlane UI's Revert must work on merges.
    let (repo, merge_sha) = repo_with_merged_feature("revert-merge");

    revert(repo.path(), &merge_sha).expect("revert a merge commit");

    assert!(
        !repo.0.join("feature.txt").exists(),
        "the merged-in change is undone"
    );
    assert!(
        repo.0.join("main.txt").exists(),
        "first-parent (mainline) history survives the revert"
    );
    assert!(repo.0.join("base.txt").exists());
}

#[test]
fn cherry_pick_of_a_merge_applies_the_first_parent_delta() {
    let (repo, merge_sha) = repo_with_merged_feature("cherry-pick-merge");
    // A branch rooted before the merge — picking the merge onto it must apply
    // exactly what the merge introduced relative to its first parent.
    repo.git_ok(&["checkout", "-q", "-b", "dest", &format!("{merge_sha}~2")]);

    cherry_pick(repo.path(), &merge_sha).expect("cherry-pick a merge commit");

    assert!(
        repo.0.join("feature.txt").exists(),
        "the first-parent delta (the merged branch's change) is applied"
    );
    assert!(
        !repo.0.join("main.txt").exists(),
        "the mainline commit itself is not dragged along"
    );
}

/// `git revert -m 1 A B` rejects a non-merge B, so a mixed selection cannot be
/// one invocation. It used to run as consecutive same-kind invocations, but a
/// conflict in one of them returned before the rest were queued: the user
/// resolved, `--continue` finished only that run, and the remaining commits
/// were silently never applied. Refusing up front is the honest answer.
#[test]
fn revert_many_refuses_a_mixed_normal_and_merge_selection() {
    let (repo, merge_sha) = repo_with_merged_feature("revert-many-mixed");
    std::fs::write(repo.0.join("extra.txt"), "extra\n").unwrap();
    repo.git_ok(&["add", "extra.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "extra"]);
    let extra_sha = rev_parse(&repo, "HEAD");

    let err = revert_many(repo.path(), &[extra_sha, merge_sha]).unwrap_err();

    assert!(
        err.contains("Merge commits have to be applied on their own"),
        "got {err}"
    );
    assert!(
        repo.0.join("extra.txt").exists(),
        "nothing is applied when the batch is refused"
    );
}

/// A selection that is all merges is still one invocation.
#[test]
fn revert_many_still_accepts_an_all_merge_selection() {
    let (repo, merge_sha) = repo_with_merged_feature("revert-many-all-merge");

    revert_many(repo.path(), &[merge_sha]).expect("revert a merge on its own");

    assert!(!repo.0.join("feature.txt").exists(), "merge reverted");
    assert!(repo.0.join("main.txt").exists(), "mainline survives");
}

#[test]
fn cherry_pick_many_refuses_a_mixed_normal_and_merge_selection() {
    let (repo, merge_sha) = repo_with_merged_feature("cherry-pick-many-mixed");
    let mainline_sha = rev_parse(&repo, &format!("{merge_sha}~1"));
    repo.git_ok(&["checkout", "-q", "-b", "dest", &format!("{merge_sha}~2")]);

    let err = cherry_pick_many(repo.path(), &[mainline_sha, merge_sha]).unwrap_err();

    assert!(
        err.contains("Merge commits have to be applied on their own"),
        "got {err}"
    );
    assert!(
        !repo.0.join("main.txt").exists(),
        "nothing is applied when the batch is refused"
    );
}

/// An all-ordinary selection is still applied as one invocation.
#[test]
fn cherry_pick_many_applies_an_all_ordinary_selection() {
    let (repo, merge_sha) = repo_with_merged_feature("cherry-pick-many-ordinary");
    let mainline_sha = rev_parse(&repo, &format!("{merge_sha}~1"));
    repo.git_ok(&["checkout", "-q", "-b", "dest", &format!("{merge_sha}~2")]);

    cherry_pick_many(repo.path(), &[mainline_sha]).expect("cherry-pick ordinary commits");

    assert!(repo.0.join("main.txt").exists(), "normal commit applied");
}
