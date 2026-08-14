//! Wire-shape tests for the one-letter status codes: each `ChangeStatus`
//! variant must serialize to the exact letter the frontend's `FileStatus`
//! union names. In particular `"C"` stays Copy and Conflicted — produced only
//! for the `conflicted` bucket — takes its own letter `"X"`, resolving the
//! Copied/Conflicted overload git's own vocabulary has.

use super::support::*;
use crate::git::types::{ChangeStatus, FileChange};

#[test]
fn change_status_serializes_to_the_wire_letters() {
    let cases = [
        (ChangeStatus::Added, "A"),
        (ChangeStatus::Deleted, "D"),
        (ChangeStatus::Modified, "M"),
        (ChangeStatus::Renamed, "R"),
        (ChangeStatus::Copied, "C"),
        (ChangeStatus::Typechange, "T"),
        (ChangeStatus::Untracked, "U"),
        (ChangeStatus::Conflicted, "X"),
    ];
    for (status, letter) in cases {
        let change = FileChange {
            path: "f.txt".to_string(),
            status,
            ..Default::default()
        };
        assert_eq!(serde_json::to_value(&change).unwrap()["status"], letter);
    }
}

#[test]
fn conflicted_bucket_carries_the_dedicated_letter() {
    let dir = std::env::temp_dir().join("gitlane-status-wire-conflict-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();
    let mut cfg = repo.config().unwrap();
    cfg.set_str("user.name", "T").unwrap();
    cfg.set_str("user.email", "t@example.test").unwrap();
    drop(cfg);
    commit(&repo, &dir, "f.txt", "base\n");

    let git = |args: &[&str]| {
        std::process::Command::new("git")
            .args(args)
            .current_dir(&dir)
            .output()
            .expect("git")
    };
    let base_branch = String::from_utf8(git(&["symbolic-ref", "--short", "HEAD"]).stdout)
        .unwrap()
        .trim()
        .to_string();
    git(&["checkout", "-q", "-b", "side"]);
    fs::write(dir.join("f.txt"), "side\n").unwrap();
    git(&["add", "f.txt"]);
    git(&["commit", "-q", "-m", "side"]);
    git(&["checkout", "-q", &base_branch]);
    fs::write(dir.join("f.txt"), "main\n").unwrap();
    git(&["add", "f.txt"]);
    git(&["commit", "-q", "-m", "main"]);
    let merge = git(&["merge", "--no-edit", "side"]);
    assert!(!merge.status.success(), "fixture must conflict");

    let changes = working_changes(dir.to_str().unwrap()).unwrap();
    assert_eq!(changes.conflicted.len(), 1);
    assert_eq!(changes.conflicted[0].status, ChangeStatus::Conflicted);
    let wire = serde_json::to_value(&changes).unwrap();
    assert_eq!(wire["conflicted"][0]["status"], "X");
}
