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

/// Reject a directory **leaf** name that isn't a single new child: empty, the
/// dot-segments `.`/`..` (which resolve to the parent / grandparent), or one
/// containing a path separator. Used by repo init/clone so a chosen name like
/// `.` can't target the parent directory instead of a fresh subfolder.
pub(super) fn ensure_safe_leaf(name: &str) -> Result<(), String> {
    let trimmed = name.trim();
    if trimmed.is_empty()
        || trimmed == "."
        || trimmed == ".."
        || trimmed.contains('/')
        || trimmed.contains('\\')
    {
        return Err(format!("Choose a valid folder name (not {name:?})."));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::ensure_safe_leaf;

    #[test]
    fn safe_leaf_rejects_dot_segments_and_separators() {
        assert!(ensure_safe_leaf("my-project").is_ok());
        assert!(ensure_safe_leaf("repo.git").is_ok());
        for bad in ["", "   ", ".", "..", "a/b", "a\\b", "./x", "../x"] {
            assert!(ensure_safe_leaf(bad).is_err(), "{bad:?} should be rejected");
        }
    }
}
