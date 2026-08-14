//! Small ref reads the previews share.

use super::super::cli::{run_git, run_git_allow_exit_codes};
use super::super::operands::ensure_operand;

/// Push a labelled list as a header line plus one line per item. The confirm
/// dialog renders every detail/warning entry on its own line, so joining a file
/// or commit list into one entry produced an unreadable wrapped paragraph.
pub(in crate::git::write) fn push_list(lines: &mut Vec<String>, label: &str, items: &[String]) {
    lines.push(format!("{label}:"));
    lines.extend(items.iter().cloned());
}

pub(super) fn rev_parse_optional(repo: &str, revision: &str) -> Result<Option<String>, String> {
    ensure_operand(revision)?;
    let oid =
        run_git_allow_exit_codes(repo, &["rev-parse", "--verify", "--quiet", revision], &[1])?
            .trim()
            .to_string();
    Ok((!oid.is_empty()).then_some(oid))
}

pub(super) fn short_oid(oid: &str) -> String {
    oid.chars().take(7).collect()
}

pub(super) fn rev_parse_short(repo: &str, rev: &str) -> Option<String> {
    ensure_operand(rev).ok()?;
    run_git(repo, &["rev-parse", "--short", rev])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

pub(super) fn limited_lines(raw: String, limit: usize) -> Vec<String> {
    let mut lines: Vec<String> = raw
        .lines()
        .filter(|line| !line.trim().is_empty())
        .take(limit + 1)
        .map(|line| line.trim().to_string())
        .collect();
    if lines.len() > limit {
        lines.truncate(limit);
        lines.push("…".to_string());
    }
    lines
}
