//! Staging the whole working tree (`git add -A`).

use super::super::support::*;

#[test]
fn stage_all_stages_modifications_additions_and_deletions() {
    let (repo, _base) = repo_with_base_commit("stage-all");
    // A second tracked file so there is something to delete.
    std::fs::write(repo.0.join("gone.txt"), "bye\n").unwrap();
    repo.git_ok(&["add", "gone.txt"]);
    repo.git_ok(&["commit", "-qm", "second"]);

    // -A is the reason this exists: `git add .` would miss the deletion.
    std::fs::write(repo.0.join("f.txt"), "changed\n").unwrap();
    std::fs::write(repo.0.join("brand-new.txt"), "new\n").unwrap();
    std::fs::remove_file(repo.0.join("gone.txt")).unwrap();

    stage_all(repo.path()).expect("stage the whole tree");

    let staged =
        String::from_utf8(repo.git(&["diff", "--cached", "--name-status"]).stdout).unwrap();
    assert!(staged.contains("M\tf.txt"), "modification: {staged}");
    assert!(staged.contains("A\tbrand-new.txt"), "addition: {staged}");
    assert!(staged.contains("D\tgone.txt"), "deletion: {staged}");
    // Nothing may be left behind in the working tree.
    let porcelain = String::from_utf8(repo.git(&["status", "--porcelain"]).stdout).unwrap();
    assert!(
        !porcelain
            .lines()
            .any(|l| l.starts_with(" ") || l.starts_with("??")),
        "everything should be staged, got:\n{porcelain}"
    );
}

#[test]
fn stage_all_on_a_clean_tree_is_a_no_op() {
    let (repo, base) = repo_with_base_commit("stage-all-clean");

    stage_all(repo.path()).expect("staging a clean tree succeeds");

    assert_eq!(rev_parse(&repo, "HEAD"), base);
    assert!(
        repo.git(&["diff", "--cached", "--quiet"]).status.success(),
        "a clean tree must leave an empty index diff"
    );
}

#[test]
fn stage_all_stages_a_file_whose_name_looks_like_an_option() {
    // `add -A` takes no pathspec here, so a dash-leading filename is staged
    // rather than parsed as a flag.
    let (repo, _base) = repo_with_base_commit("stage-all-dash");
    std::fs::write(repo.0.join("--not-a-flag.txt"), "x\n").unwrap();

    stage_all(repo.path()).expect("stage the whole tree");

    let staged = String::from_utf8(repo.git(&["diff", "--cached", "--name-only"]).stdout).unwrap();
    assert!(staged.contains("--not-a-flag.txt"), "got:\n{staged}");
}
