//! Stashing an explicit path set.

use super::super::support::*;

#[test]
fn stash_paths_stashes_one_file_and_leaves_siblings() {
    let repo = stash_seed_repo("stash-one-path");
    // Tracked edit on f.txt + two untracked siblings.
    std::fs::write(repo.0.join("f.txt"), b"edited\n").unwrap();
    std::fs::write(repo.0.join("keep.txt"), b"keep\n").unwrap();
    std::fs::write(repo.0.join("only-me.txt"), b"stash me\n").unwrap();

    let message =
        stash_paths(repo.path(), &["f.txt".into(), "only-me.txt".into()]).expect("pathspec stash");
    assert!(
        message.contains("Stashed"),
        "expected a short success toast, got {message}"
    );

    assert_eq!(
        std::fs::read_to_string(repo.0.join("f.txt")).unwrap(),
        "base\n",
        "tracked pathspec must restore HEAD for the stashed path"
    );
    assert_eq!(
        std::fs::read_to_string(repo.0.join("keep.txt")).unwrap(),
        "keep\n",
        "sibling untracked files must stay put"
    );
    assert!(!repo.0.join("only-me.txt").exists());

    let oid = stash_list(repo.path()).expect("list")[0].oid.clone();
    stash_apply(repo.path(), &oid).expect("restore pathspec stash");
    assert_eq!(
        std::fs::read_to_string(repo.0.join("f.txt")).unwrap(),
        "edited\n"
    );
    assert_eq!(
        std::fs::read_to_string(repo.0.join("only-me.txt")).unwrap(),
        "stash me\n"
    );
}

#[test]
fn stash_paths_accepts_a_leading_dash_filename() {
    let repo = stash_seed_repo("stash-dash-name");
    std::fs::write(repo.0.join("-notes.txt"), b"secret notes\n").unwrap();

    let message = stash_paths(repo.path(), &["-notes.txt".into()]).expect("dash pathspec");
    assert!(message.contains("Stashed"), "got {message}");
    assert!(!repo.0.join("-notes.txt").exists());
}
