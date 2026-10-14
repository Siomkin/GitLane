//! `branch_checkout` write-path tests, split by what they exercise.

use super::support::*;

mod blocked;
mod equivalent;
mod hooks;
mod refuses;
mod tracking;

/// `main` at `base`, local `feature` at `base`, `origin/feature` one commit
/// ahead. Returns (repo, base, remote tip).
pub(super) fn behind_remote(name: &str) -> (TempRepo, String, String) {
    let repo = TempRepo::new(name);
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("tracked.txt"), "base\n").unwrap();
    repo.git_ok(&["add", "tracked.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "base"]);
    let base = rev_parse(&repo, "HEAD");
    repo.git_ok(&["branch", "feature"]);
    std::fs::write(repo.0.join("tracked.txt"), "remote\n").unwrap();
    repo.git_ok(&["commit", "-q", "-am", "remote work"]);
    let remote_tip = rev_parse(&repo, "HEAD");
    repo.git_ok(&["remote", "add", "origin", "https://example.test/repo.git"]);
    repo.git_ok(&["update-ref", "refs/remotes/origin/feature", &remote_tip]);
    repo.git_ok(&["reset", "-q", "--hard", &base]);
    (repo, base, remote_tip)
}
