//! PR patch fetching and the pure unified-diff parser.
//!
//! [`pr_diff`] shells out to `gh pr diff --patch --color never` (transport via
//! [`super::cli`]); [`parser`] is a pure function over the raw patch string,
//! mirroring the `FileDiff` shape libgit2 produces in `status.rs` so the
//! frontend diff renderer is shared.
//!
//! `--patch` output is **format-patch mailbox** format, not a bare unified
//! diff: one `From <sha> Mon Sep 17 00:00:00 2001` message per commit, each
//! with mail headers, the commit body, a `---` separator, and a diffstat
//! before the first `diff --git`. The parser must treat those preamble lines
//! as inert — folded `Subject:` continuations and diffstat rows start with a
//! space and would otherwise read as hunk context.

use super::bounded_output::DIFF_STDOUT_LIMIT;
use super::cli::{repo_selector, run_gh_with_limit};
use super::domain::GithubRepository;
use crate::git::types::FileDiff;

mod parser;
#[cfg(test)]
mod parser_tests;
mod path;

// Re-exported to the `github` module tree so the GitLab REST provider (GL-140)
// can reuse the same battle-tested parser after reconstructing a git patch from
// GitLab's per-file `/diffs` payload.
pub(in crate::git::forge) use parser::parse_unified_diff;

/// Full unified diff of a PR, parsed into per-file [`FileDiff`] so the existing
/// diff viewer renders it unchanged. `gh pr diff --patch` emits format-patch
/// mailbox output: one mail-headed message per commit (see the module docs).
pub fn pr_diff(
    workdir: &str,
    repository: &GithubRepository,
    number: u64,
    token: Option<&str>,
) -> Result<Vec<FileDiff>, String> {
    let num = number.to_string();
    let repo = repo_selector(repository);
    // `--patch` forces the full patch body (not a name-only summary) and
    // `--color never` strips ANSI so the parser sees a clean git patch.
    let args = pr_diff_args(&repo, &num);
    let raw = run_gh_with_limit(workdir, &args, token, DIFF_STDOUT_LIMIT)?;
    Ok(parse_unified_diff(&raw))
}

fn pr_diff_args<'a>(repository: &'a str, number: &'a str) -> Vec<&'a str> {
    vec![
        "pr", "diff", number, "--patch", "--color", "never", "--repo", repository,
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diff_args_target_the_validated_repository_authority() {
        assert_eq!(
            pr_diff_args("ghe.example.test:8443/octo/app", "7"),
            vec![
                "pr",
                "diff",
                "7",
                "--patch",
                "--color",
                "never",
                "--repo",
                "ghe.example.test:8443/octo/app",
            ]
        );
    }
}
