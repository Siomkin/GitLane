//! Repository lifecycle writes: **clone** (with live progress) and **init**.
//!
//! These are the only writes that operate *outside* an existing repository, so
//! they don't go through `git -C <repo>` like every other write — they use
//! [`super::cli::run_git_bare`] / a freshly spawned `git clone`. Clone is also
//! the one streaming write: it spawns `git clone --progress`, parses the phase
//! percentages off stderr, and emits a `clone-progress` event so the onboarding
//! UI can paint a real determinate bar and cancel an in-flight clone (GL-38).

use std::io::Read;
use std::process::{Child, Stdio};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use super::operands::{ensure_operand, ensure_safe_leaf};

/// Live clone progress, emitted to the frontend as a `clone-progress` event.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneProgress {
    /// Friendly phase label, matching the onboarding stage list.
    pub stage: String,
    /// Overall completion `0..=100`, blended across git's phases so the bar moves
    /// forward monotonically rather than resetting each phase.
    pub pct: u8,
}

/// Shared slot holding the in-flight clone child so `cancel_clone` can kill it
/// from another command while the clone thread streams progress.
pub type CloneSlot = Arc<Mutex<Option<Child>>>;

/// Clone `url` into `dest`, streaming progress to the frontend.
///
/// Runs on the blocking pool (see `lib::blocking`). The spawned child is parked
/// in `slot` so a concurrent [`cancel_clone`] can terminate it; stderr is read
/// to EOF (emitting `clone-progress` as phases advance) and then the real exit
/// status decides success. On failure the meaningful `fatal:`/`error:` lines are
/// returned so the UI can classify the failure (exists / auth / unreachable).
pub fn clone(app: &AppHandle, slot: CloneSlot, url: &str, dest: &str) -> Result<String, String> {
    let url = url.trim();
    let dest = dest.trim();
    if url.is_empty() {
        return Err("Enter a repository URL to clone.".to_string());
    }
    if dest.is_empty() {
        return Err("Choose a destination folder for the clone.".to_string());
    }
    // Reject a destination whose leaf is a dot-segment (`.`/`..`) — git resolves
    // it to the parent / grandparent rather than a fresh child folder. The UI
    // blocks this too; this is defense-in-depth on the raw joined path.
    let leaf = dest.trim_end_matches('/').rsplit('/').next().unwrap_or("");
    if leaf.is_empty() || leaf == "." || leaf == ".." {
        return Err("Choose a valid destination folder.".to_string());
    }

    // Whether a failed/canceled clone may remove `dest`: when it doesn't exist
    // yet (we create it) or it's an empty directory the user pointed us at (so a
    // partial clone would be the only thing in it). A pre-existing *non-empty*
    // dir is never removed — git refuses to clone into one anyway.
    let cleanup_eligible = clone_cleanup_eligible(std::path::Path::new(dest));

    // `--` stops a URL that begins with `-` from being read as an option; `dest`
    // is an absolute path the UI built, so it can never be one. `LC_ALL=C` keeps
    // the progress text English and byte-stable for the parser regardless of the
    // user's locale. git Command construction (incl. PATH) is centralized in
    // cli::git_command_bare.
    let mut cmd = super::cli::git_command_bare(&["clone", "--progress", "--", url, dest]);
    cmd.env("LC_ALL", "C")
        .env("LANG", "C")
        // git writes progress + errors to stderr; stdout carries nothing we need,
        // so null it to avoid an unread pipe.
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    // Spawn and park the child atomically under the slot lock, refusing to start
    // a second clone while one is already in flight — that would orphan the first
    // process and make `cancel_clone` target the wrong one.
    let mut stderr = {
        let mut guard = slot.lock().map_err(|e| e.to_string())?;
        if guard.is_some() {
            return Err("A clone is already in progress.".to_string());
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("failed to launch git: {e}"))?;
        // Kill the just-spawned child if we can't capture its output, rather than
        // leaving an untracked process running (it was never parked in the slot).
        let stderr = match child.stderr.take() {
            Some(stderr) => stderr,
            None => {
                let _ = child.kill();
                return Err("failed to capture git output".to_string());
            }
        };
        *guard = Some(child);
        stderr
    };

    // Nudge the bar before git's first percentage lands.
    let _ = app.emit(
        "clone-progress",
        CloneProgress {
            stage: "Connecting to remote".to_string(),
            pct: 0,
        },
    );

    // git delimits progress updates with `\r` and final phase lines with `\n`;
    // segment on both so each percentage tick is parsed as it arrives. Keep a
    // bounded transcript of the raw lines so a failure can return the real
    // `fatal:` message even though the same stream carried the progress.
    let mut segment = String::new();
    let mut transcript = String::new();
    let mut last: Option<CloneProgress> = None;
    let mut buf = [0u8; 4096];
    loop {
        match stderr.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                for ch in String::from_utf8_lossy(&buf[..n]).chars() {
                    if ch == '\r' || ch == '\n' {
                        emit_segment(app, &segment, &mut last, &mut transcript);
                        segment.clear();
                    } else {
                        segment.push(ch);
                    }
                }
            }
            Err(_) => break,
        }
    }
    // Flush any trailing partial segment (no final newline).
    emit_segment(app, &segment, &mut last, &mut transcript);

    // Reclaim the child and wait for the real exit status. If `cancel_clone`
    // killed it, the wait returns the (failed) signal status; the UI already
    // shows the canceled state, so the returned error is harmless there.
    let reclaimed = slot.lock().ok().and_then(|mut g| g.take());
    let success = match reclaimed {
        Some(mut c) => c
            .wait()
            .map_err(|e| format!("git clone failed: {e}"))?
            .success(),
        None => false,
    };

    if success {
        // Snap the bar to 100% before the UI swaps to the success screen.
        let _ = app.emit(
            "clone-progress",
            CloneProgress {
                stage: "Done".to_string(),
                pct: 100,
            },
        );
        Ok(dest.to_string())
    } else {
        // A failed or canceled clone can leave a partial `.git` / checkout. If we
        // created the destination for this clone, remove it so the path is clean
        // (matching the canceled-state copy) and a retry doesn't hit "already
        // exists". Best-effort: a removal failure must not mask the real error.
        if cleanup_eligible {
            let _ = std::fs::remove_dir_all(dest);
        }
        Err(extract_error(&transcript))
    }
}

