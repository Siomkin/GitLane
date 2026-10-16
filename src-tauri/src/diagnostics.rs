//! The frontend error log: render errors React reports (caught by a boundary or
//! uncaught) appended to one size-capped file in the OS app-log directory, so a
//! release build that blanks or shows a fallback still leaves a trace.
//!
//! Local only — nothing leaves the machine — and every field goes through
//! [`redact_secrets`] first, because an error message can echo a remote URL. The
//! command layer resolves the directory and passes it in, so this module stays
//! Tauri-free and unit-tests against a temp dir.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Deserialize;

use crate::redact::redact_secrets;

/// File name inside the app-log directory.
pub const LOG_FILE: &str = "frontend-errors.log";
/// The file never grows past this; older entries are dropped first.
const FILE_CAP: usize = 512 * 1024;
/// Per-field cap, so one huge stack can't evict the whole history.
const FIELD_CAP: usize = 16 * 1024;
/// First line of every entry — the cut point when old entries are dropped.
const ENTRY_MARK: &str = "=== ";

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FrontendErrorKind {
    /// An error boundary caught it and showed a fallback.
    Caught,
    /// Nothing caught it; React unmounted the root.
    Uncaught,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontendErrorReport {
    pub kind: FrontendErrorKind,
    pub message: String,
    pub stack: Option<String>,
    pub component_stack: Option<String>,
}

/// Append `report` to `log_dir/frontend-errors.log`, keeping the file under
/// [`FILE_CAP`] by dropping its oldest entries.
pub fn append_frontend_error(log_dir: &Path, report: &FrontendErrorReport) -> io::Result<()> {
    append_entry(log_dir, &format_entry(report, now_rfc3339()))
}

fn format_entry(report: &FrontendErrorReport, timestamp: String) -> String {
    let kind = match report.kind {
        FrontendErrorKind::Caught => "caught",
        FrontendErrorKind::Uncaught => "uncaught",
    };
    let mut entry = format!(
        "{ENTRY_MARK}{timestamp} {kind}\n{}\n",
        field(&report.message)
    );
    if let Some(stack) = &report.stack {
        entry.push_str(&format!("stack:\n{}\n", field(stack)));
    }
    if let Some(component_stack) = &report.component_stack {
        entry.push_str(&format!("component stack:\n{}\n", field(component_stack)));
    }
    entry.push('\n');
    entry
}

/// Redacted, then clipped to [`FIELD_CAP`] bytes on a char boundary. Redacting
/// first matters: a clip through `user:password@host` would drop the `@host`
/// that `redact_secrets` keys on and leave part of the password behind.
fn field(text: &str) -> String {
    let redacted = redact_secrets(text.trim_end());
    let mut end = redacted.len().min(FIELD_CAP);
    while !redacted.is_char_boundary(end) {
        end -= 1;
    }
    let clipped = if end < redacted.len() {
        format!("{}\n[truncated]", &redacted[..end])
    } else {
        redacted
    };
    escape_marks(clipped)
}

/// Indent any field line that starts like an entry header, so rotation can
/// never mistake error text for an entry boundary.
fn escape_marks(text: String) -> String {
    let text = text.replace(&format!("\n{ENTRY_MARK}"), &format!("\n {ENTRY_MARK}"));
    if text.starts_with(ENTRY_MARK) {
        format!(" {text}")
    } else {
        text
    }
}

/// Serialises appends: each report runs on its own blocking thread, and an
/// unlocked rotate (read, trim, rewrite) would erase a concurrent append.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

fn append_entry(log_dir: &Path, entry: &str) -> io::Result<()> {
    let _guard = WRITE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    fs::create_dir_all(log_dir)?;
    let path = log_dir.join(LOG_FILE);
    let size = fs::metadata(&path).map_or(0, |meta| meta.len() as usize);
    if size + entry.len() <= FILE_CAP {
        return OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)?
            .write_all(entry.as_bytes());
    }
    // Over the cap: keep the newest half of what is there, cut at an entry
    // start so no entry is left torn, then append. Lossy, so stray non-UTF-8
    // bytes can't stop the cap from being enforced.
    let existing = String::from_utf8_lossy(&fs::read(&path)?).into_owned();
    let kept = newest_entries(&existing, FILE_CAP / 2);
    fs::write(&path, format!("{kept}{entry}"))
}

/// The suffix of `log` that starts at an entry boundary and is at most `budget`
/// bytes long (empty when no whole entry fits).
fn newest_entries(log: &str, budget: usize) -> &str {
    let mut from = log.len().saturating_sub(budget);
    while !log.is_char_boundary(from) {
        from += 1;
    }
    if log[from..].starts_with(ENTRY_MARK) {
        return &log[from..];
    }
    match log[from..].find(&format!("\n{ENTRY_MARK}")) {
        Some(at) => &log[from + at + 1..],
        None => "",
    }
}

