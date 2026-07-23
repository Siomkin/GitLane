//! `history` write-path tests.

use super::support::*;

#[test]
fn rebase_uses_explicit_source_instead_of_previously_active_branch() {
    let repo = TempRepo::new("rebase-explicit-source");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);

    std::fs::write(repo.0.join("base.txt"), "base\n").unwrap();
    repo.git_ok(&["add", "base.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "base"]);
    repo.git_ok(&["checkout", "-q", "-b", "feature"]);
    std::fs::write(repo.0.join("feature.txt"), "feature\n").unwrap();
    repo.git_ok(&["add", "feature.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "feature work"]);

    repo.git_ok(&["checkout", "-q", "main"]);
    std::fs::write(repo.0.join("main.txt"), "main\n").unwrap();
    repo.git_ok(&["add", "main.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "main work"]);
    let main_tip = rev_parse(&repo, "main");

    repo.git_ok(&["checkout", "-q", "-b", "previously-active"]);
    std::fs::write(repo.0.join("active.txt"), "active\n").unwrap();
    repo.git_ok(&["add", "active.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "previously active work"]);
    let active_tip = rev_parse(&repo, "previously-active");

    let feature_tip = rev_parse(&repo, "feature");
    rebase(repo.path(), "feature", &feature_tip, &main_tip)
        .expect("rebase explicit source onto main");

    let head = repo.git(&["branch", "--show-current"]);
    assert!(head.status.success());
    assert_eq!(String::from_utf8_lossy(&head.stdout).trim(), "feature");
    assert_eq!(rev_parse(&repo, "feature^"), main_tip);
    assert_eq!(rev_parse(&repo, "previously-active"), active_tip);
    let active_is_feature_ancestor = repo.git(&[
        "merge-base",
        "--is-ancestor",
        "previously-active",
        "feature",
    ]);
    assert!(
        !active_is_feature_ancestor.status.success(),
        "the previously active branch must not become the rebase target"
    );
}

#[test]
fn rebase_keeps_detached_head_support_with_an_explicit_source() {
    let repo = TempRepo::new("rebase-detached-source");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);

    std::fs::write(repo.0.join("base.txt"), "base\n").unwrap();
    repo.git_ok(&["add", "base.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "base"]);
    let base = rev_parse(&repo, "HEAD");

    repo.git_ok(&["checkout", "-q", "--detach", &base]);
    std::fs::write(repo.0.join("detached.txt"), "detached\n").unwrap();
    repo.git_ok(&["add", "detached.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "detached work"]);
    let detached_tip = rev_parse(&repo, "HEAD");

    repo.git_ok(&["checkout", "-q", "main"]);
    std::fs::write(repo.0.join("main.txt"), "main\n").unwrap();
    repo.git_ok(&["add", "main.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "main work"]);
    let main_tip = rev_parse(&repo, "main");
    repo.git_ok(&["checkout", "-q", "--detach", &detached_tip]);

    rebase(repo.path(), "HEAD", &detached_tip, &main_tip).expect("rebase detached HEAD onto main");

    let head = repo.git(&["branch", "--show-current"]);
    assert!(head.status.success());
    assert!(head.stdout.is_empty(), "HEAD should remain detached");
    assert_eq!(rev_parse(&repo, "HEAD^"), main_tip);
    let message = repo.git(&["log", "-1", "--format=%s"]);
    assert!(message.status.success());
    assert_eq!(
        String::from_utf8_lossy(&message.stdout).trim(),
        "detached work"
    );
}

#[test]
fn rebase_explicit_source_prefers_a_local_branch_over_same_named_tag() {
    let repo = TempRepo::new("rebase-ambiguous-source");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);

    std::fs::write(repo.0.join("base.txt"), "base\n").unwrap();
    repo.git_ok(&["add", "base.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "base"]);
    repo.git_ok(&["tag", "feature"]);
    repo.git_ok(&["checkout", "-q", "-b", "feature"]);
    std::fs::write(repo.0.join("feature.txt"), "feature\n").unwrap();
    repo.git_ok(&["add", "feature.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "feature work"]);

    repo.git_ok(&["checkout", "-q", "main"]);
    std::fs::write(repo.0.join("main.txt"), "main\n").unwrap();
    repo.git_ok(&["add", "main.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "main work"]);
    let main_tip = rev_parse(&repo, "main");

    let feature_tip = rev_parse(&repo, "refs/heads/feature");
    rebase(repo.path(), "feature", &feature_tip, &main_tip)
        .expect("rebase the branch, not its tag");

    let head = repo.git(&["branch", "--show-current"]);
    assert!(head.status.success());
    assert_eq!(String::from_utf8_lossy(&head.stdout).trim(), "feature");
    assert_eq!(rev_parse(&repo, "refs/heads/feature^"), main_tip);
}

#[test]
fn merge_into_uses_explicit_destination_instead_of_active_branch() {
    let (repo, base) = repo_with_base_commit("merge-explicit-destination");
    repo.git_ok(&["checkout", "-q", "-b", "feature"]);
    std::fs::write(repo.0.join("feature.txt"), "feature\n").unwrap();
    repo.git_ok(&["add", "feature.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "feature"]);
    let feature_tip = rev_parse(&repo, "feature");

    repo.git_ok(&["checkout", "-q", "main"]);
    std::fs::write(repo.0.join("main.txt"), "main\n").unwrap();
    repo.git_ok(&["add", "main.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "main"]);
    let main_tip = rev_parse(&repo, "main");

    repo.git_ok(&["checkout", "-q", "-b", "previously-active", &base]);
    std::fs::write(repo.0.join("active.txt"), "active\n").unwrap();
    repo.git_ok(&["add", "active.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "active"]);
    let active_tip = rev_parse(&repo, "previously-active");

    merge_into(
        repo.path(),
        "refs/heads/feature",
        &feature_tip,
        Some("main"),
        &main_tip,
    )
    .expect("merge explicit source into explicit destination");

    assert_eq!(
        String::from_utf8_lossy(&repo.git(&["branch", "--show-current"]).stdout).trim(),
        "main"
    );
    assert!(repo
        .git(&["merge-base", "--is-ancestor", "feature", "main"])
        .status
        .success());
    assert_eq!(rev_parse(&repo, "previously-active"), active_tip);
    // The validated qualified ref must not leak into the generated subject.
    let subject = repo.git(&["log", "-1", "--format=%s", "main"]);
    assert!(subject.status.success());
    assert!(
        String::from_utf8_lossy(&subject.stdout).starts_with("Merge branch 'feature'"),
        "unexpected merge subject: {}",
        String::from_utf8_lossy(&subject.stdout)
    );
}

#[test]
fn merge_into_names_a_remote_tracking_source_by_its_short_name() {
    let (repo, base) = repo_with_base_commit("merge-remote-source-subject");
    repo.git_ok(&["checkout", "-q", "-b", "topic"]);
    repo.git_ok(&["commit", "-q", "--allow-empty", "-m", "topic work"]);
    let topic_tip = rev_parse(&repo, "topic");
    repo.git_ok(&["update-ref", "refs/remotes/origin/topic", &topic_tip]);
    repo.git_ok(&["checkout", "-q", "main"]);
    repo.git_ok(&["branch", "-D", "topic"]);

    merge_into(
        repo.path(),
        "refs/remotes/origin/topic",
        &topic_tip,
        Some("main"),
        &base,
    )
    .expect("merge remote-tracking source");

    let subject = repo.git(&["log", "-1", "--format=%s", "main"]);
    assert!(subject.status.success());
    assert!(
        String::from_utf8_lossy(&subject.stdout)
            .starts_with("Merge remote-tracking branch 'origin/topic'"),
        "unexpected merge subject: {}",
        String::from_utf8_lossy(&subject.stdout)
    );
}

#[test]
fn merge_into_keeps_the_qualified_source_when_a_tag_shadows_the_branch() {
    let (repo, base) = repo_with_base_commit("merge-tag-shadowed-source");
    // A tag named `feature` at a *different* commit shadows the branch for
    // bare-name resolution, so the merge must keep the qualified operand.
    repo.git_ok(&["tag", "feature", &base]);
    repo.git_ok(&["checkout", "-q", "-b", "feature"]);
    repo.git_ok(&["commit", "-q", "--allow-empty", "-m", "feature work"]);
    let feature_tip = rev_parse(&repo, "refs/heads/feature");
    repo.git_ok(&["checkout", "-q", "main"]);
    repo.git_ok(&["commit", "-q", "--allow-empty", "-m", "main work"]);
    let main_tip = rev_parse(&repo, "main");

    merge_into(
        repo.path(),
        "refs/heads/feature",
        &feature_tip,
        Some("main"),
        &main_tip,
    )
    .expect("merge the shadowed branch");

    // The branch commit — not the tag's — is what got merged.
    assert_eq!(rev_parse(&repo, "main^2"), feature_tip);
}

#[test]
fn merge_into_rejects_a_stale_destination_before_checkout() {
    let (repo, base) = repo_with_base_commit("merge-stale-destination");
    repo.git_ok(&["branch", "feature"]);
    repo.git_ok(&["checkout", "-q", "-b", "previously-active"]);
    let active_tip = rev_parse(&repo, "HEAD");
    repo.git_ok(&["checkout", "-q", "main"]);
    repo.git_ok(&["commit", "-q", "--allow-empty", "-m", "main moved"]);
    let moved_main = rev_parse(&repo, "main");
    repo.git_ok(&["checkout", "-q", "previously-active"]);

    let result = merge_into(repo.path(), "feature", &base, Some("main"), &base);
    assert!(result.is_err(), "stale destination must fail closed");
    assert_eq!(
        String::from_utf8_lossy(&repo.git(&["branch", "--show-current"]).stdout).trim(),
        "previously-active"
    );
    assert_eq!(rev_parse(&repo, "previously-active"), active_tip);
    assert_eq!(rev_parse(&repo, "main"), moved_main);
}

#[test]
fn fast_forward_and_reset_mutate_only_the_explicit_branch() {
    let (repo, base) = repo_with_base_commit("explicit-fast-forward-reset");
    repo.git_ok(&["branch", "moving"]);
    repo.git_ok(&["checkout", "-q", "-b", "target"]);
    repo.git_ok(&["commit", "-q", "--allow-empty", "-m", "target"]);
    let target_tip = rev_parse(&repo, "target");
    repo.git_ok(&["checkout", "-q", "-b", "previously-active", &base]);
    repo.git_ok(&["commit", "-q", "--allow-empty", "-m", "active"]);
    let active_tip = rev_parse(&repo, "previously-active");

    fast_forward_branch_at(repo.path(), "moving", &base, &target_tip)
        .expect("fast-forward explicit branch");
    assert_eq!(rev_parse(&repo, "moving"), target_tip);
    assert_eq!(rev_parse(&repo, "previously-active"), active_tip);
    assert!(
        fast_forward_branch_at(repo.path(), "moving", &base, &target_tip).is_err(),
        "a stale expected tip must not overwrite the moved branch"
    );

    // Hard-reset lease is of the worktree being reset: check out `moving`
    // before preview so tip preparation does not change the leased state.
    repo.git_ok(&["checkout", "-q", "moving"]);
    let preview = preview_reset(repo.path(), &base, "hard", "moving").expect("hard-reset preview");
    reset_branch(
        repo.path(),
        Some("moving"),
        Some(&target_tip),
        &base,
        "hard",
        preview.expected_state.as_deref(),
        preview.expected_head_branch.as_deref(),
        preview.expected_head_oid.as_deref(),
    )
    .expect("reset explicit branch");
    assert_eq!(
        String::from_utf8_lossy(&repo.git(&["branch", "--show-current"]).stdout).trim(),
        "moving"
    );
    assert_eq!(rev_parse(&repo, "moving"), base);
    assert_eq!(rev_parse(&repo, "previously-active"), active_tip);
}

#[test]
fn fast_forward_updates_a_linked_worktree_instead_of_only_its_ref() {
    let (repo, base) = repo_with_base_commit("fast-forward-linked-worktree");
    repo.git_ok(&["branch", "moving"]);
    repo.git_ok(&["checkout", "-q", "-b", "target"]);
    std::fs::write(repo.0.join("target.txt"), "target\n").unwrap();
    repo.git_ok(&["add", "target.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "target"]);
    let target_tip = rev_parse(&repo, "target");
    repo.git_ok(&["checkout", "-q", "main"]);

    let linked = TempRepo::new("fast-forward-linked-owner");
    repo.git_ok(&["worktree", "add", "-q", linked.path(), "moving"]);

    fast_forward_branch_at(repo.path(), "moving", &base, &target_tip)
        .expect("fast-forward in owning worktree");

    assert_eq!(rev_parse(&repo, "moving"), target_tip);
    assert_eq!(rev_parse(&linked, "HEAD"), target_tip);
    assert!(linked.0.join("target.txt").is_file());
    assert!(
        linked.git(&["status", "--porcelain"]).stdout.is_empty(),
        "the owning worktree must stay clean after its branch advances"
    );
}

#[test]
fn fast_forward_refuses_dirty_changes_in_the_owning_worktree() {
    let (repo, base) = repo_with_base_commit("fast-forward-dirty-linked-worktree");
    repo.git_ok(&["branch", "moving"]);
    repo.git_ok(&["checkout", "-q", "-b", "target"]);
    std::fs::write(repo.0.join("f.txt"), "target\n").unwrap();
    repo.git_ok(&["commit", "-q", "-a", "-m", "target"]);
    let target_tip = rev_parse(&repo, "target");
    repo.git_ok(&["checkout", "-q", "main"]);

    let linked = TempRepo::new("fast-forward-dirty-linked-owner");
    repo.git_ok(&["worktree", "add", "-q", linked.path(), "moving"]);
    std::fs::write(linked.0.join("f.txt"), "dirty\n").unwrap();

    fast_forward_branch_at(repo.path(), "moving", &base, &target_tip)
        .expect_err("dirty owning worktree must block fast-forward");

    assert_eq!(rev_parse(&repo, "moving"), base);
    assert_eq!(rev_parse(&linked, "HEAD"), base);
    assert_eq!(
        std::fs::read_to_string(linked.0.join("f.txt")).unwrap(),
        "dirty\n"
    );
    assert_eq!(
        String::from_utf8_lossy(&linked.git(&["status", "--porcelain"]).stdout).trim_end(),
        " M f.txt"
    );
}

#[test]
fn merge_into_preserves_detached_head_support() {
    let (repo, base) = repo_with_base_commit("merge-detached-destination");
    repo.git_ok(&["checkout", "-q", "-b", "feature"]);
    repo.git_ok(&["commit", "-q", "--allow-empty", "-m", "feature"]);
    let feature_tip = rev_parse(&repo, "feature");
    repo.git_ok(&["checkout", "-q", "--detach", &base]);

    merge_into(repo.path(), "feature", &feature_tip, None, &base)
        .expect("merge into detached HEAD");

    assert!(repo.git(&["branch", "--show-current"]).stdout.is_empty());
    assert!(repo
        .git(&["merge-base", "--is-ancestor", "feature", "HEAD"])
        .status
        .success());
}

#[test]
fn head_guarded_writes_reject_a_different_active_branch() {
    let (repo, base) = repo_with_base_commit("guarded-head-writes");
    repo.git_ok(&["checkout", "-q", "-b", "pick-source"]);
    std::fs::write(repo.0.join("picked.txt"), "picked\n").unwrap();
    repo.git_ok(&["add", "picked.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "picked"]);
    let picked = rev_parse(&repo, "HEAD");
    repo.git_ok(&["checkout", "-q", "main"]);
    repo.git_ok(&["checkout", "-q", "-b", "unexpected"]);
    let unexpected_tip = rev_parse(&repo, "HEAD");
    std::fs::write(repo.0.join("staged.txt"), "staged\n").unwrap();
    repo.git_ok(&["add", "staged.txt"]);

    assert!(cherry_pick_onto(repo.path(), Some("main"), &base, &picked).is_err());
    assert!(revert_onto(repo.path(), Some("main"), &base, &picked).is_err());
    assert!(commit_expected(
        repo.path(),
        Some("main"),
        Some(&base),
        "must not commit",
        "",
        false,
        None,
        None,
        None,
        false,
    )
    .is_err());
    assert_eq!(rev_parse(&repo, "unexpected"), unexpected_tip);
    assert_eq!(
        String::from_utf8_lossy(&repo.git(&["branch", "--show-current"]).stdout).trim(),
        "unexpected"
    );
}

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

#[test]
fn revert_many_splits_a_mixed_normal_and_merge_selection() {
    // `git revert -m 1 A B` rejects a non-merge B, so a mixed selection has to
    // run as consecutive same-kind invocations — both commits must be undone.
    let (repo, merge_sha) = repo_with_merged_feature("revert-many-mixed");
    std::fs::write(repo.0.join("extra.txt"), "extra\n").unwrap();
    repo.git_ok(&["add", "extra.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "extra"]);
    let extra_sha = rev_parse(&repo, "HEAD");

    revert_many(repo.path(), &[extra_sha, merge_sha]).expect("revert normal + merge");

    assert!(!repo.0.join("extra.txt").exists(), "normal commit reverted");
    assert!(
        !repo.0.join("feature.txt").exists(),
        "merge commit reverted"
    );
    assert!(
        repo.0.join("main.txt").exists(),
        "mainline history survives"
    );
}

#[test]
fn cherry_pick_many_splits_a_mixed_normal_and_merge_selection() {
    let (repo, merge_sha) = repo_with_merged_feature("cherry-pick-many-mixed");
    let mainline_sha = rev_parse(&repo, &format!("{merge_sha}~1"));
    repo.git_ok(&["checkout", "-q", "-b", "dest", &format!("{merge_sha}~2")]);

    cherry_pick_many(repo.path(), &[mainline_sha, merge_sha]).expect("cherry-pick normal + merge");

    assert!(repo.0.join("main.txt").exists(), "normal commit applied");
    assert!(
        repo.0.join("feature.txt").exists(),
        "merge's first-parent delta applied"
    );
}

#[test]
fn merge_pins_no_ff_against_merge_ff_config() {
    let repo = TempRepo::new("merge-no-ff");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);

    // Base commit on main.
    std::fs::write(repo.0.join("file.txt"), b"base\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "base"]);
    repo.git_ok(&["branch", "-M", "main"]);

    // A feature branch with one extra commit (so a plain merge *could* fast-forward).
    repo.git_ok(&["checkout", "-q", "-b", "feature"]);
    std::fs::write(repo.0.join("file.txt"), b"feature\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "feature work"]);

    // `merge.ff=only` would refuse a real merge commit — the flag must override it.
    repo.git_ok(&["config", "merge.ff", "only"]);
    repo.git_ok(&["checkout", "-q", "main"]);

    let out = merge(repo.path(), "feature").expect("merge succeeds despite merge.ff=only");
    // Guard the store's toast mapping: a merge that really created a commit
    // must never carry the up-to-date phrase (`src/lib/mergeOutcome.ts`).
    assert!(
        !out.contains("Already up to date"),
        "a real merge must not report up-to-date: {out}"
    );

    // HEAD is a merge commit: `rev-list --parents -1` lists the commit plus its
    // two parents (three whitespace-separated hashes). A fast-forward would have
    // left a single-parent commit (two hashes).
    let out = repo.git(&["rev-list", "--parents", "-1", "HEAD"]);
    assert!(out.status.success(), "rev-list failed");
    let line = String::from_utf8_lossy(&out.stdout);
    let hashes = line.split_whitespace().count();
    assert_eq!(
        hashes, 3,
        "expected a merge commit (commit + 2 parents), got {hashes} hashes: {line:?}"
    );
}

#[test]
fn merge_of_an_already_reachable_branch_reports_up_to_date_and_creates_nothing() {
    let repo = TempRepo::new("merge-up-to-date");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("file.txt"), b"base\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "base"]);
    repo.git_ok(&["branch", "-M", "main"]);
    repo.git_ok(&["branch", "feature"]);

    let head = |repo: &TempRepo| {
        let out = repo.git(&["rev-parse", "HEAD"]);
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    };

    // Equal tips (the menu offers Merge here since GL-113): `--no-ff` does NOT
    // force a merge commit — git exits 0 with "Already up to date." and creates
    // nothing. The store keys its toast off that output, and the subprocess is
    // pinned to LC_ALL=C so the phrase is stable under a localized git.
    let before = head(&repo);
    let out = merge(repo.path(), "feature").expect("merge of an equal tip succeeds");
    assert!(
        out.contains("Already up to date"),
        "equal tips must report up-to-date: {out}"
    );
    assert_eq!(
        head(&repo),
        before,
        "no commit may be created for equal tips"
    );

    // Already-merged ancestor: same no-op once main moves ahead of feature.
    std::fs::write(repo.0.join("file.txt"), b"ahead\n").unwrap();
    repo.git_ok(&["commit", "-q", "-am", "ahead"]);
    let before = head(&repo);
    let out = merge(repo.path(), "feature").expect("merge of an ancestor succeeds");
    assert!(
        out.contains("Already up to date"),
        "an ancestor must report up-to-date: {out}"
    );
    assert_eq!(
        head(&repo),
        before,
        "no commit may be created for an ancestor"
    );
}

#[test]
fn fast_forward_is_a_no_op_on_equal_tips() {
    let repo = TempRepo::new("ff-equal-tips");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("file.txt"), b"base\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "base"]);
    repo.git_ok(&["branch", "-M", "main"]);
    repo.git_ok(&["branch", "feature"]);

    let head_out = repo.git(&["rev-parse", "HEAD"]);
    let head = String::from_utf8_lossy(&head_out.stdout).trim().to_string();

    // The probe now reports equal tips as fast-forwardable (GL-113), so both
    // write paths the menu can dispatch to must treat them as an up-to-date
    // no-op rather than fail: `merge --ff-only` on the checked-out branch and
    // `fetch . <target>:<branch>` on a branch that isn't checked out.
    fast_forward(repo.path(), "feature").expect("ff-only merge of an equal tip succeeds");
    fast_forward_branch(repo.path(), "feature", "main")
        .expect("in-place ff of an equal tip succeeds");

    // Nothing moved: both refs still point at the original commit.
    for rev in ["HEAD", "refs/heads/feature"] {
        let out = repo.git(&["rev-parse", rev]);
        assert_eq!(
            String::from_utf8_lossy(&out.stdout).trim(),
            head,
            "{rev} must be unchanged by a no-op fast-forward"
        );
    }
}

#[test]
fn fast_forward_branch_no_op_when_equal_tip_branch_is_checked_out_in_worktree() {
    let repo = TempRepo::new("ff-equal-linked-worktree");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("file.txt"), b"base\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "base"]);
    repo.git_ok(&["branch", "-M", "main"]);
    repo.git_ok(&["branch", "feature"]);
    let linked = repo.0.with_file_name(format!(
        "gitlane-ff-equal-linked-worktree-linked-{}",
        std::process::id()
    ));
    let linked_str = linked.to_str().unwrap();
    repo.git_ok(&["worktree", "add", "-q", linked_str, "feature"]);

    let head = rev_parse(&repo, "main");

    let out = fast_forward_branch(repo.path(), "feature", "main")
        .expect("equal-tip branch held by another worktree is already current");

    assert!(out.contains("Already up to date"));
    assert_eq!(rev_parse(&repo, "refs/heads/feature"), head);
    let _ = std::fs::remove_dir_all(linked);
}

#[test]
fn merge_disambiguates_a_branch_from_a_same_named_tag() {
    // Git's rev resolution gives a tag precedence over a same-named branch, so a
    // bare `git merge feature` would merge the TAG. GitLane qualifies to
    // refs/heads/ in that ambiguous case so the branch is merged instead.
    let repo = TempRepo::new("merge-ambiguous");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.name", "T"]);
    repo.git_ok(&["config", "user.email", "t@example.test"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    repo.git_ok(&["commit", "-q", "--allow-empty", "-m", "base"]);
    let base = rev_parse(&repo, "HEAD");

    // Branch `feature` one commit ahead; tag `feature` pinned at the base.
    repo.git_ok(&["checkout", "-q", "-b", "feature"]);
    repo.git_ok(&["commit", "-q", "--allow-empty", "-m", "branch-work"]);
    let branch_tip = rev_parse(&repo, "HEAD");
    repo.git_ok(&["checkout", "-q", "main"]);
    repo.git_ok(&["tag", "feature", &base]);

    merge(repo.path(), "feature").expect("merge the branch, not the tag");

    // A real merge commit whose second parent is the branch tip — not the tag
    // (which, being the base, would have produced "Already up to date").
    assert_eq!(
        rev_parse(&repo, "HEAD^2"),
        branch_tip,
        "merge must target the branch, not the same-named tag"
    );
}

#[test]
fn merge_keeps_the_bare_name_when_no_tag_clashes() {
    // Without a clashing tag the bare name is used unchanged, so the merge
    // message keeps its clean "Merge branch 'feature'" form.
    let repo = TempRepo::new("merge-unambiguous");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.name", "T"]);
    repo.git_ok(&["config", "user.email", "t@example.test"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    repo.git_ok(&["commit", "-q", "--allow-empty", "-m", "base"]);
    repo.git_ok(&["checkout", "-q", "-b", "feature"]);
    repo.git_ok(&["commit", "-q", "--allow-empty", "-m", "branch-work"]);
    repo.git_ok(&["checkout", "-q", "main"]);

    merge(repo.path(), "feature").expect("merge succeeds");

    let subject = String::from_utf8_lossy(&repo.git(&["log", "-1", "--format=%s"]).stdout)
        .trim()
        .to_string();
    assert_eq!(subject, "Merge branch 'feature'");
}
