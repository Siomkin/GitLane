//! Branch reads: the remote each branch reports, its upstream, and the
//! ahead/behind sync state.

use super::support::*;
use crate::git::types::BranchKind;

#[test]
fn branch_info_reports_git_push_remote_precedence() {
    let dir = TempRepo::new("push-remote-precedence");
    let repo = Repository::init(dir.path()).unwrap();
    commit(&repo, "refs/heads/main", "base", &[]);
    repo.set_head("refs/heads/main").unwrap();
    repo.remote("origin", "https://example.test/base.git")
        .unwrap();
    repo.remote("mirror", "https://example.test/mirror.git")
        .unwrap();
    repo.remote("fork", "https://example.test/fork.git")
        .unwrap();
    track(&repo, "main", "origin/main");

    let mut cfg = repo.config().unwrap();
    cfg.set_str("remote.pushDefault", "mirror").unwrap();
    cfg.set_str("branch.main.pushRemote", "fork").unwrap();
    drop(cfg);

    let branch = branches(dir.path().to_str().unwrap())
        .unwrap()
        .into_iter()
        .find(|branch| branch.kind == BranchKind::Local && branch.name == "main")
        .unwrap();
    assert_eq!(branch.upstream_remote.as_deref(), Some("origin"));
    assert_eq!(branch.push_remote.as_deref(), Some("fork"));

    repo.config()
        .unwrap()
        .remove("branch.main.pushRemote")
        .unwrap();
    let branch = branches(dir.path().to_str().unwrap())
        .unwrap()
        .into_iter()
        .find(|branch| branch.kind == BranchKind::Local && branch.name == "main")
        .unwrap();
    assert_eq!(branch.push_remote.as_deref(), Some("mirror"));
}

#[test]
fn branch_info_preserves_local_upstream_and_push_remote() {
    let dir = TempRepo::new("local-push-remote");
    let repo = Repository::init(dir.path()).unwrap();
    let base = commit(&repo, "refs/heads/main", "base", &[]);
    repo.reference("refs/heads/shared", base, true, "seed local upstream")
        .unwrap();
    repo.set_head("refs/heads/main").unwrap();

    let mut cfg = repo.config().unwrap();
    cfg.set_str("branch.main.remote", ".").unwrap();
    cfg.set_str("branch.main.merge", "refs/heads/shared")
        .unwrap();
    drop(cfg);

    let branch = branches(dir.path().to_str().unwrap())
        .unwrap()
        .into_iter()
        .find(|branch| branch.kind == BranchKind::Local && branch.name == "main")
        .unwrap();
    assert_eq!(branch.upstream.as_deref(), Some("shared"));
    assert_eq!(branch.upstream_remote.as_deref(), Some("."));
    assert_eq!(branch.push_remote.as_deref(), Some("."));
}

#[test]
fn branch_info_redacts_credentials_from_url_valued_remote_config() {
    let dir = TempRepo::new("branch-config-secret-redaction");
    let repo = Repository::init(dir.path()).unwrap();
    commit(&repo, "refs/heads/main", "base", &[]);
    repo.set_head("refs/heads/main").unwrap();

    let mut cfg = repo.config().unwrap();
    cfg.set_str(
        "branch.main.remote",
        "https://alice:fetch-secret@example.test/team/repo.git",
    )
    .unwrap();
    cfg.set_str("branch.main.merge", "refs/heads/main").unwrap();
    cfg.set_str(
        "branch.main.pushRemote",
        "https://alice:push-secret@example.test/team/repo.git",
    )
    .unwrap();
    drop(cfg);

    let branch = branches(dir.path().to_str().unwrap())
        .unwrap()
        .into_iter()
        .find(|branch| branch.kind == BranchKind::Local && branch.name == "main")
        .unwrap();
    assert_eq!(
        branch.upstream_remote.as_deref(),
        Some("https://alice:***@example.test/team/repo.git")
    );
    assert_eq!(
        branch.push_remote.as_deref(),
        Some("https://alice:***@example.test/team/repo.git")
    );
    let serialized = serde_json::to_string(&branch).unwrap();
    assert!(!serialized.contains("fetch-secret"));
    assert!(!serialized.contains("push-secret"));
}