/// Parse one stderr `segment`, emitting `clone-progress` when it advances the
/// bar, and append the raw segment to `transcript` (bounded) for error reporting.
fn emit_segment(
    app: &AppHandle,
    segment: &str,
    last: &mut Option<CloneProgress>,
    transcript: &mut String,
) {
    let trimmed = segment.trim();
    if trimmed.is_empty() {
        return;
    }
    record_transcript(transcript, trimmed);
    if let Some(progress) = parse_progress(trimmed) {
        if last.as_ref() != Some(&progress) {
            let _ = app.emit("clone-progress", progress.clone());
            *last = Some(progress);
        }
    }
}

/// Append `line` to the bounded transcript, keeping only the most recent ~8 KiB.
/// Clone failures (auth, not-found) surface early, but receiving-objects progress
/// can be voluminous, so cap the buffer rather than grow it for a big clone.
fn record_transcript(transcript: &mut String, line: &str) {
    transcript.push_str(line);
    transcript.push('\n');
    const CAP: usize = 8 * 1024;
    if transcript.len() > CAP {
        let cut = transcript.len() - CAP;
        // Trim on a char boundary so we never split a UTF-8 sequence.
        let start = (cut..transcript.len())
            .find(|&i| transcript.is_char_boundary(i))
            .unwrap_or(transcript.len());
        *transcript = transcript[start..].to_string();
    }
}

/// Pull the meaningful failure text out of the captured stderr transcript: the
/// `fatal:`/`error:` lines git prints on failure. Falls back to the last
/// non-empty line, then the whole transcript, so an error is never empty.
fn extract_error(transcript: &str) -> String {
    let fatal: Vec<&str> = transcript
        .lines()
        .map(str::trim)
        .filter(|l| l.starts_with("fatal:") || l.starts_with("error:"))
        .collect();
    if !fatal.is_empty() {
        return fatal.join("\n");
    }
    transcript
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .last()
        .map(str::to_string)
        .unwrap_or_else(|| transcript.trim().to_string())
}

/// Map one git progress line to a blended overall-percent + friendly stage.
/// Each git phase reports its own `0..100`; we map them onto disjoint slices of
/// the overall bar so it only ever moves forward. Returns `None` for lines that
/// aren't a recognised progress phase (so plain messages don't move the bar).
fn parse_progress(line: &str) -> Option<CloneProgress> {
    // (stage label, overall base, overall span) per git phase.
    let phase = |needle: &str| line.contains(needle);
    let (stage, base, span) = if phase("Enumerating objects") || phase("Counting objects") {
        ("Counting objects", 0u32, 5u32)
    } else if phase("Compressing objects") {
        ("Counting objects", 5, 5)
    } else if phase("Receiving objects") {
        ("Receiving objects", 10, 75)
    } else if phase("Resolving deltas") {
        ("Resolving deltas", 85, 12)
    } else if phase("Updating files") || phase("Checking out files") {
        ("Checking out files", 97, 3)
    } else {
        return None;
    };
    let pct = parse_percent(line)?;
    let overall = (base + span * pct / 100).min(100);
    Some(CloneProgress {
        stage: stage.to_string(),
        pct: overall as u8,
    })
}

