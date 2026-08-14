//! Merge: explicit destination, ref disambiguation, no-ff pinning, and the
//! already-reachable case.

use super::super::support::*;

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
