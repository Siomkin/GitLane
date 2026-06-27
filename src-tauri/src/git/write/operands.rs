//! Validation for git operands passed before `--`.

/// Reject a user-supplied ref/branch/tag/commit/path operand that git would
/// otherwise parse as an option because it begins with `-` (e.g. a ref literally
/// named `--upload-pack=…` or `--exec=…`, which can turn `git fetch`/`rebase`
/// into arbitrary command execution). git itself forbids ref names starting with
/// `-`, so this rejects nothing a legitimate operation produces. We use this
/// rather than a `--` end-of-options separator because for several of these
/// subcommands (`checkout`, `merge`, `reset`) `--` switches to *pathspec*
/// semantics and would change the meaning of the argument.
pub(super) fn ensure_operand(value: &str) -> Result<(), String> {
    if value.starts_with('-') {
        return Err(format!(
            "Refusing unsafe git argument that begins with '-': {value:?}"
        ));
    }
    Ok(())
}

/// [`ensure_operand`] for an optional operand.
pub(super) fn ensure_opt(value: Option<&str>) -> Result<(), String> {
    if let Some(v) = value {
        ensure_operand(v)?;
    }
    Ok(())
}