/// Extract the `NN` from the first `NN%` in `line` (clamped to `0..=100`).
fn parse_percent(line: &str) -> Option<u32> {
    let percent = line.find('%')?;
    let bytes = line.as_bytes();
    let mut start = percent;
    while start > 0 && bytes[start - 1].is_ascii_digit() {
        start -= 1;
    }
    if start == percent {
        return None;
    }
    line[start..percent].parse::<u32>().ok().map(|p| p.min(100))
}

/// Whether a failed/canceled clone may remove `dest`: it doesn't exist yet (we
/// create it) or it's an empty directory the user pointed us at. A pre-existing
/// non-empty dir is never eligible — git won't clone into one anyway, and we must
/// not delete the user's files.
fn clone_cleanup_eligible(dest: &std::path::Path) -> bool {
    !dest.exists()
        || std::fs::read_dir(dest)
            .map(|mut entries| entries.next().is_none())
            .unwrap_or(false)
}

/// Kill the in-flight clone child, if any. Idempotent: a no-op once the clone has
/// finished and reclaimed its handle.
pub fn cancel_clone(slot: &CloneSlot) -> Result<(), String> {
    if let Ok(mut guard) = slot.lock() {
        if let Some(child) = guard.as_mut() {
            let _ = child.kill();
        }
    }
    Ok(())
}

/// Initialize a new repository at `parent`/`name` on initial branch `branch`,
/// optionally seeding a README and a `.gitignore` template. Validates the target
/// isn't already a repo / a non-empty folder so init never lands the app on a
/// half-open or pre-existing repository. Returns the new repo's path.
pub fn init(
    parent: &str,
    name: &str,
    branch: &str,
    readme: bool,
    gitignore: &str,
) -> Result<String, String> {
    let parent = parent.trim().trim_end_matches('/');
    let name = name.trim();
    let branch = branch.trim();
    if parent.is_empty() {
        return Err("Choose a location for the new repository.".to_string());
    }
    if name.is_empty() {
        return Err("Enter a folder name for the new repository.".to_string());
    }
    // Reject `.`/`..`/separators so the new repo is always a fresh child of the
    // chosen parent (shared with the clone destination leaf check).
    ensure_safe_leaf(name)?;
    let branch = if branch.is_empty() { "main" } else { branch };
    ensure_operand(name)?;
    ensure_operand(branch)?;

    let target = format!("{parent}/{name}");
    let target_path = std::path::Path::new(&target);
    if target_path.join(".git").exists() {
        return Err(format!("{target} is already a Git repository."));
    }
    let non_empty = std::fs::read_dir(&target)
        .map(|mut entries| entries.next().is_some())
        .unwrap_or(false);
    if non_empty {
        return Err(format!(
            "The folder {target} already exists and isn't empty. Choose an empty folder or a different name."
        ));
    }
    // Remember whether the directory already existed: a rollback must only remove
    // a directory this init created, never one the user already had.
    let existed_before = target_path.exists();
    std::fs::create_dir_all(&target).map_err(|e| format!("Couldn't create {target}: {e}"))?;

    // Run init + seed files as one fallible unit so a failure after the directory
    // exists can be rolled back rather than leaving an orphaned empty/partial repo.
    let seeded = (|| -> Result<(), String> {
        super::cli::run_git_bare(&["init", "-b", branch, &target])?;
        if readme {
            std::fs::write(target_path.join("README.md"), format!("# {name}\n"))
                .map_err(|e| format!("Couldn't write README.md: {e}"))?;
        }
        if let Some(contents) = gitignore_template(gitignore) {
            std::fs::write(target_path.join(".gitignore"), contents)
                .map_err(|e| format!("Couldn't write .gitignore: {e}"))?;
        }
        Ok(())
    })();

    if let Err(e) = seeded {
        if !existed_before {
            let _ = std::fs::remove_dir_all(&target);
        }
        return Err(e);
    }

    Ok(target)
}

