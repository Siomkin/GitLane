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
// 401 = the server received a credential and rejected it (expired, revoked, wrong owner).
regex!(
    credentials_rejected,
    r"(?im)^\s*(?:fatal:|remote:).*(?:authentication failed|invalid username or (?:password|token))"
);
regex!(ssh_auth_failure, r"(?i)permission denied \(publickey\)");
regex!(ssh_host_key_failure, r"(?i)host key verification failed");
// 403 = reached-but-refused: the credential was accepted but lacks permission.
// GitHub's SSH refusal prints no 403, only `ERROR: Permission to <repo> denied to <login>`.
regex!(
    http_forbidden,
    r"(?im)error:? 403|403 forbidden|^\s*(?:remote:\s*)?(?:error:\s*)?permission to \S+ denied to "
);
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

/// The sentence every exact-state lease failure ends with, and the one thing
/// [`classify_failure`] reads to report `staleLease`. Build lease messages with
/// [`stale`]; a `const` message spells the suffix out (the classify tests pin
/// every `again` literal under `write/` to this kind).
pub(crate) const STALE_SUFFIX: &str = "Refresh and try again.";

/// A stale-lease failure: `reason` followed by [`STALE_SUFFIX`].
pub(crate) fn stale(reason: &str) -> String {
    format!("{reason} {STALE_SUFFIX}")
}

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
/// match), then the index lock, then GitLane's own stale-lease wording and
/// git's conflict markers, then hooks, and finally a plain `git` failure.
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
    if credentials_rejected().is_match(text) {
        return CommandError::new(CommandErrorKind::Auth, text).with_code("credentialsRejected");
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
    // Git-authored, line-anchored markers beat the hook words, which also
    // occur in file and branch names (`.pre-commit-config.yaml`, `.husky/`).
    if text.contains(STALE_SUFFIX) {
        return CommandError::new(CommandErrorKind::StaleLease, text);
    }
    if conflict().is_match(text) {
        return CommandError::new(CommandErrorKind::Conflict, text);
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
            remote_failures: Vec::new(),
            credential_username: None,
        };
    }
    // `init_in_place` on a path that already has a `.git` (lifecycle/init.rs):
    // the missing-repo screen treats that as "just open it" rather than a failure.
    if text.contains("is already a Git repository") {
        return CommandError::new(CommandErrorKind::Git, text).with_code("alreadyARepository");
    }
    CommandError::new(CommandErrorKind::Git, text)
}

#[cfg(test)]
mod tests;
