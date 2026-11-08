//! Finds credentials that are recognisable with no URL around them: provider
//! tokens, `Authorization` values, and token query parameters.

use super::{is_authority_delimiter, TOKEN_USERNAME_PREFIXES};
use crate::percent::hex_value;

/// Query parameters whose value is a credential. Matched anywhere, ignoring
/// case, so a longer name such as `oauth_access_token=` is covered too.
const TOKEN_QUERY_KEYS: [&[u8]; 2] = [b"private_token=", b"access_token="];
const AUTHORIZATION_HEADER: &[u8] = b"authorization";
/// `Authorization` schemes whose credential is exactly one word.
const SINGLE_WORD_SCHEMES: [&str; 5] = ["bearer", "basic", "token", "negotiate", "ntlm"];
/// A prefixed name after `/` is usually a repo or ref (`acme/glagent-tools`);
/// from this body length on it is treated as a token in a URL path instead.
const MIN_TOKEN_BODY_AFTER_SLASH: usize = 20;

/// Replace each span found by `span_at` with `***`, in one pass: a match resumes
/// after its value, so the work stays proportional to the length of the text.
pub(super) fn redact_spans(
    text: &str,
    span_at: fn(&str, usize) -> Option<(usize, usize)>,
) -> String {
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    let mut cursor = 0;
    while cursor < text.len() {
        match span_at(text, cursor) {
            Some((start, end)) => {
                out.push_str(&text[copied..start]);
                out.push_str("***");
                copied = end;
                cursor = end;
            }
            None => cursor += 1,
        }
    }
    out.push_str(&text[copied..]);
    out
}

/// The byte range of a secret whose pattern begins at `at`, if one does. The
/// patterns are ASCII, so a match cannot start inside a multi-byte character.
pub(super) fn secret_span_at(text: &str, at: usize) -> Option<(usize, usize)> {
    let bytes = text.as_bytes();
    let rest = &bytes[at..];

    if let Some(span) = query_value_span_at(text, at) {
        return Some(span);
    }
    // No word boundary is needed here: the colon anchors the match, and a check
    // would miss a header after a literal `\n` in JSON or debug output.
    if starts_with_ignore_case(rest, AUTHORIZATION_HEADER) {
        return authorization_value_span(text, at + AUTHORIZATION_HEADER.len());
    }
    // A prefix inside a longer word (`loghp_x`, Base64 data) is not a token.
    if continues_word(bytes, at) {
        return None;
    }

    let prefix = TOKEN_USERNAME_PREFIXES
        .iter()
        .find(|prefix| rest.starts_with(prefix.as_bytes()))?;
    let body = rest[prefix.len()..]
        .iter()
        .take_while(|byte| is_token_byte(**byte))
        .count();
    // A `.` can be part of a token but not the end of one: it closes a sentence.
    let token = text[at..at + prefix.len() + body].trim_end_matches('.');
    let body = token.len().saturating_sub(prefix.len());
    let min_body = if at > 0 && bytes[at - 1] == b'/' {
        MIN_TOKEN_BODY_AFTER_SLASH
    } else {
        1
    };
    (body >= min_body).then_some((at, at + token.len()))
}

/// The value of a token query parameter whose name begins at `at`.
pub(super) fn query_value_span_at(text: &str, at: usize) -> Option<(usize, usize)> {
    let rest = &text.as_bytes()[at..];
    let key = TOKEN_QUERY_KEYS
        .iter()
        .find(|key| starts_with_ignore_case(rest, key))?;
    let start = at + key.len();
    let end = text[start..]
        .find(is_query_value_end)
        .map_or(text.len(), |len| start + len);
    (end > start).then_some((start, end))
}

/// Whether the byte before `at` is part of the same word. The last character of
/// an escape (`\n`, `%20`) is not, even though it is a letter or digit.
fn continues_word(bytes: &[u8], at: usize) -> bool {
    let before = &bytes[..at];
    let Some(last) = before.last().filter(|byte| is_word_byte(**byte)) else {
        return false;
    };
    let backslash_escape = before.len() >= 2 && before[before.len() - 2] == b'\\';
    let percent_escape = before.len() >= 3
        && before[before.len() - 3] == b'%'
        && hex_value(before[before.len() - 2]).is_some()
        && hex_value(*last).is_some();
    !backslash_escape && !percent_escape
}

/// The secret in the value after `Authorization:`, starting from the end of the
/// header name and allowing the closing quote of a JSON or debug-printed key.
///
/// A first word is kept only when it is a known scheme, because anything else
/// could be the credential itself. Digest puts secrets in several quoted words,
/// so it runs to the end of the line; other values stop at a `;`.
fn authorization_value_span(text: &str, name_end: usize) -> Option<(usize, usize)> {
    let bytes = text.as_bytes();
    let colon = name_end + usize::from(matches!(bytes.get(name_end), Some(b'"' | b'\'')));
    if bytes.get(colon) != Some(&b':') {
        return None;
    }
    let line = text[colon + 1..].split(['\r', '\n']).next()?;
    let value = line.trim();
    let value_end = colon + 1 + line.trim_end().len();
    let (scheme, credentials) = value.split_once(char::is_whitespace).unwrap_or(("", value));
    let scheme = scheme.trim_start_matches(['"', '\'']);
    let credentials = credentials.trim_start();
    let is_single_word = SINGLE_WORD_SCHEMES
        .iter()
        .any(|known| scheme.eq_ignore_ascii_case(known));

    let (tail, len) = if scheme.eq_ignore_ascii_case("digest") {
        (credentials, credentials.len())
    } else if is_single_word {
        let word_end = credentials.find(|c: char| c.is_whitespace() || c == ';');
        (credentials, word_end.unwrap_or(credentials.len()))
    } else {
        (value, value.find(';').unwrap_or(value.len()))
    };
    let start = value_end - tail.len();
    (len > 0).then_some((start, start + len))
}

fn starts_with_ignore_case(bytes: &[u8], pattern: &[u8]) -> bool {
    bytes
        .get(..pattern.len())
        .is_some_and(|head| head.eq_ignore_ascii_case(pattern))
}

fn is_word_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

/// Bytes a provider token can hold. `=` is in Atlassian tokens, `.` in GitLab's
/// routable ones, and `%` in a token that was percent-encoded along the way.
fn is_token_byte(byte: u8) -> bool {
    is_word_byte(byte) || matches!(byte, b'-' | b'=' | b'.' | b'%')
}

/// `/` stays in the value because Base64 tokens can contain it.
fn is_query_value_end(c: char) -> bool {
    matches!(c, '&' | '#') || (c != '/' && is_authority_delimiter(c))
}

#[cfg(test)]
mod tests;
