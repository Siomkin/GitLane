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
                    None => out.push_str(authority), // username only — not a secret
                }
            }
            None => out.push_str(authority),
        }

        cursor = scheme_sep + 3 + end;
    }
    out
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
    use super::redact_secrets;

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
