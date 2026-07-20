//! Secret redaction for user-facing subprocess output (GL-132).
//!
//! `git`/`gh` can echo a remote URL that carries credentials in its userinfo
//! (`https://user:token@host/…`) — for example in a `fatal: Authentication
//! failed for '…'` line. GitLane surfaces subprocess output verbatim over IPC,
//! so any such string is scrubbed first: the password half of the userinfo is
//! replaced with `***`. The username is left intact — it is not a secret and it
//! helps the user recognise which account failed.
//!
//! This is defence in depth. GitLane never *writes* a password into a remote URL
//! (per-remote auth stores only a username there), so a leak would require git
//! itself to echo a credential; redacting here means it still cannot reach a
//! toast, log, or error boundary.

/// Redact userinfo passwords from every `scheme://user:password@host` in `text`.
/// A bare `scheme://user@host` (no password) and a `scheme://host` are returned
/// unchanged, as is any text without a URL.
pub fn redact_secrets(text: &str) -> String {
    // Cheap exit for the overwhelmingly common no-URL case.
    if !text.contains("://") {
        return text.to_string();
    }

    let mut out = String::with_capacity(text.len());
    let mut cursor = 0usize;
    while cursor < text.len() {
        let Some(rel) = text[cursor..].find("://") else {
            out.push_str(&text[cursor..]);
            break;
        };
        let scheme_sep = cursor + rel;
        // Copy everything up to and including "://".
        out.push_str(&text[cursor..scheme_sep + 3]);

        let rest = &text[scheme_sep + 3..];
        // The authority ends at the first path/delimiter character.
        let end = rest
            .find(|c: char| is_authority_delimiter(c))
            .unwrap_or(rest.len());
        let authority = &rest[..end];

        // The final `@` terminates userinfo. Some URL consumers tolerate an
        // unescaped `@` inside a password; using the first one would leave the
        // password suffix visible as if it were part of the host.
        match authority.rfind('@') {
            // userinfo present: redact the password half if any.
            Some(at) => {
                let userinfo = &authority[..at];
                let host = &authority[at..]; // includes '@'
                match userinfo.find(':') {
                    Some(colon) => {
                        out.push_str(&userinfo[..=colon]); // "user:"
                        out.push_str("***");
                        out.push_str(host);
                    }
                    // A username-only URL is normally an account selector, not a
                    // secret — but `https://<token>@host/…` is a widely scripted
                    // shape that both GitHub and GitLab accept, and there the
                    // "username" *is* the credential.
                    None if is_secretlike_username(userinfo) => {
                        out.push_str("***");
                        out.push_str(host);
                    }
                    None => out.push_str(authority), // username only — not a secret
                }
            }
            None => out.push_str(authority),
        }

        cursor = scheme_sep + 3 + end;
    }
    out
}

/// Provider token prefixes that identify a credential placed in a URL's
/// username slot. Both GitHub and GitLab accept `https://<token>@host/…`, so
/// these must never be treated as an account selector.
const TOKEN_USERNAME_PREFIXES: &[&str] = &[
    // GitHub: personal access, OAuth, user-to-server, server-to-server, refresh.
    "ghp_",
    "gho_",
    "ghu_",
    "ghs_",
    "ghr_",
    "github_pat_",
    // GitLab: PAT, pipeline trigger, deploy, runner, OAuth/incoming mail, agent.
    "glpat-",
    "glptt-",
    "gldt-",
    "glrt-",
    "glsoat-",
    "glimt-",
    "glagent-",
    "glcbt-",
    // Atlassian/Bitbucket app passwords and API tokens.
    "ATBB",
    "ATCTT",
];

/// Whether a URL's username slot actually holds a credential.
///
/// Deliberately conservative: usernames are how GitLane's per-remote auth
/// selects an account, so a false positive degrades a real feature. Known
/// provider token prefixes are matched exactly; beyond those, only strings that
/// are implausibly long *and* shaped like opaque key material qualify. The
/// OAuth sentinel usernames (`oauth2`, `x-token-auth`) are not secrets and stay
/// visible.
pub fn is_secretlike_username(user: &str) -> bool {
    // Classify the *decoded* userinfo. Git percent-decodes userinfo before
    // using it, so `ghp%5FAbCd…` authenticates exactly as `ghp_AbCd…` — but
    // it matches no literal prefix and its `%` fails the token-alphabet check
    // below, so classifying the raw form would wave the credential straight
    // through into `.git/config`, clone argv, and surfaced errors.
    let decoded = percent_decode_lossy(user);
    let user = decoded.as_str();
    if TOKEN_USERNAME_PREFIXES
        .iter()
        .any(|prefix| user.starts_with(prefix))
    {
        return true;
    }
    // Generic high-entropy fallback for providers not in the list above. Real
    // forge usernames are short and rarely mix cases and digits; 32+ characters
    // of opaque token alphabet is not a person's handle.
    user.len() >= 32
        && user
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        && user.bytes().any(|b| b.is_ascii_digit())
        && user.bytes().any(|b| b.is_ascii_uppercase())
        && user.bytes().any(|b| b.is_ascii_lowercase())
}

