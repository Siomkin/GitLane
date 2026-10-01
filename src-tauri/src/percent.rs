//! RFC 3986 percent-encoding, defined once for the forge REST paths, the OAuth
//! query components, remote-URL userinfo, and secret redaction.

/// Percent-encode everything outside the RFC 3986 unreserved set — notably
/// `/` → `%2F`, so a nested project path stays one path segment.
pub(crate) fn encode_component(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// Decode `%XX` escapes, leaving a malformed escape as literal text; with
/// `plus_as_space`, `+` also decodes to a space (form/query encoding). Invalid
/// UTF-8 in the result is replaced, never an error.
pub(crate) fn decode_lossy(input: &str, plus_as_space: bool) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(high), Some(low)) = (hex_value(bytes[i + 1]), hex_value(bytes[i + 2])) {
                out.push(high << 4 | low);
                i += 3;
                continue;
            }
        }
        out.push(if plus_as_space && bytes[i] == b'+' {
            b' '
        } else {
            bytes[i]
        });
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// One hex digit's value, or `None` for anything else (no sign, no space).
pub(crate) fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_round_trips() {
        for s in ["a b/c:d", "plain", "sym+bol&x=y", "unicøde"] {
            assert_eq!(decode_lossy(&encode_component(s), true), s);
            assert_eq!(decode_lossy(&encode_component(s), false), s);
        }
        assert_eq!(encode_component("group/sub repo"), "group%2Fsub%20repo");
    }

    #[test]
    fn plus_decodes_to_space_only_when_asked_and_malformed_escapes_stay() {
        assert_eq!(decode_lossy("a+b%2", true), "a b%2");
        assert_eq!(decode_lossy("a+b%zz", false), "a+b%zz");
        assert_eq!(decode_lossy("%+5x", false), "%+5x");
    }
}
