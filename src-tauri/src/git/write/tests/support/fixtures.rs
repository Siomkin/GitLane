//! Prebuilt repository shapes: a squash range, a merged feature, a
//! modify/delete pair, a merge conflict, a seeded clone, and a stash seed.

use super::*;

pub(in crate::git::write::tests) fn tip_range_for_squash(tag: &str) -> (TempRepo, String, String) {
    let (repo, base) = repo_with_base_commit(tag);
    std::fs::write(repo.0.join("f.txt"), "one\n").unwrap();
    repo.git_ok(&["commit", "-q", "-a", "-m", "one"]);
    std::fs::write(repo.0.join("f.txt"), "two\n").unwrap();
    repo.git_ok(&["commit", "-q", "-a", "-m", "two"]);
    let tip = rev_parse(&repo, "HEAD");
    (repo, base, tip)
}

/// Build `base ─ main work ─ M` on `main` where `M` merges a `feature` branch
/// that added `feature.txt` (so `M`'s first parent is the mainline commit with
/// `main.txt`). Returns the repo and the merge commit's sha.
pub(in crate::git::write::tests) fn repo_with_merged_feature(tag: &str) -> (TempRepo, String) {
    let repo = TempRepo::new(tag);
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    // cherry_pick/revert honour repo config and would try to sign under a
    // developer's global commit.gpgsign=true — pin it off for hermetic tests.
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("base.txt"), "base\n").unwrap();
    repo.git_ok(&["add", "base.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "base"]);
    repo.git_ok(&["checkout", "-q", "-b", "feature"]);
    std::fs::write(repo.0.join("feature.txt"), "feature\n").unwrap();
    repo.git_ok(&["add", "feature.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "feature work"]);
    repo.git_ok(&["checkout", "-q", "main"]);
    std::fs::write(repo.0.join("main.txt"), "main\n").unwrap();
    repo.git_ok(&["add", "main.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "main work"]);
    repo.git_ok(&["merge", "-q", "--no-ff", "--no-edit", "feature"]);
    let sha = rev_parse(&repo, "HEAD");
    (repo, sha)
}

/// Build a modify/delete conflict: `base` committed, then HEAD modifies the
/// file while the merged branch deletes it. Returns the repo with the merge
/// stopped on the conflict (stage 2 = ours present, stage 3 = theirs absent).
pub(in crate::git::write::tests) fn modify_delete_repo(tag: &str) -> TempRepo {
    let repo = TempRepo::new(tag);
    repo.git(&["init", "-q", "-b", "main"]);
    repo.git(&["config", "user.email", "t@t.t"]);
    repo.git(&["config", "user.name", "T"]);
    repo.git(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("f.txt"), b"base\n").unwrap();
    repo.git(&["add", "f.txt"]);
    repo.git(&["commit", "-qm", "base"]);
    repo.git(&["checkout", "-q", "-b", "other"]);
    repo.git(&["rm", "-q", "f.txt"]);
    repo.git(&["commit", "-qm", "delete"]);
    repo.git(&["checkout", "-q", "main"]);
    std::fs::write(repo.0.join("f.txt"), b"ours-modified\n").unwrap();
    repo.git(&["commit", "-qam", "modify"]);
    // Merge stops on the modify/delete conflict.
    let _ = repo.git(&["merge", "other"]);
    repo
}

/// Build a content conflict: `base` committed, then `other` and `main` change
/// the same line. Returns the repo with the merge stopped on the conflict.
pub(in crate::git::write::tests) fn merge_conflict_repo(tag: &str) -> TempRepo {
    let repo = TempRepo::new(tag);
    repo.git(&["init", "-q", "-b", "main"]);
    repo.git(&["config", "user.email", "t@t.t"]);
    repo.git(&["config", "user.name", "T"]);
    repo.git(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("f.txt"), b"line1\nbase\nline3\n").unwrap();
    repo.git(&["add", "f.txt"]);
    repo.git(&["commit", "-qm", "base"]);
    repo.git(&["checkout", "-q", "-b", "other"]);
    std::fs::write(repo.0.join("f.txt"), b"line1\ntheirs\nline3\n").unwrap();
    repo.git(&["commit", "-qam", "theirs"]);
    repo.git(&["checkout", "-q", "main"]);
    std::fs::write(repo.0.join("f.txt"), b"line1\nours\nline3\n").unwrap();
    repo.git(&["commit", "-qam", "ours"]);
    // Merge stops on the content conflict in f.txt.
    let _ = repo.git(&["merge", "other"]);
    repo
}

pub(in crate::git::write::tests) fn remote_url(repo: &TempRepo, args: &[&str]) -> String {
    let out = repo.git(args);
    assert!(out.status.success(), "git {args:?} failed");
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// Shared fixture for the pull tests: a seed repo with one commit on `main`
/// and a local clone of it. Returned as (root, seed, clone) — `root` owns the
/// parent temp dir, the other two wrap its subdirectories (their Drop is a
/// no-op after root's cleanup, which `remove_dir_all` tolerates).
pub(in crate::git::write::tests) fn seed_and_clone(tag: &str) -> (TempRepo, TempRepo, TempRepo) {
    let root = TempRepo::new(tag);
    let seed_dir = root.0.join("seed");
    let clone_dir = root.0.join("clone");

    let init = Command::new("git")
        .args(["init", "-q", seed_dir.to_str().unwrap()])
        .output()
        .expect("git init launches");
    assert!(
        init.status.success(),
        "init failed\nstderr:\n{}",
        String::from_utf8_lossy(&init.stderr)
    );
    let seed = TempRepo(seed_dir);
    seed.git_ok(&["config", "user.name", "GitLane Test"]);
    seed.git_ok(&["config", "user.email", "gitlane@example.test"]);
    seed.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(seed.0.join("file.txt"), b"v1\n").unwrap();
    seed.git_ok(&["add", "file.txt"]);
    seed.git_ok(&["commit", "-q", "-m", "seed"]);
    seed.git_ok(&["branch", "-M", "main"]);

    let clone_out = Command::new("git")
        .args(["clone", "-q", seed.path(), clone_dir.to_str().unwrap()])
        .output()
        .expect("git clone launches");
    assert!(
        clone_out.status.success(),
        "clone failed\nstderr:\n{}",
        String::from_utf8_lossy(&clone_out.stderr)
    );
    (root, seed, TempRepo(clone_dir))
}

/// A repo with one commit of `f.txt`, ready for stash churn (GL-117 tests).
pub(in crate::git::write::tests) fn stash_seed_repo(tag: &str) -> TempRepo {
    let repo = TempRepo::new(tag);
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.email", "t@t.t"]);
    repo.git_ok(&["config", "user.name", "T"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("f.txt"), b"base\n").unwrap();
    repo.git_ok(&["add", "f.txt"]);
    repo.git_ok(&["commit", "-qm", "base"]);
    repo
}
