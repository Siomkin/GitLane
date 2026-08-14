//! Reading `gh`'s human output: the device code, the login it settled on,
//! the error it failed with, and the ANSI stripping and bounding that make
//! a transcript safe to keep.

/// Extract the one-time device code (`XXXX-XXXX`) and the verification URL from
/// gh's output. Returns `None` until the code line has arrived. When the URL
/// hasn't been printed yet, fall back to the flow's own host (not github.com —
/// this may be a GHES sign-in).
pub(super) fn parse_code(transcript: &str, host: &str) -> Option<(String, String)> {
    let idx = transcript.find("one-time code:")?;
    let code = transcript[idx + "one-time code:".len()..]
        .split_whitespace()
        .find(|t| is_device_code(t))?
        .to_string();
    let url = transcript
        .split_whitespace()
        .find(|t| t.starts_with("https://") && t.contains("/login/device"))
        .map(|t| t.trim_end_matches(['.', ')', ',']).to_string())
        .unwrap_or_else(|| format!("https://{host}/login/device"));
    Some((code, url))
}

/// `gh` device codes are eight alphanumerics split by a hyphen, e.g. `1A2B-3C4D`.
pub(super) fn is_device_code(token: &str) -> bool {
    let bytes = token.as_bytes();
    bytes.len() == 9
        && bytes[4] == b'-'
        && token[..4].chars().all(|c| c.is_ascii_alphanumeric())
        && token[5..].chars().all(|c| c.is_ascii_alphanumeric())
}

/// Pull the login out of gh's `✓ Logged in as octocat` success line.
pub(super) fn parse_login(transcript: &str) -> Option<String> {
    let idx = transcript.rfind("Logged in as ")?;
    let login = transcript[idx + "Logged in as ".len()..]
        .split_whitespace()
        .next()?
        .trim()
        .trim_start_matches('@');
    (!login.is_empty()).then(|| login.to_string())
}

/// Best-effort failure text: the last line mentioning an error, else a generic
/// message so the UI never shows an empty failure.
pub(super) fn extract_signin_error(transcript: &str) -> String {
    transcript
        .lines()
        .map(str::trim)
        .rfind(|l| {
            let low = l.to_lowercase();
            low.contains("error") || low.contains("failed") || low.contains("could not")
        })
        .map(|l| {
            l.trim_start_matches(['x', '✗', '!', '-', ' '])
                .trim()
                .to_string()
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "GitHub sign-in didn’t complete. Please try again.".to_string())
}

/// Strip ANSI escape sequences so parsing sees plain text (gh styles its prompts
/// and its TUI probes the terminal). Best-effort: drops `ESC [ … <letter>` CSI
/// runs, `ESC ] … <BEL|ST>` OSC runs (else the payload of a background-colour
/// query would land in the transcript as stray `11;?` text), and any lone `ESC x`.
pub(super) fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        match chars.peek() {
            Some('[') => {
                chars.next();
                for n in chars.by_ref() {
                    if n.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            // OSC: runs until BEL or ST (`ESC \`).
            Some(']') => {
                chars.next();
                while let Some(n) = chars.next() {
                    if n == '\u{7}' {
                        break;
                    }
                    if n == '\u{1b}' {
                        chars.next(); // the `\` of the ST terminator
                        break;
                    }
                }
            }
            _ => {
                chars.next();
            }
        }
    }
    out
}

/// Keep the transcript bounded (~16 KiB) on a char boundary — the device flow can
/// stream a lot before it completes, but we only ever scan for a few markers.
pub(super) fn bound_transcript(transcript: &mut String) {
    const CAP: usize = 16 * 1024;
    if transcript.len() > CAP {
        let cut = transcript.len() - CAP;
        let start = (cut..transcript.len())
            .find(|&i| transcript.is_char_boundary(i))
            .unwrap_or(transcript.len());
        *transcript = transcript[start..].to_string();
    }
}
