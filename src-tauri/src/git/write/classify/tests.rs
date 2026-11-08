use super::*;

// The real output GitLane got back from a rejected squash commit (husky
// pre-commit lint-staged + commit-msg commitlint), newlines intact.
const COMMITLINT_BLOB: &str = "yarn run v1.22.22
$ /repo/node_modules/.bin/lint-staged
[STARTED] Backing up original state...
[COMPLETED] Backed up original state in git stash (9e1de43)
[STARTED] Running tasks for staged files...
[COMPLETED] Running tasks for staged files...
[STARTED] Cleaning up temporary files...
[COMPLETED] Cleaning up temporary files...
Done in 1.90s.
yarn run v1.22.22
$ /repo/node_modules/.bin/commitlint --edit .git/COMMIT_EDITMSG
✖   input: Commit subject may not be empty [subject-empty]
✖   type may not be empty [type-empty]
✖   found 2 problems, 0 warnings
ⓘ   Get help: https://github.com/conventional-changelog/commitlint/#what-is-commitlint
error Command failed with exit code 1.
info Visit https://yarnpkg.com/en/docs/cli/run for documentation about this command.
husky - commit-msg script failed (code 1)";

#[test]
fn hook_rejection_names_the_hook_and_keeps_only_reason_lines() {
    let error = classify_failure(COMMITLINT_BLOB);
    assert_eq!(error.kind, CommandErrorKind::HookRejected);
    assert_eq!(error.hook.as_deref(), Some("commit-msg"));
    assert!(error
        .message
        .contains("Commit subject may not be empty [subject-empty]"));
    assert!(error.message.contains("type may not be empty [type-empty]"));
    for noise in [
        "yarn run",
        "lint-staged",
        "[COMPLETED]",
        "Done in",
        "Get help:",
        "Command failed with exit code",
        "husky - commit-msg script failed",
    ] {
        assert!(
            !error.message.contains(noise),
            "message kept noise {noise:?}"
        );
    }
    assert_eq!(error.detail.as_deref(), Some(COMMITLINT_BLOB));
}

#[test]
fn hook_rejection_with_only_noise_keeps_the_raw_text() {
    let error = classify_failure("husky - pre-commit script failed (code 1)");
    assert_eq!(error.kind, CommandErrorKind::HookRejected);
    assert_eq!(error.hook.as_deref(), Some("pre-commit"));
    assert_eq!(error.message, "husky - pre-commit script failed (code 1)");
}

#[test]
fn hook_output_mentioning_not_found_is_still_a_hook_rejection() {
    let error = classify_failure(
        "husky - pre-push hook exited\nrepository not found in generated metadata",
    );
    assert_eq!(error.kind, CommandErrorKind::HookRejected);
    assert_eq!(error.hook.as_deref(), Some("pre-push"));
}

#[test]
fn ordinary_git_errors_are_git_kind_and_trimmed() {
    let error =
        classify_failure("  error: pathspec 'nope' did not match any file(s) known to git  ");
    assert_eq!(error.kind, CommandErrorKind::Git);
    assert_eq!(
        error.message,
        "error: pathspec 'nope' did not match any file(s) known to git"
    );
    assert!(error.detail.is_none());
}

#[test]
fn empty_output_gets_a_message() {
    let error = classify_failure("");
    assert_eq!(error.kind, CommandErrorKind::Git);
    assert_eq!(error.message, "The git command failed without any output.");
}

#[test]
fn credential_prompt_disabled_is_auth() {
    let error = classify_failure(
        "bucket:\nfatal: could not read Password for 'https://test-user@bitbucket.org': terminal prompts disabled",
    );
    assert_eq!(error.kind, CommandErrorKind::Auth);
    assert_eq!(error.code.as_deref(), Some("credentialsMissing"));
}

#[test]
fn github_401_is_credentials_rejected() {
    let error = classify_failure(
        "origin:\nremote: Invalid username or token. Password authentication is not supported for Git operations.\nfatal: Authentication failed for 'https://github.com/Siomkin/GitLane/'",
    );
    assert_eq!(error.kind, CommandErrorKind::Auth);
    assert_eq!(error.code.as_deref(), Some("credentialsRejected"));
    let bare = classify_failure("fatal: Authentication failed for 'https://example.com/o/r.git/'");
    assert_eq!(bare.code.as_deref(), Some("credentialsRejected"));
}

