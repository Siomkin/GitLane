use super::branches::{branches, can_fast_forward};
use git2::{Oid, Repository, Signature};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

struct TempRepo(PathBuf);
impl TempRepo {
    fn new(tag: &str) -> Self {
        static SEQ: AtomicU32 = AtomicU32::new(0);
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir =
            std::env::temp_dir().join(format!("gitlane-read-{tag}-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        TempRepo(dir)
    }
    fn path(&self) -> &Path {
        &self.0
    }
}
impl Drop for TempRepo {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn commit(repo: &Repository, update_ref: &str, message: &str, parents: &[Oid]) -> Oid {
    let blob = repo.blob(message.as_bytes()).unwrap();
    let mut builder = repo.treebuilder(None).unwrap();
    builder
        .insert(format!("{message}.txt"), blob, 0o100644)
        .unwrap();
    let tree_id = builder.write().unwrap();
    let tree = repo.find_tree(tree_id).unwrap();
    let sig = Signature::now("GitLane", "gitlane@example.test").unwrap();
    let parent_commits = parents
        .iter()
        .map(|oid| repo.find_commit(*oid).unwrap())
        .collect::<Vec<_>>();
    let parent_refs = parent_commits.iter().collect::<Vec<_>>();
    repo.commit(Some(update_ref), &sig, &sig, message, &tree, &parent_refs)
        .unwrap()
}

fn track(repo: &Repository, branch: &str, upstream: &str) {
    let (remote, merge) = upstream.split_once('/').unwrap();
    let mut cfg = repo.config().unwrap();
    cfg.set_str(&format!("branch.{branch}.remote"), remote)
        .unwrap();
    cfg.set_str(
        &format!("branch.{branch}.merge"),
        &format!("refs/heads/{merge}"),
    )
    .unwrap();
}

fn local_status(repo: &TempRepo, branch: &str) -> (String, Option<String>, usize, usize) {
    let list = branches(repo.path().to_str().unwrap()).unwrap();
    let info = list
        .into_iter()
        .find(|b| b.kind == "local" && b.name == branch)
        .unwrap();
    let sync = info.sync.unwrap();
    (sync.status, sync.upstream, sync.ahead, sync.behind)
}

#[test]
fn branch_sync_reports_no_remote_and_no_upstream() {
    let dir = TempRepo::new("no-upstream");
    let repo = Repository::init(dir.path()).unwrap();
    let base = commit(&repo, "refs/heads/main", "base", &[]);
    repo.set_head("refs/heads/main").unwrap();

    assert_eq!(local_status(&dir, "main"), ("noRemote".into(), None, 0, 0));

    repo.remote("origin", "https://example.test/repo.git")
        .unwrap();
    assert_eq!(
        local_status(&dir, "main"),
        ("noUpstream".into(), None, 0, 0)
    );

    repo.reference("refs/remotes/origin/main", base, true, "seed remote")
        .unwrap();
    track(&repo, "main", "origin/main");
    assert_eq!(
        local_status(&dir, "main"),
        ("upToDate".into(), Some("origin/main".into()), 0, 0)
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
        ("ahead".into(), Some("origin/ahead".into()), 1, 0)
    );

    repo.reference("refs/heads/behind", base, true, "seed local")
        .unwrap();
    let remote_ahead = commit(&repo, "refs/remotes/origin/behind", "remote-ahead", &[base]);
    assert_ne!(remote_ahead, base);
    track(&repo, "behind", "origin/behind");
    assert_eq!(
        local_status(&dir, "behind"),
        ("behind".into(), Some("origin/behind".into()), 0, 1)
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
        ("diverged".into(), Some("origin/diverged".into()), 1, 1)
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
        ("staleUpstream".into(), Some("origin/deleted".into()), 0, 0)
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
        ("unknown".into(), Some("origin/main".into()), 0, 0)
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
fn worktree_join_rejects_escapes_and_accepts_safe_paths() {
    use super::worktree_join;
    let wd = Path::new("/work/repo");
    // Safe relative paths join under the worktree.
    assert_eq!(worktree_join(wd, "a/b.png").unwrap(), wd.join("a/b.png"));
    assert_eq!(
        worktree_join(wd, "deep/nested/x.bin").unwrap(),
        wd.join("deep/nested/x.bin")
    );
    // Traversal / absolute / drive-prefix paths are rejected.
    assert!(worktree_join(wd, "../escape").is_err());
    assert!(worktree_join(wd, "a/../../escape").is_err());
    assert!(worktree_join(wd, "/etc/hosts").is_err());
}

#[test]
fn summary_flags_an_unborn_head_then_clears_it_after_the_first_commit() {
    use super::repo::summary;
    use git2::RepositoryInitOptions;

    // Fresh `git init`: HEAD points at a branch with no commits. `repo.head()`
    // fails with `UnbornBranch`, which is a real state — not a read failure —
    // so `unborn` must be true and distinguishable from "No branch" (GL-115).
    // Pin the initial branch so the resolved name is deterministic regardless of
    // the host's `init.defaultBranch`.
    let dir = TempRepo::new("unborn-summary");
    let repo = Repository::init_opts(
        dir.path(),
        RepositoryInitOptions::new().initial_head("master"),
    )
    .unwrap();
    let path = dir.path().to_str().unwrap();

    let fresh = summary(path).unwrap();
    assert!(
        fresh.unborn,
        "a repo with no commits reports an unborn HEAD"
    );
    // The unborn branch is resolved from HEAD's symbolic target (GL-115
    // follow-up): a branch *exists*, it just has no commits yet, so downstream
    // consumers can treat it like a checked-out branch instead of "No branch".
    assert_eq!(
        fresh.head_branch.as_deref(),
        Some("master"),
        "unborn HEAD resolves its symbolic target branch name"
    );
    assert_eq!(fresh.head_oid, None, "there is no commit to resolve");
    assert!(!fresh.detached, "unborn is not the same as detached");

    // The first commit is born: HEAD now resolves, so `unborn` clears and the
    // branch name still resolves — now via the born HEAD.
    commit(&repo, "HEAD", "base", &[]);
    let born = summary(path).unwrap();
    assert!(!born.unborn, "a committed repo is no longer unborn");
    assert_eq!(
        born.head_branch.as_deref(),
        Some("master"),
        "the branch name persists once the first commit is born"
    );
    assert!(
        born.head_oid.is_some(),
        "HEAD resolves after the first commit"
    );
}

#[test]
fn summary_reports_linked_worktree_identity() {
    use super::recents::recents_status;
    use super::repo::summary;

    let dir = TempRepo::new("wt-identity");
    let repo = Repository::init(dir.path()).unwrap();
    commit(&repo, "HEAD", "base", &[]);

    // A linked worktree on its own branch, next to (not inside) the main dir.
    let wt_dir = dir.path().parent().unwrap().join(format!(
        "{}-linked",
        dir.path().file_name().unwrap().to_string_lossy()
    ));
    let _ = std::fs::remove_dir_all(&wt_dir);
    repo.worktree("linked", &wt_dir, None).unwrap();

    // Canonicalize both sides: temp paths go through symlinks on macOS
    // (/var → /private/var), and git records the resolved form.
    let canon = |p: &str| std::fs::canonicalize(p).unwrap();

    let main = summary(dir.path().to_str().unwrap()).unwrap();
    assert!(
        !main.is_worktree,
        "the main checkout is not a linked worktree"
    );
    assert_eq!(
        main.main_path, None,
        "the main checkout is its own identity"
    );

    let wt = summary(wt_dir.to_str().unwrap()).unwrap();
    assert!(wt.is_worktree, "a linked worktree reports itself as one");
    assert_eq!(
        canon(
            wt.main_path
                .as_deref()
                .expect("linked worktree has a main path")
        ),
        canon(&main.path),
        "a linked worktree's identity is the main checkout's path"
    );

    // The shared tab/recents probe reports the same identity per path.
    let statuses = recents_status(&[
        wt_dir.to_string_lossy().into_owned(),
        dir.path().to_string_lossy().into_owned(),
    ]);
    assert!(statuses[0].is_worktree);
    assert_eq!(
        canon(statuses[0].main_path.as_deref().unwrap()),
        canon(&main.path)
    );
    assert!(!statuses[1].is_worktree);
    assert_eq!(statuses[1].main_path, None);
    assert_eq!(statuses[0].branch.as_deref(), Some("linked"));

    let _ = std::fs::remove_dir_all(&wt_dir);
}
