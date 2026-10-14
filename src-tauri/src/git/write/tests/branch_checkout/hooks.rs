//! Remote-branch checkout against `post-checkout` / `post-merge` hooks: the
//! working tree changes once, so each hook runs at most once, against the final
//! commit, and what the hooks print comes back redacted.

#![cfg(unix)]

use super::super::support::*;
use super::behind_remote;

/// Install `post-checkout` and `post-merge` hooks that log their name and
/// arguments, and echo `extra` to stdout.
fn install_hooks(repo: &TempRepo, extra: &str) {
    use std::os::unix::fs::PermissionsExt;
    for name in ["post-checkout", "post-merge"] {
        let hook = repo.0.join(".git/hooks").join(name);
        std::fs::write(
            &hook,
            format!(
                "#!/bin/sh\necho \"{name} $*\" >> \"$(git rev-parse --git-dir)/hooks.log\"\n{extra}\n"
            ),
        )
        .unwrap();
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
}

fn hook_log(repo: &TempRepo) -> Vec<String> {
    std::fs::read_to_string(repo.0.join(".git/hooks.log"))
        .unwrap_or_default()
        .lines()
        .map(str::to_string)
        .collect()
}

#[test]
fn behind_local_branch_runs_post_checkout_once_on_the_final_commit() {
    let (repo, _base, remote_tip) = behind_remote("checkout-hooks-behind");
    install_hooks(&repo, "");

    checkout_remote_branch(repo.path(), "origin", "feature").expect("checkout");

    assert_eq!(rev_parse(&repo, "HEAD"), remote_tip);
    assert_eq!(rev_parse(&repo, "refs/heads/feature"), remote_tip);
    let log = hook_log(&repo);
    assert_eq!(log.len(), 1, "exactly one hook run: {log:?}");
    assert!(log[0].starts_with("post-checkout "), "{log:?}");
    let args: Vec<&str> = log[0].split_whitespace().collect();
    assert_eq!(args[2], remote_tip, "new HEAD is the final commit: {log:?}");
    let reflog = repo.git(&["reflog", "-1", "--format=%gs", "refs/heads/feature"]);
    assert_eq!(
        String::from_utf8_lossy(&reflog.stdout).trim(),
        "checkout remote branch: fast-forward",
        "the ref move says what moved it"
    );
}

#[test]
fn equal_local_branch_runs_post_checkout_once() {
    let (repo, _base, remote_tip) = behind_remote("checkout-hooks-equal");
    repo.git_ok(&["branch", "-f", "feature", &remote_tip]);
    install_hooks(&repo, "");

    checkout_remote_branch(repo.path(), "origin", "feature").expect("checkout");

    assert_eq!(rev_parse(&repo, "HEAD"), remote_tip);
    let log = hook_log(&repo);
    assert_eq!(log.len(), 1, "{log:?}");
    assert!(log[0].starts_with("post-checkout "), "{log:?}");
}

#[test]
fn ahead_local_branch_stays_put_and_runs_post_checkout_once() {
    let (repo, _base, remote_tip) = behind_remote("checkout-hooks-ahead");
    repo.git_ok(&["checkout", "-q", "-b", "scratch", &remote_tip]);
    repo.git_ok(&["commit", "-q", "--allow-empty", "-m", "local ahead"]);
    let local_tip = rev_parse(&repo, "HEAD");
    repo.git_ok(&["branch", "-f", "feature", &local_tip]);
    repo.git_ok(&["checkout", "-q", "main"]);
    install_hooks(&repo, "");

    checkout_remote_branch(repo.path(), "origin", "feature").expect("checkout");

    assert_eq!(rev_parse(&repo, "refs/heads/feature"), local_tip);
    assert_eq!(rev_parse(&repo, "HEAD"), local_tip);
    let log = hook_log(&repo);
    assert_eq!(log.len(), 1, "{log:?}");
    assert!(log[0].starts_with("post-checkout "), "{log:?}");
}

#[test]
fn checked_out_behind_branch_fast_forwards_without_post_checkout() {
    let (repo, _base, remote_tip) = behind_remote("checkout-hooks-current-behind");
    repo.git_ok(&["checkout", "-q", "feature"]);
    install_hooks(&repo, "");

    checkout_remote_branch(repo.path(), "origin", "feature").expect("checkout");

    assert_eq!(rev_parse(&repo, "HEAD"), remote_tip);
    let log = hook_log(&repo);
    assert_eq!(log.len(), 1, "{log:?}");
    assert!(log[0].starts_with("post-merge "), "{log:?}");
}

#[test]
fn checked_out_up_to_date_branch_runs_no_hook() {
    let (repo, _base, remote_tip) = behind_remote("checkout-hooks-current-equal");
    repo.git_ok(&["checkout", "-q", "feature"]);
    repo.git_ok(&["reset", "-q", "--hard", &remote_tip]);
    install_hooks(&repo, "");

    let out = checkout_remote_branch(repo.path(), "origin", "feature").expect("checkout");

    assert_eq!(rev_parse(&repo, "HEAD"), remote_tip);
    assert!(hook_log(&repo).is_empty(), "{:?}", hook_log(&repo));
    assert!(out.is_empty(), "nothing ran, nothing to report: {out:?}");
}

#[test]
fn checkout_returns_only_redacted_hook_output() {
    let (repo, _base, _remote_tip) = behind_remote("checkout-hooks-output");
    // Assembled at runtime so the source carries no literal credential URL
    // for secret scanners to flag; the value is a fake token.
    let userinfo = ["alice", "glpat-FAKE"].join(":");
    install_hooks(
        &repo,
        &format!("echo '[hook] pulled https://{userinfo}@gitlab.example/o/r.git'"),
    );

    let out = checkout_remote_branch(repo.path(), "origin", "feature").expect("checkout");

    assert_eq!(
        out, "[hook] pulled https://alice:***@gitlab.example/o/r.git",
        "only hook output, redacted"
    );
}

#[test]
fn checkout_without_hooks_returns_empty_output() {
    let (repo, _base, _remote_tip) = behind_remote("checkout-hooks-none");

    let out = checkout_remote_branch(repo.path(), "origin", "feature").expect("checkout");
    assert!(out.is_empty(), "git's own switch chatter is quiet: {out:?}");

    let out = checkout(repo.path(), "main", false).expect("local checkout");
    assert!(out.is_empty(), "{out:?}");
}

#[test]
fn leaving_a_detached_head_keeps_the_orphaned_commits_warning() {
    let (repo, _base, _remote_tip) = behind_remote("checkout-hooks-orphan");
    repo.git_ok(&["switch", "-q", "--detach"]);
    repo.git_ok(&["commit", "-q", "--allow-empty", "-m", "orphan"]);

    let out = checkout(repo.path(), "main", false).expect("checkout");

    assert!(
        out.contains("you are leaving 1 commit behind"),
        "git's warning survives: {out:?}"
    );
    assert!(
        !out.contains("Switched to"),
        "routine lines dropped: {out:?}"
    );
    assert!(!out.contains("Previous HEAD position"), "{out:?}");
}
