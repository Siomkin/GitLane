//! Range and ancestry reads behind the stack UI: what a range adds, which
//! branches are nearest, and the default base.

use super::support::*;

// ---- commit ranges and ancestry (create-pull-request reads) ----

#[test]
fn range_commits_lists_only_what_the_head_adds() {
    let tmp = stack_repo("range");
    let path = tmp.path().to_str().unwrap();

    let from_trunk = super::super::range::range_commits(path, "main", "upper").unwrap();
    let subjects: Vec<&str> = from_trunk.iter().map(|c| c.summary.as_str()).collect();
    assert_eq!(subjects, vec!["u1", "l2", "l1"]);

    // Retargeting onto the layer below drops that layer's own commits — the
    // recount the stack tab does when the base changes.
    let from_lower = super::super::range::range_commits(path, "lower", "upper").unwrap();
    let subjects: Vec<&str> = from_lower.iter().map(|c| c.summary.as_str()).collect();
    assert_eq!(subjects, vec!["u1"]);
}

#[test]
fn range_commits_carries_short_id_and_author() {
    let tmp = stack_repo("range-meta");
    let commits =
        super::super::range::range_commits(tmp.path().to_str().unwrap(), "lower", "upper").unwrap();
    let head = &commits[0];
    assert_eq!(head.short_id.len(), 7);
    assert!(head.id.starts_with(&head.short_id));
    assert_eq!(head.author_name, "GitLane");
    assert_eq!(head.author_email, "gitlane@example.test");
}

#[test]
fn ancestor_refs_orders_the_nearest_branch_first() {
    let tmp = stack_repo("ancestors");
    let found = super::super::range::ancestor_refs(
        tmp.path().to_str().unwrap(),
        "upper",
        &[
            "main".to_string(),
            "lower".to_string(),
            "does-not-exist".to_string(),
        ],
    )
    .unwrap();

    // `lower` is one commit back, `main` three — the branch actually cut from
    // sorts first, and an unresolvable candidate is skipped, not fatal. The
    // distance itself is not reported; the order is the whole answer.
    assert_eq!(found, vec!["lower".to_string(), "main".to_string()]);
}

#[test]
fn ancestor_refs_excludes_the_head_and_its_equals() {
    let tmp = stack_repo("ancestors-self");
    let path = tmp.path().to_str().unwrap();
    let repo = Repository::open(path).unwrap();
    // A second name for the same commit — an open pull request on an identical
    // tip must not be offered as a base, because that PR would be empty.
    let upper = repo
        .revparse_single("upper")
        .unwrap()
        .peel_to_commit()
        .unwrap();
    repo.branch("alias", &upper, true).unwrap();

    let found = super::super::range::ancestor_refs(
        path,
        "upper",
        &["upper".to_string(), "alias".to_string()],
    )
    .unwrap();
    assert!(found.is_empty());
}

#[test]
fn default_base_branch_prefers_the_gh_merge_base_override() {
    let tmp = stack_repo("default-base");
    let path = tmp.path().to_str().unwrap();
    let repo = Repository::open(path).unwrap();
    repo.remote("origin", "https://example.test/o/r.git")
        .unwrap();
    repo.reference(
        "refs/remotes/origin/main",
        repo.revparse_single("main").unwrap().id(),
        true,
        "",
    )
    .unwrap();
    repo.reference_symbolic(
        "refs/remotes/origin/HEAD",
        "refs/remotes/origin/main",
        true,
        "",
    )
    .unwrap();

    // Without an override, the remote's recorded default branch wins.
    assert_eq!(
        super::super::range::default_base_branch(path, "upper").unwrap(),
        Some("main".to_string())
    );

    // `gh pr create` honours this per-branch config above the default branch,
    // so a branch configured for a stack keeps targeting its layer.
    repo.config()
        .unwrap()
        .set_str("branch.upper.gh-merge-base", "lower")
        .unwrap();
    assert_eq!(
        super::super::range::default_base_branch(path, "upper").unwrap(),
        Some("lower".to_string())
    );
}

#[test]
fn default_base_branch_is_unknown_without_a_remote_head() {
    // A repo with no remote — or one whose HEAD was never written, as after a
    // bare `git remote add` — has nothing to offer, and says so.
    let tmp = stack_repo("default-base-none");
    assert_eq!(
        super::super::range::default_base_branch(tmp.path().to_str().unwrap(), "upper").unwrap(),
        None
    );
}
