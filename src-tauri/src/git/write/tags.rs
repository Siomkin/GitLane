//! Local tag creation and deletion writes.

use super::cli::run_git;
use super::operands::{ensure_operand, ensure_opt};

/// Create a lightweight tag `name` at `sha` (defaults to HEAD). Reads back as a
/// `RefLabel` of kind "tag" on the graph.
///
/// `--no-sign` overrides `tag.gpgsign=true`, which would otherwise upgrade the
/// plain `git tag` to a *signed* (annotated) tag — and, with no `-m`, make git
/// launch an editor for the message inside this GUI subprocess and fail. A
/// lightweight tag carries no message or tagger, so there is nothing to sign.
/// (`--no-sign` needs git ≥ 2.23, well below the 2.43+ this app already
/// assumes elsewhere.)
pub fn create_tag(repo: &str, name: &str, sha: Option<&str>) -> Result<String, String> {
    ensure_operand(name)?;
    ensure_opt(sha)?;
    match sha {
        Some(s) => run_git(repo, &["tag", "--no-sign", name, s]),
        None => run_git(repo, &["tag", "--no-sign", name]),
    }
}

/// Create an annotated tag `name` carrying `message` at `sha` (defaults to HEAD).
/// Unlike a lightweight tag this stores a tagger + message, so it shows up in
/// `git tag -n` and can be GPG-signed by the user's config.
pub fn create_annotated_tag(
    repo: &str,
    name: &str,
    message: &str,
    sha: Option<&str>,
) -> Result<String, String> {
    ensure_operand(name)?;
    ensure_opt(sha)?;
    let _identity_guard = super::identity::lock_identity_config(repo)?;
    let mut args = super::identity::pinned_tag_args(repo)?;
    args.extend([
        "tag".to_string(),
        "-a".to_string(),
        name.to_string(),
        "-m".to_string(),
        message.to_string(),
    ]);
    if let Some(s) = sha {
        args.push(s.to_string());
    }
    let refs = args.iter().map(String::as_str).collect::<Vec<_>>();
    run_git(repo, &refs)
}

/// Delete a local tag only when it still points at `expected_oid`. `update-ref`
/// performs the comparison and deletion atomically, so a tag moved after the
/// UI opened its confirmation cannot be erased accidentally. The tag ref is
/// removed locally only; the remote copy (if any) is untouched — that's
/// [`super::delete_remote_tag`], and while the tag still exists on a remote the
/// next Fetch's `refs/tags/*` import brings it back.
pub fn delete_tag(repo: &str, name: &str, expected_oid: &str) -> Result<String, String> {
    ensure_operand(name)?;
    ensure_operand(expected_oid)?;
    let reference = format!("refs/tags/{name}");
    run_git(repo, &["update-ref", "-d", &reference, expected_oid])?;
    Ok(format!("Deleted tag {name}"))
}
