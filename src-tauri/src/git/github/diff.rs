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

use super::cli::run_gh;
use crate::git::types::FileDiff;

mod parser;
#[cfg(test)]
mod parser_tests;
mod path;

// Re-exported to the `github` module tree so the GitLab REST provider (GL-140)
// can reuse the same battle-tested parser after reconstructing a git patch from
// GitLab's per-file `/diffs` payload.
pub(in crate::git::github) use parser::parse_unified_diff;

/// Full unified diff of a PR, parsed into per-file [`FileDiff`] so the existing
/// diff viewer renders it unchanged. `gh pr diff --patch` emits format-patch
/// mailbox output: one mail-headed message per commit (see the module docs).
pub fn pr_diff(workdir: &str, number: u64, token: Option<&str>) -> Result<Vec<FileDiff>, String> {
    let num = number.to_string();
    // `--patch` forces the full patch body (not a name-only summary) and
    // `--color never` strips ANSI so the parser sees a clean git patch.
    let raw = run_gh(
        workdir,
        &["pr", "diff", num.as_str(), "--patch", "--color", "never"],
        token,
    )?;
    Ok(parse_unified_diff(&raw))
}
