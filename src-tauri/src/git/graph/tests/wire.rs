//! Wire-shape round-trip tests for the `RepoGraph` DTO: the serialized JSON
//! is the contract the frontend paints from, so field presence/absence is
//! asserted here key by key.
//!
//! `wipColor` and `CommitNode.color` were deleted (they always mirrored
//! `wipLane` / `lane`); these tests pin that they stay gone.

use super::support::*;

#[test]
fn serialized_graph_drops_redundant_color_fields() {
    let dir = std::env::temp_dir().join("gitlane-graph-wire-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();
    let c1 = commit_on(&repo, &dir, "HEAD", "a.txt", "v1\n", &[], 100);
    commit_on(&repo, &dir, "HEAD", "a.txt", "v2\n", &[c1], 200);

    let graph = build(&repo, 100).unwrap();
    let value = serde_json::to_value(&graph).unwrap();

    let object = value.as_object().expect("graph serializes to an object");
    assert!(!object.contains_key("wipColor"));
    for commit in object["commits"].as_array().expect("commits array") {
        let commit = commit.as_object().expect("commit object");
        assert!(!commit.contains_key("color"));
        assert!(commit.contains_key("lane"));
    }
    for edge in object["edges"].as_array().expect("edges array") {
        let edge = edge.as_object().expect("edge object");
        assert!(edge.contains_key("color"));
        assert_eq!(edge["color"], edge["toLane"]);
    }
}
