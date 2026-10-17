//! `state_lease` helpers every lease shares: HEAD's branch/oid, the effective
//! HEAD tree, and the replace-ref refusal.

use super::super::state_lease::{
    discover_scope, effective_head_tree_oid, ensure_no_replace_refs, head_state, LeaseError,
};
use super::support::*;

fn head_of(repo: &TempRepo) -> (Option<String>, Option<String>) {
    let (repository, _) = discover_scope(repo.path()).expect("scope");
    head_state(&repository).expect("head state")
}

#[test]
fn head_state_reads_the_branch_and_its_tip() {
    let (repo, base) = repo_with_base_commit("lease-head-branch");

    assert_eq!(head_of(&repo), (Some("main".to_string()), Some(base)));
}

#[test]
fn head_state_reports_a_detached_head_without_a_branch() {
    let (repo, base) = repo_with_base_commit("lease-head-detached");
    repo.git_ok(&["checkout", "-q", "--detach"]);

    assert_eq!(head_of(&repo), (None, Some(base)));
}

#[test]
fn head_state_tolerates_an_unborn_branch() {
    let repo = TempRepo::new("lease-head-unborn");
    repo.git_ok(&["init", "-q", "-b", "fresh"]);

    assert_eq!(head_of(&repo), (Some("fresh".to_string()), None));
}

#[test]
fn head_state_refuses_a_head_outside_refs_heads() {
    let (repo, _) = repo_with_base_commit("lease-head-outside");
    repo.git_ok(&["update-ref", "refs/remotes/origin/main", "HEAD"]);
    repo.git_ok(&["symbolic-ref", "HEAD", "refs/remotes/origin/main"]);
    let (repository, _) = discover_scope(repo.path()).expect("scope");

    let err = head_state(&repository).expect_err("HEAD outside refs/heads");

    assert!(
        matches!(&err, LeaseError::Worded(message) if message.contains("outside refs/heads")),
        "{err:?}"
    );
}

#[test]
fn effective_head_tree_is_heads_tree_and_absent_when_unborn() {
    let (repo, base) = repo_with_base_commit("lease-head-tree");
    let (_, scope) = discover_scope(repo.path()).expect("scope");

    assert_eq!(
        effective_head_tree_oid(&scope, Some(&base)).expect("tree"),
        Some(rev_parse(&repo, "HEAD^{tree}"))
    );
    assert_eq!(
        effective_head_tree_oid(&scope, None).expect("no head"),
        None
    );
}

#[test]
fn replace_refs_block_the_lease() {
    let (repo, base) = repo_with_base_commit("lease-replace-refs");
    let (_, scope) = discover_scope(repo.path()).expect("scope");
    ensure_no_replace_refs(&scope).expect("no replace refs yet");

    repo.git_ok(&["commit", "-q", "--allow-empty", "-m", "stand-in"]);
    let stand_in = rev_parse(&repo, "HEAD");
    repo.git_ok(&["replace", &base, &stand_in]);

    assert!(matches!(
        ensure_no_replace_refs(&scope),
        Err(LeaseError::ReplaceRefsActive)
    ));
}