/// Percent-decode `value`, leaving any malformed `%` escape as literal text.
///
/// Only used to *classify* userinfo — never to build a URL — so a lossy,
/// dependency-free decode is the right trade: a malformed escape that we leave
/// alone cannot make a secret look less secret-like, because the surrounding
/// bytes are still checked.
fn percent_decode_lossy(value: &str) -> String {
    if !value.contains('%') {
        return value.to_string();
    }
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3])
                .ok()
                .and_then(|pair| u8::from_str_radix(pair, 16).ok());
            if let Some(byte) = hex {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Where a URL authority ends inside free-form log text — the path separator or
/// any whitespace/quote/bracket that could not be part of `host[:port]`.
fn is_authority_delimiter(c: char) -> bool {
    c.is_whitespace()
        || matches!(
            c,
            '/' | '"' | '\'' | '<' | '>' | '(' | ')' | '[' | ']' | '`' | '\\' | '|'
        )
}

#[cfg(test)]
mod tests {
    use super::{is_secretlike_username, redact_secrets};

    #[test]
    fn redacts_password_userinfo_but_keeps_username() {
        assert_eq!(
            redact_secrets(
                "fatal: Authentication failed for 'https://alice:glpat-SECRET@gitlab.com/o/r.git'"
            ),
            "fatal: Authentication failed for 'https://alice:***@gitlab.com/o/r.git'"
        );
    }

    #[test]
    fn redacts_x_access_token_style_credentials() {
        assert_eq!(
            redact_secrets("remote: https://x-access-token:ghs_TOKEN@github.com/o/r"),
            "remote: https://x-access-token:***@github.com/o/r"
        );
    }

    #[test]
    fn redacts_the_whole_password_when_it_contains_an_at_sign() {
        assert_eq!(
            redact_secrets("remote: https://alice:p@ss@example.com/o/r"),
            "remote: https://alice:***@example.com/o/r"
        );
    }

    #[test]
    fn redacts_a_token_in_the_username_slot() {
        // GitHub and GitLab both accept token-as-username; the "username" here
        // is the credential, not an account selector.
        assert_eq!(
            redact_secrets(
                "fatal: Authentication failed for 'https://ghp_AbCdEf0123@github.com/o/r.git'"
            ),
            "fatal: Authentication failed for 'https://***@github.com/o/r.git'"
        );
        assert_eq!(
            redact_secrets("https://glpat-XxYyZz123456@gitlab.com/g/r.git"),
            "https://***@gitlab.com/g/r.git"
        );
        assert_eq!(
            redact_secrets("https://github_pat_11ABC0000_aaaaaaaaaa@github.com/o/r.git"),
            "https://***@github.com/o/r.git"
        );
    }

    #[test]
    fn redacts_a_percent_encoded_token_username() {
        // Git percent-decodes userinfo, so `ghp%5F…` authenticates as `ghp_…`.
        // Classifying the raw form would let it through both the prefix list
        // and the token-alphabet fallback.
        assert!(is_secretlike_username("ghp%5FAbCdEf0123456789"));
        assert!(is_secretlike_username("glpat%2DXxYyZz123456"));
        assert_eq!(
            redact_secrets("https://ghp%5FAbCdEf0123456789@github.com/o/r.git"),
            "https://***@github.com/o/r.git"
        );
        // A malformed escape is left literal and must not crash or misclassify.
        assert!(!is_secretlike_username("alice%"));
        assert!(!is_secretlike_username("alice%zz"));
        assert!(!is_secretlike_username("%"));
    }

    #[test]
    fn keeps_account_selector_usernames_visible() {
        // These are how per-remote auth picks an account — redacting them would
        // break a real feature, so the predicate must stay conservative.
        for user in [
            "alice",
            "oauth2",
            "x-token-auth",
            "git",
            "my-long-ish-handle",
        ] {
            let url = format!("https://{user}@github.com/o/r.git");
            assert_eq!(redact_secrets(&url), url, "{user} must stay visible");
        }
    }

    #[test]
    fn leaves_username_only_and_plain_urls_untouched() {
        assert_eq!(
            redact_secrets("https://alice@github.com/o/r.git"),
            "https://alice@github.com/o/r.git"
        );
        assert_eq!(
            redact_secrets("Cloning 'https://github.com/o/r.git'..."),
            "Cloning 'https://github.com/o/r.git'..."
        );
    }

    #[test]
    fn preserves_custom_ports_and_redacts_multiple_urls() {
        assert_eq!(
            redact_secrets(
                "a https://u:p1@ghe.example.test:8443/x and b https://v:p2@gitlab.com/y done"
            ),
            "a https://u:***@ghe.example.test:8443/x and b https://v:***@gitlab.com/y done"
        );
    }

    #[test]
    fn no_url_text_is_returned_unchanged() {
        let text = "fatal: could not read Username for 'x': terminal prompts disabled";
        assert_eq!(redact_secrets(text), text);
    }

    #[test]
    fn does_not_treat_scp_style_ssh_as_a_password_url() {
        // scp-like SSH has no "://" and no password — left as-is.
        let text = "git@github.com:owner/repo.git";
        assert_eq!(redact_secrets(text), text);
    }
}
