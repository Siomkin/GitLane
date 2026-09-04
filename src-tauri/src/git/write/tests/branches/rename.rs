//! Renaming a branch: the ref actually moves, and `-m` never clobbers.

use super::super::support::*;

#[test]
fn rename_branch_moves_the_ref_and_keeps_its_tip() {
    let (repo, base) = repo_with_base_commit("rename-branch");
    create_branch(repo.path(), "topic", "refs/heads/main", &base).expect("create the branch");

    rename_branch(repo.path(), "topic", "feature").expect("rename the branch");

    assert_eq!(rev_parse(&repo, "refs/heads/feature"), base);
    assert!(
        repo.git(&["rev-parse", "--verify", "refs/heads/topic"])
            .status
            .code()
            != Some(0),
        "the old name must be gone, not left as a second ref"
    );
}

#[test]
fn rename_branch_carries_the_upstream_config_over() {
    let (repo, base) = repo_with_base_commit("rename-branch-upstream");
    repo.git_ok(&["update-ref", "refs/remotes/origin/topic", &base]);
    create_branch(repo.path(), "topic", "refs/remotes/origin/topic", &base)
        .expect("create with tracking");

    rename_branch(repo.path(), "topic", "feature").expect("rename the branch");

    // git moves branch.<name>.* with the rename; losing it would silently
    // detach the branch from its remote.
    assert_eq!(
        String::from_utf8_lossy(&repo.git(&["config", "branch.feature.remote"]).stdout).trim(),
        "origin"
    );
}

#[test]
fn rename_branch_refuses_to_overwrite_an_existing_branch() {
    // `-m` (not `-M`) is the whole point: a rename must never silently clobber
    // another branch's ref, which would lose whatever it pointed at.
    let (repo, base) = repo_with_base_commit("rename-branch-clobber");
    create_branch(repo.path(), "topic", "refs/heads/main", &base).expect("create the source");
    repo.git_ok(&["commit", "-q", "--allow-empty", "-m", "other"]);
    let other = rev_parse(&repo, "HEAD");
    create_branch(repo.path(), "taken", "refs/heads/main", &other).expect("create the target");

    assert!(
        rename_branch(repo.path(), "topic", "taken").is_err(),
        "renaming onto an existing branch must fail closed"
    );
    assert_eq!(
        rev_parse(&repo, "refs/heads/taken"),
        other,
        "the branch that was in the way keeps its tip"
    );
    assert_eq!(rev_parse(&repo, "refs/heads/topic"), base);
}

#[test]
fn rename_branch_rejects_option_like_operands() {
    let repo = TempRepo::new("rename-branch-inj");
    repo.git(&["init", "-q"]);

    // Both operands reach git unprefixed, so a leading dash must be refused
    // before the subprocess runs — `-D` would delete rather than rename.
    assert!(rename_branch(repo.path(), "-D", "feature").is_err());
    assert!(rename_branch(repo.path(), "topic", "--force").is_err());
}
