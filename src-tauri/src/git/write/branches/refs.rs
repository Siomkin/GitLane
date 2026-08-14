//! Resolving and validating the ref a branch write is about to touch.

use super::super::cli::run_git;
use super::super::operands::ensure_operand;

/// Disambiguate a bare ref that is *both* a local branch and a tag toward the
/// branch by returning `refs/heads/<name>`; otherwise return `name` unchanged.
///
/// Git's rev resolution gives a **tag** precedence over a same-named branch
/// (`gitrevisions`), so `git merge feature` / `git rebase feature` silently
/// operate on the tag when both exist. Those callers take a branch, so qualify
/// to `refs/heads/` in exactly that ambiguous case — matching how the tag
/// operations already fully-qualify `refs/tags/`. The qualification is skipped
/// when no clashing tag exists, so the ordinary case keeps its clean bare name
/// (and merge keeps its "Merge branch 'feature'" message).
///
/// Reset qualifies in `recovery::preview_reset` only: the preview resolves the
/// name to an oid and the write executes that oid, so applying this to a write
/// operand would turn an exact target back into a movable ref (GL-302).
pub(in crate::git::write) fn qualify_branch_if_ambiguous(repo: &str, name: &str) -> String {
    if ref_exists(repo, &format!("refs/heads/{name}"))
        && ref_exists(repo, &format!("refs/tags/{name}"))
    {
        format!("refs/heads/{name}")
    } else {
        name.to_string()
    }
}

/// Whether `reference` resolves to an existing ref (`git rev-parse --verify
/// --quiet` exits non-zero when it doesn't).
pub(in crate::git::write) fn ref_exists(repo: &str, reference: &str) -> bool {
    run_git(repo, &["rev-parse", "--verify", "--quiet", reference])
        .map(|out| !out.trim().is_empty())
        .unwrap_or(false)
}

/// Resolve a rev to the oid printed by `git rev-parse --verify`. `--verify`
/// exits non-zero for an unresolvable ref, so `run_git` already yields `Err`
/// before we get here; an *empty* success line is therefore a broken invariant,
/// not "no match", and we surface it rather than let two empty strings compare
/// equal and masquerade as an already-up-to-date no-op in `fast_forward_branch`.
pub(in crate::git::write) fn resolve_rev(repo: &str, reference: &str) -> Result<String, String> {
    let oid = run_git(repo, &["rev-parse", "--verify", reference])?
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    if oid.is_empty() {
        return Err(format!("could not resolve {reference}"));
    }
    Ok(oid)
}

pub(in crate::git::write) fn checked_branch_ref(repo: &str, name: &str) -> Result<String, String> {
    ensure_operand(name)?;
    let branch_ref = format!("refs/heads/{name}");
    // The transaction protocol is line-delimited. Validate the fully-qualified
    // ref before interpolation so control characters and invalid ref syntax can
    // never become a second update-ref command.
    run_git(repo, &["check-ref-format", "--branch", name])?;
    run_git(repo, &["check-ref-format", &branch_ref])?;
    Ok(branch_ref)
}

pub(super) fn ensure_canonical_object_id(repo: &str, oid: &str) -> Result<(), String> {
    let format = run_git(repo, &["rev-parse", "--show-object-format"])?;
    let length = match format.lines().next().unwrap_or("").trim() {
        "sha1" => 40,
        "sha256" => 64,
        other => return Err(format!("Unsupported Git object format {other:?}.")),
    };
    if oid.len() != length
        || !oid
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(
            "The expected branch oid is not a canonical full object id. Refresh and try again."
                .to_string(),
        );
    }
    // A canonical-looking but nonexistent object is not a preview lease.
    run_git(repo, &["cat-file", "-e", &format!("{oid}^{{object}}")]).map(|_| ())
}
