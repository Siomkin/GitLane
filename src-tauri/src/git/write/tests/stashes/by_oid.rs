//! Addressing a stash by its commit oid rather than a `stash@{n}` index —
//! apply, pop, drop and branch, each surviving a concurrent push that would
//! shift the index under it.

use super::super::support::*;

#[test]
fn stash_apply_by_oid_survives_index_churn() {
    // Apply (unlike pop) leaves the stash on the stack; addressing by oid must
    // still resolve the originally-picked stash after out-of-band churn.
    let repo = stash_seed_repo("stash-oid-apply");

    std::fs::write(repo.0.join("f.txt"), b"one\n").unwrap();
    repo.git_ok(&["stash", "push", "-qm", "one"]);
    let picked = stash_list(repo.path()).expect("list")[0].oid.clone();

    // Out-of-band churn: "one" moves from stash@{0} to stash@{1}.
    std::fs::write(repo.0.join("f.txt"), b"two\n").unwrap();
    repo.git_ok(&["stash", "push", "-qm", "two"]);

    stash_apply(repo.path(), &picked).expect("apply the picked stash by oid");

    let content = std::fs::read_to_string(repo.0.join("f.txt")).unwrap();
    assert_eq!(
        content, "one\n",
        "the picked stash was applied, not stash@{{0}}"
    );
    assert_eq!(
        stash_list(repo.path()).expect("list after apply").len(),
        2,
        "apply must leave both stashes on the stack"
    );
}

#[test]
fn stash_pop_by_oid_survives_index_churn() {
    // GL-117: the user picks a stash from a list snapshot, then another stash
    // lands out-of-band (terminal, sibling worktree) and shifts every
    // `stash@{n}`. Popping by oid must still hit the picked stash.
    let repo = stash_seed_repo("stash-oid-pop");

    std::fs::write(repo.0.join("f.txt"), b"one\n").unwrap();
    repo.git_ok(&["stash", "push", "-qm", "one"]);
    let picked = stash_list(repo.path()).expect("list")[0].oid.clone();

    // Out-of-band churn: "one" moves from stash@{0} to stash@{1}.
    std::fs::write(repo.0.join("f.txt"), b"two\n").unwrap();
    repo.git_ok(&["stash", "push", "-qm", "two"]);

    stash_pop(repo.path(), &picked).expect("pop the picked stash by oid");

    let content = std::fs::read_to_string(repo.0.join("f.txt")).unwrap();
    assert_eq!(
        content, "one\n",
        "the picked stash was applied, not stash@{{0}}"
    );
    let remaining = stash_list(repo.path()).expect("list after pop");
    assert_eq!(remaining.len(), 1, "only the picked stash was dropped");
    assert_eq!(remaining[0].message, "On main: two");
}

#[test]
fn stash_drop_by_oid_survives_index_churn_and_refuses_when_gone() {
    let repo = stash_seed_repo("stash-oid-drop");

    std::fs::write(repo.0.join("f.txt"), b"one\n").unwrap();
    repo.git_ok(&["stash", "push", "-qm", "one"]);
    let picked = stash_list(repo.path()).expect("list")[0].oid.clone();
    std::fs::write(repo.0.join("f.txt"), b"two\n").unwrap();
    repo.git_ok(&["stash", "push", "-qm", "two"]);

    stash_drop(repo.path(), &picked).expect("drop the picked stash by oid");
    let remaining = stash_list(repo.path()).expect("list after drop");
    assert_eq!(remaining.len(), 1);
    assert_eq!(
        remaining[0].message, "On main: two",
        "the newer stash survived"
    );

    // Dropping again: the stash is gone, so the destructive op must refuse
    // rather than fall back to any index.
    let err = stash_drop(repo.path(), &picked).expect_err("second drop refuses");
    assert!(
        err.contains("no longer exists"),
        "error should say the stash is gone: {err}"
    );
}

#[test]
fn stash_branch_by_oid_still_drops_the_stash() {
    // `git stash branch <name> <oid>` would apply but silently SKIP the drop —
    // only a `stash@{n}` reference keeps the drop semantics, so the op resolves
    // the oid to its current index first.
    let repo = stash_seed_repo("stash-oid-branch");

    std::fs::write(repo.0.join("f.txt"), b"one\n").unwrap();
    repo.git_ok(&["stash", "push", "-qm", "one"]);
    let picked = stash_list(repo.path()).expect("list")[0].oid.clone();

    stash_branch(repo.path(), "from-stash", &picked).expect("stash branch by oid");

    let head = repo.git(&["rev-parse", "--abbrev-ref", "HEAD"]);
    assert_eq!(String::from_utf8_lossy(&head.stdout).trim(), "from-stash");
    let content = std::fs::read_to_string(repo.0.join("f.txt")).unwrap();
    assert_eq!(content, "one\n", "the stash was applied on the new branch");
    assert!(
        stash_list(repo.path())
            .expect("list after branch")
            .is_empty(),
        "stash branch must drop the consumed stash"
    );
}