#[test]
fn branch_sync_reports_no_remote_and_no_upstream() {
    let dir = TempRepo::new("no-upstream");
    let repo = Repository::init(dir.path()).unwrap();
    let base = commit(&repo, "refs/heads/main", "base", &[]);
    repo.set_head("refs/heads/main").unwrap();

    assert_eq!(
        local_status(&dir, "main"),
        (BranchSyncStatus::NoRemote, None, 0, 0)
    );

    repo.remote("origin", "https://example.test/repo.git")
        .unwrap();
    assert_eq!(
        local_status(&dir, "main"),
        (BranchSyncStatus::NoUpstream, None, 0, 0)
    );

    repo.reference("refs/remotes/origin/main", base, true, "seed remote")
        .unwrap();
    track(&repo, "main", "origin/main");
    assert_eq!(
        local_status(&dir, "main"),
        (BranchSyncStatus::UpToDate, Some("origin/main".into()), 0, 0)
    );
}

#[test]
fn branch_sync_counts_ahead_behind_and_diverged() {
    let dir = TempRepo::new("counts");
    let repo = Repository::init(dir.path()).unwrap();
    repo.remote("origin", "https://example.test/repo.git")
        .unwrap();
    let base = commit(&repo, "refs/heads/main", "base", &[]);
    repo.set_head("refs/heads/main").unwrap();

    repo.reference("refs/remotes/origin/ahead", base, true, "seed remote")
        .unwrap();
    let ahead = commit(&repo, "refs/heads/ahead", "ahead", &[base]);
    assert_ne!(ahead, base);
    track(&repo, "ahead", "origin/ahead");
    assert_eq!(
        local_status(&dir, "ahead"),
        (BranchSyncStatus::Ahead, Some("origin/ahead".into()), 1, 0)
    );

    repo.reference("refs/heads/behind", base, true, "seed local")
        .unwrap();
    let remote_ahead = commit(&repo, "refs/remotes/origin/behind", "remote-ahead", &[base]);
    assert_ne!(remote_ahead, base);
    track(&repo, "behind", "origin/behind");
    assert_eq!(
        local_status(&dir, "behind"),
        (BranchSyncStatus::Behind, Some("origin/behind".into()), 0, 1)
    );

    let local_tip = commit(&repo, "refs/heads/diverged", "local-diverged", &[base]);
    let remote_tip = commit(
        &repo,
        "refs/remotes/origin/diverged",
        "remote-diverged",
        &[base],
    );
    assert_ne!(local_tip, remote_tip);
    track(&repo, "diverged", "origin/diverged");
    assert_eq!(
        local_status(&dir, "diverged"),
        (
            BranchSyncStatus::Diverged,
            Some("origin/diverged".into()),
            1,
            1
        )
    );
}

#[test]
fn branch_sync_keeps_stale_upstream_name_after_remote_ref_is_missing() {
    let dir = TempRepo::new("stale");
    let repo = Repository::init(dir.path()).unwrap();
    repo.remote("origin", "https://example.test/repo.git")
        .unwrap();
    commit(&repo, "refs/heads/main", "base", &[]);
    repo.set_head("refs/heads/main").unwrap();
    track(&repo, "main", "origin/deleted");

    assert_eq!(
        local_status(&dir, "main"),
        (
            BranchSyncStatus::StaleUpstream,
            Some("origin/deleted".into()),
            0,
            0
        )
    );
}

#[test]
fn branch_sync_reports_unknown_when_ahead_behind_cannot_be_computed() {
    let dir = TempRepo::new("unknown");
    let repo = Repository::init(dir.path()).unwrap();
    repo.remote("origin", "https://example.test/repo.git")
        .unwrap();
    let remote = commit(&repo, "refs/remotes/origin/main", "remote", &[]);
    let blob = repo.blob(b"not a commit").unwrap();
    repo.reference("refs/heads/main", blob, true, "broken branch")
        .unwrap();
    assert_ne!(blob, remote);
    track(&repo, "main", "origin/main");

    assert_eq!(
        local_status(&dir, "main"),
        (BranchSyncStatus::Unknown, Some("origin/main".into()), 0, 0)
    );
}