#[test]
fn prompts_disabled_stays_missing_and_403_stays_forbidden() {
    let missing = classify_failure(
        "fatal: could not read Password for 'https://siomkin@github.com': terminal prompts disabled",
    );
    assert_eq!(missing.code.as_deref(), Some("credentialsMissing"));
    let forbidden = classify_failure(
        "remote: Permission to Siomkin/GitLane.git denied to Siomkin.\nfatal: unable to access 'https://github.com/Siomkin/GitLane.git/': The requested URL returned error: 403",
    );
    assert_eq!(forbidden.kind, CommandErrorKind::Auth);
    assert_eq!(forbidden.code.as_deref(), Some("forbidden"));
    let ssh = classify_failure(
        "ERROR: Permission to Siomkin/GitLane.git denied to Siomkin.\nfatal: Could not read from remote repository.",
    );
    assert_eq!(ssh.kind, CommandErrorKind::Auth);
    assert_eq!(ssh.code.as_deref(), Some("forbidden"));
}

#[test]
fn ssh_publickey_is_auth_and_host_key_is_network() {
    let ssh = classify_failure(
        "origin:\ngit@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.",
    );
    assert_eq!(ssh.kind, CommandErrorKind::Auth);
    assert_eq!(ssh.code.as_deref(), Some("sshPublickey"));
    let host = classify_failure(
        "Host key verification failed.\nfatal: Could not read from remote repository.",
    );
    assert_eq!(host.kind, CommandErrorKind::Network);
    assert_eq!(host.code.as_deref(), Some("sshHostKey"));
}

#[test]
fn forbidden_and_not_found_are_auth() {
    let forbidden = classify_failure(
        "fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 403",
    );
    assert_eq!(forbidden.kind, CommandErrorKind::Auth);
    assert_eq!(forbidden.code.as_deref(), Some("forbidden"));
    let not_found = classify_failure(
        "remote:\nremote: ERROR: The project you were looking for could not be found or you don't have permission to view it.",
    );
    assert_eq!(not_found.kind, CommandErrorKind::Auth);
    assert_eq!(not_found.code.as_deref(), Some("notFoundOrDenied"));
}

#[test]
fn unreachable_host_is_network() {
    let error = classify_failure(
        "fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com",
    );
    assert_eq!(error.kind, CommandErrorKind::Network);
    assert_eq!(error.code.as_deref(), Some("unreachable"));
}

#[test]
fn stranded_index_lock_is_index_lock_but_permission_denied_is_not() {
    let stranded = classify_failure(
        "fatal: Unable to create '/repo/.git/index.lock': File exists.\n\nAnother git process seems to be running in this repository, or the lock file may be stale.",
    );
    assert_eq!(stranded.kind, CommandErrorKind::IndexLock);
    let unwritable = classify_failure("could not write index\nindex.lock");
    assert_eq!(unwritable.kind, CommandErrorKind::IndexLock);
    let not_a_repo = classify_failure("fatal: not a git repository");
    assert_ne!(not_a_repo.kind, CommandErrorKind::IndexLock);
    let denied =
        classify_failure("fatal: Unable to create '/repo/.git/index.lock': Permission denied");
    assert_eq!(denied.kind, CommandErrorKind::Git);
    let ref_lock = classify_failure(
        "error: cannot lock ref 'refs/remotes/origin/x': Unable to create '/repo/.git/refs/remotes/origin/x.lock': File exists.",
    );
    assert_eq!(ref_lock.kind, CommandErrorKind::Git);
}

#[test]
fn stale_lease_wording_is_stale_lease() {
    let error = classify_failure("main changed from abc to def. Refresh and try again.");
    assert_eq!(error.kind, CommandErrorKind::StaleLease);
    let identity = classify_failure(
        "The repository identity changed before this operation. Refresh and try again.",
    );
    assert_eq!(identity.kind, CommandErrorKind::StaleLease);
    let built = classify_failure(&stale("The worktree gained new changes."));
    assert_eq!(built.kind, CommandErrorKind::StaleLease);
}

/// Messages under `write/` that say "again" but are not an exact-state
/// lease going stale (a preview racing its own capture, a path the user
/// must move, a partial success).
const NOT_A_LEASE: &[&str] = &[
    "The working tree changed while GitLane was preparing the discard preview. Try again.",
    "The repository changed while GitLane was preparing the hard-reset preview. Try again.",
    "Hard reset requires '{source}' to already be checked out. Check it out, then preview again.",
    "Refusing to hard-reset while non-file worktree path {label} is present (type {kind}, mode {mode:o}). Move it aside and try again.",
    "Refusing to discard non-file worktree path {label} (type {kind}, mode {mode:o}). Move the directory or nested repository aside and try again.",
    "Removed worktree {from_worktree_path}, but preserved branch {branch} because it came into use elsewhere: {error}.{abort_note} Refresh before trying again.",
];

