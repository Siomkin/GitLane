//! Classify a failed `git` invocation's output into a [`CommandError`].
//!
//! The write layer keeps its diagnostics as `String`s (produced by `finish`
//! next to the subprocess, already redacted); this is where those strings get
//! their `kind`, `code`, and hook name before crossing IPC. The patterns were
//! ported verbatim from the frontend's former `gitError.ts` classifier so the
//! categories stay identical — the frontend now only formats copy from them.

use std::sync::OnceLock;

use regex::Regex;

use crate::git::types::{CommandError, CommandErrorKind};

fn re(cell: &'static OnceLock<Regex>, pattern: &'static str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("classifier regex is valid"))
}

macro_rules! regex {
    ($name:ident, $pattern:literal) => {
        fn $name() -> &'static Regex {
            static CELL: OnceLock<Regex> = OnceLock::new();
            re(&CELL, $pattern)
        }
    };
}

// Signals that the failure came from a git hook rather than git itself.
regex!(
    hook_hint,
    r"(?i)husky|\.husky/|hook (?:failed|declined|denied)|\b(?:pre-commit|commit-msg|prepare-commit-msg|post-commit|pre-merge-commit|pre-push|pre-rebase)\b"
);
regex!(
    hook_name,
    r"(?i)husky\s*-\s*([\w-]+)\s+(?:hook|script)|\.husky/([\w-]+)|\b(pre-commit|commit-msg|prepare-commit-msg|post-commit|pre-merge-commit|pre-push|pre-rebase)\b"
);
// Package-manager / task-runner scaffolding lines that carry no actionable reason.
regex!(
    noise,
    r"(?i)^(?:yarn run\b|npm\b|pnpm\b|bun\b|> |\$ |info\b|warning\b|Done in\b|\[(?:STARTED|COMPLETED|SKIPPED|FAILED)\])"
);
regex!(
    link,
    r"(?i)Get help:|Visit https?:|yarnpkg\.com|conventional-changelog"
);
regex!(
    epilogue,
    r"(?i)husky\s*-\s*[\w-]+\s+(?:hook|script)\s+(?:failed|declined)|command failed with exit code"
);
regex!(
    credential_prompt_disabled,
    r"(?i)could not read (?:username|password).*terminal prompts disabled|terminal prompts disabled"
);
regex!(ssh_auth_failure, r"(?i)permission denied \(publickey\)");
regex!(ssh_host_key_failure, r"(?i)host key verification failed");
// 403 = reached-but-refused: the credential was accepted but lacks permission.
regex!(http_forbidden, r"(?i)error:? 403|403 forbidden");
regex!(
    remote_unreachable,
    r"(?im)^\s*(?:fatal:|ssh:|remote:\s*(?:error:\s*)?).*(?:could not resolve host|failed to connect|connection (?:timed out|refused)|network is unreachable|no route to host|ssl certificate problem|tls handshake|unable to access .*?: (?:could not resolve host|failed to connect|connection (?:timed out|refused)|network is unreachable|no route to host|ssl certificate problem|tls handshake))"
);
regex!(
    remote_not_found_or_denied,
    r"(?im)^\s*(?:fatal:|remote:\s*(?:error:\s*)?).*(?:project you were looking for could not be found|repository (?:'.*'\s*)?not found|could not read from remote repository|permission to view it)"
);
regex!(
    conflict,
    r"(?m)^(?:CONFLICT \(|Automatic merge failed|error: could not apply |hint: after resolving the conflicts|Resolve all conflicts manually)"
);

/// Stale-lease wording every leased write in this crate ends with (see
/// `write/head.rs`, `identity.rs`, `discard_all.rs`, `reset.rs`).
const STALE_LEASE_MARKERS: &[&str] = &[
    "Refresh and try again.",
    "Refresh and preview again.",
    "changed before this operation",
];

/// True when a git failure is the stranded-/contended-`index.lock` shape
/// (GL-335). Requires contention evidence so a permission-denied
/// "Unable to create …/index.lock" is not treated as stranded.
pub(crate) fn is_index_lock_failure(message: &str) -> bool {
    let text = message.to_ascii_lowercase();
    if !text.contains("index.lock") {
        return false;
    }
    text.contains("file exists")
        || text.contains("could not write index")
        || text.contains("another git process seems to be running")
}

/// The hook that refused the operation, when the output names one.
fn hook_from(text: &str) -> Option<String> {
    let caps = hook_name().captures(text)?;
    (1..=3)
        .filter_map(|i| caps.get(i))
        .map(|m| m.as_str().to_string())
        .next()
}

/// The hook's own reason lines, with task-runner scaffolding removed.
fn hook_reasons(text: &str) -> Vec<String> {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .filter(|line| {
            !noise().is_match(line) && !link().is_match(line) && !epilogue().is_match(line)
        })
        .map(str::to_string)
        .collect()
}

/// Classify a failed git diagnostic. Precedence mirrors the former frontend
/// classifier: transport auth/network first (those patterns are anchored on
/// `fatal:`/`remote:` lines, so hook output mentioning "not found" does not
/// match), then the index lock, then hooks, then GitLane's own stale-lease
/// wording, then conflicts, and finally a plain `git` failure.
pub(crate) fn classify_failure(message: &str) -> CommandError {
    let text = message.replace("\r\n", "\n");
    let text = text.trim();
    if text.is_empty() {
        return CommandError::new(
            CommandErrorKind::Git,
            "The git command failed without any output.",
        );
    }
    if ssh_auth_failure().is_match(text) {
        return CommandError::new(CommandErrorKind::Auth, text).with_code("sshPublickey");
    }
    if http_forbidden().is_match(text) {
        return CommandError::new(CommandErrorKind::Auth, text).with_code("forbidden");
    }
    if credential_prompt_disabled().is_match(text) {
        return CommandError::new(CommandErrorKind::Auth, text).with_code("credentialsMissing");
    }
    if ssh_host_key_failure().is_match(text) {
        return CommandError::new(CommandErrorKind::Network, text).with_code("sshHostKey");
    }
    if remote_unreachable().is_match(text) {
        return CommandError::new(CommandErrorKind::Network, text).with_code("unreachable");
    }
    if remote_not_found_or_denied().is_match(text) {
        return CommandError::new(CommandErrorKind::Auth, text).with_code("notFoundOrDenied");
    }
    if is_index_lock_failure(text) {
        return CommandError::new(CommandErrorKind::IndexLock, text);
    }
    if hook_hint().is_match(text) {
        let hook = hook_from(text);
        let reasons = hook_reasons(text);
        let message = if reasons.is_empty() {
            text.to_string()
        } else {
            reasons.join("\n")
        };
        return CommandError {
            kind: CommandErrorKind::HookRejected,
            code: None,
            message,
            detail: Some(text.to_string()),
            hook,
            path: None,
        };
    }
    if STALE_LEASE_MARKERS
        .iter()
        .any(|marker| text.contains(marker))
    {
        return CommandError::new(CommandErrorKind::StaleLease, text);
    }
    if conflict().is_match(text) {
        return CommandError::new(CommandErrorKind::Conflict, text);
    }
    // `init_in_place` on a path that already has a `.git` (lifecycle/init.rs):
    // the missing-repo screen treats that as "just open it" rather than a failure.
    if text.contains("is already a Git repository") {
        return CommandError::new(CommandErrorKind::Git, text).with_code("alreadyARepository");
    }
    CommandError::new(CommandErrorKind::Git, text)
}

#[cfg(test)]
mod tests {
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
}
