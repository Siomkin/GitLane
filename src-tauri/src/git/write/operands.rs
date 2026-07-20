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

/// Refuse URLs whose userinfo carries a credential. Git accepts
/// `https://user:password@host/...`, but persisting or invoking that form would
/// put the secret in `.git/config`, process output, and IPC payloads. A username-
/// only selector (`https://user@host/...`) remains valid because GitLane uses it
/// to choose an entry from the user's credential helper.
///
/// The final `@` terminates userinfo. Using it instead of the first one also
/// rejects malformed-but-commonly-accepted inputs with an unescaped `@` inside
/// the password, without ever copying the secret into the returned error.
///
/// `ssh://` and `git://` are checked alongside HTTP(S): git persists any of them
/// into `.git/config` verbatim, so a password is equally exposed there. Scp-form
/// (`git@host:path`) has no `://` and no password slot, so it is left alone.
pub(super) fn ensure_url_has_no_credentials(url: &str) -> Result<(), String> {
    let trimmed = url.trim();
    let Some((scheme, rest)) = trimmed.split_once("://") else {
        return Ok(());
    };
    if !["http", "https", "ssh", "git"]
        .iter()
        .any(|allowed| scheme.eq_ignore_ascii_case(allowed))
    {
        return Ok(());
    }

    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    if let Some(at) = authority.rfind('@') {
        let userinfo = &authority[..at];
        // A colon means an explicit password half. A colon-*less* userinfo is
        // normally an account selector, but `https://<token>@host/…` puts the
        // credential in that same slot — accepting it would persist the token
        // into `.git/config` and place it in `git clone` argv, where any local
        // process can read it out of `ps`.
        if userinfo.contains(':') || crate::redact::is_secretlike_username(userinfo) {
            return Err(
                "Remote URLs must not contain a password or token. Save credentials with a Git helper or GitLane account instead."
                    .to_string(),
            );
        }
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
    use super::{ensure_safe_leaf, ensure_url_has_no_credentials};

    #[test]
    fn safe_leaf_rejects_dot_segments_and_separators() {
        assert!(ensure_safe_leaf("my-project").is_ok());
        assert!(ensure_safe_leaf("repo.git").is_ok());
        for bad in ["", "   ", ".", "..", "a/b", "a\\b", "./x", "../x"] {
            assert!(ensure_safe_leaf(bad).is_err(), "{bad:?} should be rejected");
        }
    }

    #[test]
    fn credential_guard_keeps_username_only_selectors() {
        for allowed in [
            "https://alice@example.com/team/repo.git",
            "http://alice@example.com:8080/team/repo.git",
            "https://user%3Aalias@example.com/team/repo.git",
            "https://[::1]:8443/team/repo.git",
            "ssh://git@example.com/team/repo.git",
            "git@example.com:team/repo.git",
            // OAuth sentinel usernames are selectors, not secrets.
            "https://oauth2@gitlab.example.com/team/repo.git",
            "https://x-token-auth@bitbucket.org/team/repo.git",
        ] {
            assert!(
                ensure_url_has_no_credentials(allowed).is_ok(),
                "{allowed:?} should be allowed"
            );
        }
    }

    #[test]
    fn credential_guard_rejects_secrets_without_echoing_them() {
        for rejected in [
            "https://alice:secret@example.com/team/repo.git",
            "http://alice:@example.com/team/repo.git",
            "HTTPS://token:p@ss@example.com/team/repo.git",
            // git persists these verbatim too, so the password is just as exposed.
            "ssh://git:secret@example.com/team/repo.git",
            "git://alice:secret@example.com/team/repo.git",
            // Token parked in the username slot — accepted by GitHub/GitLab, and
            // would otherwise reach `.git/config` and `git clone` argv.
            "https://ghp_AbCdEf0123456789@github.com/o/r.git",
            "https://glpat-XxYyZz123456@gitlab.com/g/r.git",
        ] {
            let error = ensure_url_has_no_credentials(rejected).unwrap_err();
            assert!(
                error.contains("must not contain"),
                "unexpected error: {error}"
            );
            assert!(
                !error.contains("secret"),
                "error echoed the secret: {error}"
            );
            assert!(!error.contains("p@ss"), "error echoed the secret: {error}");
        }
    }
}
