//! Path extraction for `diff --git` headers.

/// Extract the b-side path from a `diff --git ` header body (everything after
/// the `diff --git ` prefix). Handles both git forms:
/// - bare: `a/src/foo.rs b/src/foo.rs` -> split on the ` b/` separator.
/// - C-quoted (path has spaces / special bytes): `"a/foo bar" "b/foo bar"` ->
///   take the second quoted token, de-quote it, and drop the `b/` prefix.
pub(super) fn diff_git_b_path(rest: &str) -> String {
    // A quoted b-side token is preceded by a space: `... "b/<escaped>"`. Find
    // the first ` "` and try to read a quoted token whose content starts with
    // `b/`.
    if let Some(pos) = rest.find(" \"") {
        if let Some(token) = first_quoted_token(&rest[pos + 1..]) {
            let unquoted = c_unquote(&token);
            if let Some(stripped) = unquoted.strip_prefix("b/") {
                return stripped.to_string();
            }
        }
    }
    // Bare form (or an unrecognised quoted shape): best-effort split on ` b/`.
    rest.split_once(" b/")
        .map(|(_, b)| b.to_string())
        .unwrap_or_else(|| rest.to_string())
}

/// Read a double-quoted token starting at the leading `"` of `s`, returning its
/// inner contents (still escaped) up to the matching unescaped closing quote.
/// `None` if `s` doesn't start with `"` or the quote is never closed.
fn first_quoted_token(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    if bytes.first() != Some(&b'"') {
        return None;
    }
    let mut i = 1;
    while i < bytes.len() {
        match bytes[i] {
            b'\\' => i += 2, // skip the escaped byte (e.g. \" or \\)
            b'"' => return Some(s[1..i].to_string()),
            _ => i += 1,
        }
    }
    None
}

/// Decode a git C-quoted path token (the bytes between the surrounding quotes),
/// undoing the escapes `core.quotePath` emits: `\\`, `\"`, `\t`, `\n`, `\r`,
/// and octal `\NNN` byte escapes (which reassemble into UTF-8).
fn c_unquote(inner: &str) -> String {
    let bytes = inner.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'\\' || i + 1 >= bytes.len() {
            out.push(bytes[i]);
            i += 1;
            continue;
        }
        match bytes[i + 1] {
            b'\\' => {
                out.push(b'\\');
                i += 2;
            }
            b'"' => {
                out.push(b'"');
                i += 2;
            }
            b't' => {
                out.push(b'\t');
                i += 2;
            }
            b'n' => {
                out.push(b'\n');
                i += 2;
            }
            b'r' => {
                out.push(b'\r');
                i += 2;
            }
            b'0'..=b'7' => {
                // Up to three octal digits -> one raw byte.
                let mut val: u16 = 0;
                let mut k = 0;
                while k < 3
                    && bytes
                        .get(i + 1 + k)
                        .is_some_and(|b| (b'0'..=b'7').contains(b))
                {
                    val = val * 8 + u16::from(bytes[i + 1 + k] - b'0');
                    k += 1;
                }
                out.push(val as u8);
                i += 1 + k;
            }
            _ => {
                out.push(bytes[i]);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diff_git_b_path_handles_both_forms() {
        assert_eq!(diff_git_b_path("a/src/foo.rs b/src/foo.rs"), "src/foo.rs");
        assert_eq!(diff_git_b_path("\"a/foo bar\" \"b/foo bar\""), "foo bar");
        // Rename to a different quoted name keeps the b-side.
        assert_eq!(
            diff_git_b_path("a/old.txt \"b/new name.txt\""),
            "new name.txt"
        );
    }
}