/// Starter `.gitignore` contents for a named template, or `None` for "None" /
/// any unknown name (in which case no `.gitignore` is written). Deliberately
/// small, common-case templates rather than a full template library.
fn gitignore_template(name: &str) -> Option<&'static str> {
    match name.trim().to_ascii_lowercase().as_str() {
        "node" => Some("node_modules/\ndist/\nbuild/\n*.log\n.env\n.env.local\n.DS_Store\n"),
        "rust" => Some("/target\n**/*.rs.bk\nCargo.lock\n.DS_Store\n"),
        "python" => Some("__pycache__/\n*.py[cod]\n.venv/\nvenv/\n*.egg-info/\n.env\n.DS_Store\n"),
        "macos" => Some(".DS_Store\n.AppleDouble\n.LSOverride\n._*\n.Spotlight-V100\n.Trashes\n"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_percent_reads_digits_before_the_sign() {
        assert_eq!(parse_percent("Receiving objects:  73% (730/1000)"), Some(73));
        assert_eq!(parse_percent("Resolving deltas: 100% (50/50), done."), Some(100));
        assert_eq!(parse_percent("remote: Counting objects: 5% (1/20)"), Some(5));
    }

    #[test]
    fn parse_percent_is_none_without_a_percentage() {
        assert_eq!(parse_percent("Cloning into 'repo'..."), None);
        assert_eq!(parse_percent("done."), None);
        assert_eq!(parse_percent("%"), None);
    }

    #[test]
    fn parse_progress_blends_phases_onto_a_monotonic_bar() {
        // Enumerate/count occupy the first slice.
        let counting = parse_progress("remote: Counting objects: 100% (20/20)").unwrap();
        assert_eq!(counting.stage, "Counting objects");
        assert_eq!(counting.pct, 5);

        // Receiving dominates the middle.
        let receiving = parse_progress("Receiving objects: 100% (1000/1000)").unwrap();
        assert_eq!(receiving.stage, "Receiving objects");
        assert_eq!(receiving.pct, 85);

        // Resolving + checkout finish the bar.
        let resolving = parse_progress("Resolving deltas: 100% (300/300), done.").unwrap();
        assert_eq!(resolving.stage, "Resolving deltas");
        assert_eq!(resolving.pct, 97);

        let checkout = parse_progress("Updating files: 100% (42/42), done.").unwrap();
        assert_eq!(checkout.stage, "Checking out files");
        assert_eq!(checkout.pct, 100);
    }

    #[test]
    fn parse_progress_advances_within_a_phase() {
        let early = parse_progress("Receiving objects: 0% (1/1000)").unwrap();
        let mid = parse_progress("Receiving objects: 50% (500/1000)").unwrap();
        let done = parse_progress("Receiving objects: 100% (1000/1000)").unwrap();
        assert!(early.pct < mid.pct && mid.pct < done.pct);
        assert_eq!(early.pct, 10); // base of the receiving slice
    }

    #[test]
    fn parse_progress_ignores_non_progress_lines() {
        assert!(parse_progress("Cloning into 'repo'...").is_none());
        assert!(parse_progress("fatal: repository not found").is_none());
    }

    #[test]
    fn extract_error_prefers_fatal_lines() {
        let transcript = "Cloning into 'core'...\nremote: Enumerating objects: 10\nfatal: Authentication failed for 'https://example.com/x.git'\n";
        assert_eq!(
            extract_error(transcript),
            "fatal: Authentication failed for 'https://example.com/x.git'"
        );
    }

    #[test]
    fn extract_error_falls_back_to_last_line() {
        let transcript = "warning: something odd\nsome trailing note\n";
        assert_eq!(extract_error(transcript), "some trailing note");
    }

    #[test]
    fn record_transcript_is_bounded_and_char_safe() {
        let mut t = String::new();
        for _ in 0..2000 {
            record_transcript(&mut t, "Receiving objects: 50% (500/1000), 12.30 MiB | 4 MiB/s");
        }
        assert!(t.len() <= 8 * 1024 + 64);
        // Still valid UTF-8 / not split mid-char (String guarantees this; the
        // boundary trim must keep it intact).
        assert!(t.is_char_boundary(0));
    }

    #[test]
    fn cleanup_eligibility_covers_absent_and_empty_dirs_only() {
        let base = std::env::temp_dir().join(format!("gitlane-clone-elig-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let absent = base.join("absent");
        let empty = base.join("empty");
        let nonempty = base.join("nonempty");
        std::fs::create_dir_all(&empty).unwrap();
        std::fs::create_dir_all(&nonempty).unwrap();
        std::fs::write(nonempty.join("file.txt"), "x").unwrap();

        assert!(clone_cleanup_eligible(&absent), "absent dir is eligible");
        assert!(clone_cleanup_eligible(&empty), "empty dir is eligible");
        assert!(!clone_cleanup_eligible(&nonempty), "non-empty dir is not eligible");

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn init_rejects_dot_segment_and_separator_names() {
        // Validation fails before any filesystem/git work, so a throwaway parent
        // is fine — nothing is created on disk.
        for bad in [".", "..", "a/b", "a\\b", ""] {
            assert!(
                super::init("/tmp", bad, "main", false, "None").is_err(),
                "init should reject name {bad:?}"
            );
        }
    }

    #[test]
    fn gitignore_templates_resolve_known_names_only() {
        assert!(gitignore_template("Node").is_some());
        assert!(gitignore_template("rust").is_some());
        assert!(gitignore_template("None").is_none());
        assert!(gitignore_template("").is_none());
        assert!(gitignore_template("whatever").is_none());
    }
}