/// Every lease message must reach the frontend as `staleLease`, so any
/// "…again" string literal in the write layer's production code either
/// ends with [`STALE_SUFFIX`] (spelled out, or through [`stale`]) or is
/// listed in [`NOT_A_LEASE`].
#[test]
fn every_again_message_under_write_is_a_stale_lease() {
    fn walk(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                if path.file_name().is_some_and(|name| name != "tests") {
                    walk(&path, out);
                }
            } else if path.extension().is_some_and(|ext| ext == "rs") {
                out.push(path);
            }
        }
    }
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/git/write");
    let mut files = Vec::new();
    walk(&root, &mut files);
    let literal = regex::Regex::new(r#""((?:[^"\\]|\\.)*)""#).unwrap();
    let again = regex::Regex::new(r"(?i)\bagain\b").unwrap();
    let mut missed = Vec::new();
    for file in files {
        let source = std::fs::read_to_string(&file).unwrap();
        let production = source.split("#[cfg(test)]\nmod tests").next().unwrap();
        for line in production.lines() {
            if line.trim_start().starts_with("//") {
                continue;
            }
            for capture in literal.captures_iter(line) {
                let text = &capture[1];
                if !again.is_match(text) || NOT_A_LEASE.contains(&text) {
                    continue;
                }
                if classify_failure(text).kind != CommandErrorKind::StaleLease {
                    missed.push(format!("{}: {text}", file.display()));
                }
            }
        }
    }
    assert!(
        missed.is_empty(),
        "lease messages that classify as not stale:\n{}",
        missed.join("\n")
    );
}

#[test]
fn merge_conflict_output_is_conflict() {
    let error = classify_failure(
        "Auto-merging a.txt\nCONFLICT (content): Merge conflict in a.txt\nAutomatic merge failed; fix conflicts and then commit the result.",
    );
    assert_eq!(error.kind, CommandErrorKind::Conflict);
    let cherry = classify_failure(
        "error: could not apply 1234abc... feat\nhint: after resolving the conflicts, mark the corrected paths",
    );
    assert_eq!(cherry.kind, CommandErrorKind::Conflict);
}

#[test]
fn hook_words_in_paths_and_subjects_do_not_hide_conflicts_or_stale_leases() {
    for conflicted in [
        "Auto-merging .pre-commit-config.yaml\nCONFLICT (content): Merge conflict in .pre-commit-config.yaml\nAutomatic merge failed; fix conflicts and then commit the result.",
        "CONFLICT (content): Merge conflict in .husky/pre-push\nAutomatic merge failed; fix conflicts and then commit the result.",
        "error: could not apply 1234abc... chore: bump husky\nhint: after resolving the conflicts, mark the corrected paths",
    ] {
        let error = classify_failure(conflicted);
        assert_eq!(error.kind, CommandErrorKind::Conflict, "{conflicted}");
        assert!(error.hook.is_none());
    }
    let stale = classify_failure(&stale("feature/pre-push-hook changed from abc to def."));
    assert_eq!(stale.kind, CommandErrorKind::StaleLease);
}

#[test]
fn a_genuine_husky_rejection_is_still_a_hook_rejection() {
    let error = classify_failure(
        "husky - pre-commit hook failed (add --no-verify to bypass)\nlint-staged failed",
    );
    assert_eq!(error.kind, CommandErrorKind::HookRejected);
    assert_eq!(error.hook.as_deref(), Some("pre-commit"));
}

#[test]
fn init_on_an_existing_repository_gets_its_code() {
    let error = classify_failure("/r is already a Git repository — try Retry to open it.");
    assert_eq!(error.kind, CommandErrorKind::Git);
    assert_eq!(error.code.as_deref(), Some("alreadyARepository"));
}

#[test]
fn crlf_output_is_normalised_before_matching() {
    let error = classify_failure("husky - pre-push hook exited\r\nrefusing to push\r\n");
    assert_eq!(error.kind, CommandErrorKind::HookRejected);
    assert_eq!(
        error.message,
        "husky - pre-push hook exited\nrefusing to push"
    );
}