fn now_rfc3339() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    rfc3339_utc(secs)
}

/// `secs` since the Unix epoch as `YYYY-MM-DDTHH:MM:SSZ` (Howard Hinnant's
/// days-to-civil algorithm; no date crate in the tree for one log line).
fn rfc3339_utc(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3_600,
        rem % 3_600 / 60,
        rem % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            static SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
            let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            TempDir(
                std::env::temp_dir().join(format!("gitlane-diag-{tag}-{}-{n}", std::process::id())),
            )
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn report(message: &str) -> FrontendErrorReport {
        FrontendErrorReport {
            kind: FrontendErrorKind::Uncaught,
            message: message.to_string(),
            stack: Some("Error: boom\n    at Dialog".to_string()),
            component_stack: Some("\n    at CreatePrDialog".to_string()),
        }
    }

    fn read(dir: &TempDir) -> String {
        fs::read_to_string(dir.0.join(LOG_FILE)).unwrap()
    }

    #[test]
    fn formats_an_entry_with_every_field() {
        let entry = format_entry(&report("boom"), "2026-10-16T08:00:00Z".to_string());
        assert_eq!(
            entry,
            "=== 2026-10-16T08:00:00Z uncaught\nboom\nstack:\nError: boom\n    at Dialog\n\
             component stack:\n\n    at CreatePrDialog\n\n"
        );
    }

    #[test]
    fn appends_entries_and_creates_the_directory() {
        let dir = TempDir::new("append");
        append_frontend_error(&dir.0, &report("first")).unwrap();
        append_frontend_error(&dir.0, &report("second")).unwrap();
        let log = read(&dir);
        assert_eq!(log.matches(ENTRY_MARK).count(), 2);
        assert!(log.find("first").unwrap() < log.find("second").unwrap());
    }

    #[test]
    fn redacts_url_credentials() {
        let dir = TempDir::new("redact");
        append_frontend_error(&dir.0, &report("push to https://u:secret@h/r.git failed")).unwrap();
        let log = read(&dir);
        assert!(log.contains("https://u:***@h/r.git"));
        assert!(!log.contains("secret"));
    }

    #[test]
    fn stays_under_the_cap_and_keeps_the_newest_entry() {
        let dir = TempDir::new("cap");
        let filler = "x".repeat(FIELD_CAP - 64);
        for i in 0..80 {
            append_frontend_error(&dir.0, &report(&format!("entry {i} {filler}"))).unwrap();
        }
        let log = read(&dir);
        assert!(log.len() <= FILE_CAP);
        assert!(log.starts_with(ENTRY_MARK));
        assert!(log.contains("entry 79 "));
        assert!(!log.contains("entry 0 "));
    }

    #[test]
    fn error_text_cannot_fake_an_entry_header() {
        let entry = format_entry(&report("=== bad\n=== dump"), "T".to_string());
        assert_eq!(entry.matches(&format!("\n{ENTRY_MARK}")).count(), 0);
        assert!(entry.starts_with(ENTRY_MARK));
        assert!(entry.contains("\n === bad\n === dump\n"));
    }

    #[test]
    fn stays_bounded_when_the_log_holds_invalid_utf8() {
        let dir = TempDir::new("utf8");
        fs::create_dir_all(&dir.0).unwrap();
        let mut junk = vec![0xffu8; FILE_CAP];
        junk.extend_from_slice(b"\n");
        fs::write(dir.0.join(LOG_FILE), junk).unwrap();
        append_frontend_error(&dir.0, &report("after junk")).unwrap();
        let log = String::from_utf8_lossy(&fs::read(dir.0.join(LOG_FILE)).unwrap()).into_owned();
        assert!(log.len() <= FILE_CAP);
        assert!(log.starts_with(ENTRY_MARK));
        assert!(log.contains("after junk"));
    }

    #[test]
    fn redacts_a_url_that_straddles_the_clip_point() {
        let text = format!(
            "{}https://u:supersecretpassword@host/r.git",
            "x".repeat(FIELD_CAP - 20)
        );
        let clipped = field(&text);
        assert!(!clipped.contains("supersecr"));
        assert!(clipped.ends_with("[truncated]"));
    }

    #[test]
    fn clips_an_oversized_multibyte_field_without_panicking() {
        let huge = "é".repeat(FIELD_CAP);
        let clipped = field(&huge);
        assert!(clipped.ends_with("[truncated]"));
        assert!(clipped.len() <= FIELD_CAP + "\n[truncated]".len());
    }

    #[test]
    fn formats_utc_timestamps() {
        assert_eq!(rfc3339_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(rfc3339_utc(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(rfc3339_utc(1_791_158_400), "2026-10-05T00:00:00Z");
    }
}
