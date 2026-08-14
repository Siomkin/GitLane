//! Shared fixtures for the read tests: commit and tracking-config builders, a
//! status helper, and the stacked-branch repository.

pub(super) use super::super::branches::{branches, can_fast_forward};
pub(super) use git2::{Oid, Repository, Signature};
pub(super) use std::path::{Path, PathBuf};
pub(super) use std::sync::atomic::{AtomicU32, Ordering};

pub(super) struct TempRepo(pub(super) PathBuf);
impl TempRepo {
    pub(super) fn new(tag: &str) -> Self {
        static SEQ: AtomicU32 = AtomicU32::new(0);
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir =
            std::env::temp_dir().join(format!("gitlane-read-{tag}-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        TempRepo(dir)
    }
    pub(super) fn path(&self) -> &Path {
        &self.0
    }
}
impl Drop for TempRepo {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub(super) fn commit(repo: &Repository, update_ref: &str, message: &str, parents: &[Oid]) -> Oid {
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

pub(super) fn track(repo: &Repository, branch: &str, upstream: &str) {
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

pub(super) fn local_status(
    repo: &TempRepo,
    branch: &str,
) -> (String, Option<String>, usize, usize) {
    let list = branches(repo.path().to_str().unwrap()).unwrap();
    let info = list
        .into_iter()
        .find(|b| b.kind == "local" && b.name == branch)
        .unwrap();
    let sync = info.sync.unwrap();
    (sync.status, sync.upstream, sync.ahead, sync.behind)
}

/// trunk: m1 -> m2, `lower` branches off m2, `upper` branches off `lower`.
pub(super) fn stack_repo(tag: &str) -> TempRepo {
    let tmp = TempRepo::new(tag);
    let repo = Repository::init(tmp.path()).unwrap();
    let m1 = commit(&repo, "refs/heads/main", "m1", &[]);
    let m2 = commit(&repo, "refs/heads/main", "m2", &[m1]);
    let l1 = commit(&repo, "refs/heads/lower", "l1", &[m2]);
    let l2 = commit(&repo, "refs/heads/lower", "l2", &[l1]);
    commit(&repo, "refs/heads/upper", "u1", &[l2]);
    tmp
}
