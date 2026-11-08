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
//!
//! A forge or tool can also echo a credential with no URL around it, so a second
//! pass replaces recognised provider tokens, `Authorization` values, and token
//! query parameters wherever they appear.

use crate::percent::{decode_lossy, hex_value};

mod patterns;

use patterns::{query_value_span_at, redact_spans, secret_span_at};

/// Redact every credential recognised in free-form diagnostic text: URL userinfo
/// first, then bare provider tokens, `Authorization` values, and token query
/// parameters. Text with none of those is returned unchanged.
///
/// This can rewrite a name that merely looks like a token, so it is for text a
/// person reads. Values the app acts on go through [`redact_url_credentials`].
pub fn redact_secrets(text: &str) -> String {
    redact_spans(&redact_url_userinfo(text), secret_span_at)
}

/// Redact the parts of a URL that carry credentials, leaving its host and path
/// exact. For remote names and URLs sent to the frontend, which parses them.
pub fn redact_url_credentials(text: &str) -> String {
    redact_spans(&redact_url_userinfo(text), query_value_span_at)
}

/// Redact userinfo passwords and token usernames from every
/// `scheme://user:password@host` in `text`. A bare `scheme://user@host` with an
/// ordinary username and a `scheme://host` are returned unchanged, as is any text
/// without a URL.
fn redact_url_userinfo(text: &str) -> String {
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
                        let user = &userinfo[..colon];
                        out.push_str(if is_secretlike_username(user) {
                            "***"
                        } else {
                            user
                        });
                        out.push_str(":***");
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

/// Replace the exact active secret values supplied by the caller, then redact
/// recognised credentials. Exact values go first so a pattern cannot replace part
/// of a live credential and leave the rest unmatched. This companion is for
/// boundaries that still hold a live credential (for example a provider REST
/// client): a server or transport error may echo a request header or raw token
/// even though the credential never appeared in the URL.
///
/// Each byte of an active value may appear literally or as a case-insensitive
/// `%HH` escape, and a space may use form encoding's `+`. Matching byte by byte
/// catches mixed raw/encoded echoes without generating a finite list of variants;
/// it also covers escaped Base64 padding (`=` -> `%3D`).
///
/// Empty values are deliberately ignored. Replacing `""` would insert the
/// redaction marker between every character and derived forms such as a bare
/// `"Bearer "` are not credentials when no token is active.
pub fn redact_secrets_with_values(text: &str, active_secrets: &[&str]) -> String {
    let mut redacted = text.to_string();
    for secret in active_secrets {
        if !secret.is_empty() {
            redacted = redact_active_value(&redacted, secret);
        }
    }
    redact_secrets(&redacted)
}

fn redact_active_value(text: &str, secret: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0;
    while cursor < text.len() {
        if let Some(end) = encoded_value_end(text, cursor, secret) {
            out.push_str("***");
            cursor = end;
        } else {
            // INVARIANT: `cursor < text.len()` and `text` is valid UTF-8, so the
            // remaining slice always contains at least one char.
            let ch = text[cursor..]
                .chars()
                .next()
                .expect("cursor is before the end of valid UTF-8");
            out.push(ch);
            cursor += ch.len_utf8();
        }
    }
    out
}

/// Return the end of an exact active-value representation beginning at `start`.
///
/// Multiple states matter when the secret itself contains `%`: `%25` could be
/// either a literal prefix or the encoded form of `%`. Retaining both candidates
/// avoids choosing the wrong interpretation before the rest of the value proves
/// which one is valid.
fn encoded_value_end(text: &str, start: usize, secret: &str) -> Option<usize> {
    let input = text.as_bytes();
    let first = *secret.as_bytes().first()?;
    let starts_literal = input.get(start) == Some(&first);
    let starts_form_space = first == b' ' && input.get(start) == Some(&b'+');
    let starts_encoded = input.get(start) == Some(&b'%')
        && start + 2 < input.len()
        && hex_value(input[start + 1])
            .zip(hex_value(input[start + 2]))
            .map(|(high, low)| high << 4 | low)
            == Some(first);
    if !starts_literal && !starts_form_space && !starts_encoded {
        return None;
    }

    let mut positions = vec![start];

    for secret_byte in secret.bytes() {
        let mut next = Vec::with_capacity(positions.len() * 2);
        for position in positions {
            if input.get(position) == Some(&secret_byte) {
                next.push(position + 1);
            }
            if secret_byte == b' ' && input.get(position) == Some(&b'+') {
                next.push(position + 1);
            }
            if input.get(position) == Some(&b'%') && position + 2 < input.len() {
                let high = hex_value(input[position + 1]);
                let low = hex_value(input[position + 2]);
                if high.zip(low).map(|(high, low)| high << 4 | low) == Some(secret_byte) {
                    next.push(position + 3);
                }
            }
        }
        next.sort_unstable();
        next.dedup();
        if next.is_empty() {
            return None;
        }
        positions = next;
    }

    positions
        .into_iter()
        .filter(|end| text.is_char_boundary(*end))
        .max()
}

/// Provider token prefixes. They identify a credential placed in a URL's username
/// slot (both GitHub and GitLab accept `https://<token>@host/…`, so these must
/// never be treated as an account selector) and bare tokens in diagnostic text,
/// where any word starting with one is hidden, so an entry must be distinctive.
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
    "ATATT",
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
    // Only used to *classify* userinfo — never to build a URL — so a lossy
    // decode that leaves a malformed escape literal is the right trade: it
    // cannot make a secret look less secret-like, because the surrounding
    // bytes are still checked. `+` stays literal: this is URL userinfo, not a
    // form value.
    let decoded = decode_lossy(user, false);
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
mod tests;