#[test]
fn can_fast_forward_treats_equal_tips_as_up_to_date() {
    let dir = TempRepo::new("ff-equal-tips");
    let repo = Repository::init(dir.path()).unwrap();
    let path = dir.path().to_str().unwrap();

    // `main` and `feature` point at the same commit.
    let base = commit(&repo, "refs/heads/main", "base", &[]);
    repo.set_head("refs/heads/main").unwrap();
    repo.reference("refs/heads/feature", base, true, "seed feature")
        .unwrap();

    // The regression: equal tips are an up-to-date no-op fast-forward, so both
    // directions must report true (previously `graph_descendant_of` returned
    // false for equal oids, hiding Fast-forward for identical branches).
    assert!(can_fast_forward(path, "feature", "main").unwrap());
    assert!(can_fast_forward(path, "main", "feature").unwrap());

    // Advance `main` one commit; `feature` stays behind at `base`.
    let ahead = commit(&repo, "refs/heads/main", "ahead", &[base]);
    assert_ne!(ahead, base);

    // Fast-forwarding `feature` to `main` still works: `main` is a strict
    // descendant of `feature`.
    assert!(can_fast_forward(path, "main", "feature").unwrap());
    // But `feature` (behind) can't be the fast-forward source for `main`.
    assert!(!can_fast_forward(path, "feature", "main").unwrap());
}

#[test]
fn branch_info_serializes_the_wire_shape() {
    // Pins the exact serialized keys/values for one local and one remote
    // branch, so the enum renames ("local"/"remote", the camelCase sync
    // statuses) can never drift from what the TS types expect.
    let local = crate::git::types::BranchInfo {
        name: "main".to_string(),
        kind: BranchKind::Local,
        target: Some("abc".to_string()),
        tip_time: Some(1_000),
        is_head: true,
        upstream: Some("origin/main".to_string()),
        remote: None,
        upstream_remote: Some("origin".to_string()),
        push_remote: Some("origin".to_string()),
        sync: Some(crate::git::types::BranchSyncState {
            status: BranchSyncStatus::Diverged,
            upstream: Some("origin/main".to_string()),
            ahead: 1,
            behind: 2,
        }),
    };
    let wire = serde_json::to_value(&local).unwrap();
    let object = wire.as_object().unwrap();
    let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        [
            "isHead",
            "kind",
            "name",
            "pushRemote",
            "remote",
            "sync",
            "target",
            "tipTime",
            "upstream",
            "upstreamRemote"
        ]
    );
    assert_eq!(wire["kind"], "local");
    assert_eq!(wire["sync"]["status"], "diverged");

    let remote = crate::git::types::BranchInfo {
        name: "origin/feature".to_string(),
        kind: BranchKind::Remote,
        target: None,
        tip_time: None,
        is_head: false,
        upstream: None,
        remote: Some("origin".to_string()),
        upstream_remote: None,
        push_remote: None,
        sync: None,
    };
    let wire = serde_json::to_value(&remote).unwrap();
    assert_eq!(wire["kind"], "remote");
    assert_eq!(wire["sync"], serde_json::Value::Null);

    // Every sync status lands on the exact camelCase word.
    for (status, word) in [
        (BranchSyncStatus::NoRemote, "noRemote"),
        (BranchSyncStatus::NoUpstream, "noUpstream"),
        (BranchSyncStatus::StaleUpstream, "staleUpstream"),
        (BranchSyncStatus::Unknown, "unknown"),
        (BranchSyncStatus::UpToDate, "upToDate"),
        (BranchSyncStatus::Ahead, "ahead"),
        (BranchSyncStatus::Behind, "behind"),
        (BranchSyncStatus::Diverged, "diverged"),
    ] {
        let sync = crate::git::types::BranchSyncState {
            status,
            upstream: None,
            ahead: 0,
            behind: 0,
        };
        assert_eq!(serde_json::to_value(&sync).unwrap()["status"], word);
    }
}
