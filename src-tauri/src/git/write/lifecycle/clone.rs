//! The clone itself: argument validation, the spawned `git clone --progress`,
//! the stderr transcript it is parsed from, and cancellation.
//!
//! Progress reaches the caller as a callback rather than an `AppHandle` so the
//! clone stays reachable from a unit test; production passes the
//! `clone-progress` emitter (GL-355).

use std::io::Read;
use std::path::Path;
use std::process::Stdio;

use super::super::operands::{ensure_safe_leaf, ensure_url_has_no_credentials};
use super::publish::CloneTarget;
use super::{ClonePhase, CloneProgress, CloneSlot};
use crate::git::transport_auth::TransportCredential;

/// Clone `url` into `dest`, reporting phase progress to `progress`.
///
/// Runs on the blocking pool (see `lib::blocking`). The spawned child is parked
/// in `slot` so a concurrent [`crate::commands::repo::cancel_clone`] can terminate it; stderr is read
/// to EOF (calling `progress` as phases advance) and then the real exit status
/// decides success. On failure the meaningful `fatal:`/`error:` lines are
/// returned so the UI can classify the failure (exists / auth / unreachable).
///
/// Progress is a callback rather than an `AppHandle` so the clone is reachable
/// from a unit test; production passes the `clone-progress` emitter (GL-355).
pub fn clone(
    progress: &dyn Fn(&CloneProgress),
    slot: CloneSlot,
    url: &str,
    dest: &str,
    cred: &TransportCredential,
) -> Result<String, String> {
    let url = validated_clone_url(url)?;
    let dest = validated_clone_destination(dest)?;

    // Clone into a random sibling that only this operation owns, then publish
    // after Git succeeds. This also applies when the user selected an existing
    // empty directory: cancellation can remove the private partial clone while
    // leaving that user-owned directory untouched.
    let mut clone_target = CloneTarget::prepare(dest)?;

    // `--` stops a URL that begins with `-` from being read as an option; `dest`
    // is an absolute path the UI built, so it can never be one. `LC_ALL=C` keeps
    // the progress text English and byte-stable for the parser regardless of the
    // user's locale. git Command construction (incl. PATH) is centralized in
    // cli::git_command_bare. The credential bridge contributes the `-c` config
    // prefix (gh helper or GIT_ASKPASS clear) and any env (the ephemeral askpass
    // broker capability).
    let inv = crate::git::credential_bridge::git_invocation(cred)?;
    let args = clone_args(&inv.config, url, clone_target.work_arg()?);
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let mut cmd = super::super::cli::git_command_bare(&arg_refs)?;
    cmd.env("LC_ALL", "C")
        .env("LANG", "C")
        // git writes progress + errors to stderr; stdout carries nothing we need,
        // so null it to avoid an unread pipe.
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    for (key, value) in &inv.env {
        cmd.env(key, value);
    }

    // Spawn and park the child atomically under the slot lock, refusing to start
    // a second clone while one is already in flight — that would orphan the first
    // process and make `cancel_clone` target the wrong one.
    let mut stderr = {
        let mut guard = slot.lock().map_err(|e| e.to_string())?;
        if guard.phase != ClonePhase::Idle {
            return Err("A clone is already in progress.".to_string());
        }
        let mut child = cmd.spawn().map_err(super::super::cli::launch_error)?;
        // Kill the just-spawned child if we can't capture its output, rather than
        // leaving an untracked process running (it was never parked in the slot).
        let stderr = match child.stderr.take() {
            Some(stderr) => stderr,
            None => {
                let _ = child.kill();
                return Err("failed to capture git output".to_string());
            }
        };
        guard.child = Some(child);
        guard.phase = ClonePhase::Running;
        stderr
    };

    // Nudge the bar before git's first percentage lands.
    progress(&CloneProgress {
        stage: "Connecting to remote".to_string(),
        pct: 0,
    });

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
                        emit_segment(progress, &segment, &mut last, &mut transcript);
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
    emit_segment(progress, &segment, &mut last, &mut transcript);

    // Reclaim the child and wait for the real exit status. If `cancel_clone`
    // killed it, the wait returns the (failed) signal status; the UI already
    // shows the canceled state, so the returned error is harmless there.
    let reclaimed = slot.lock().ok().and_then(|mut g| g.child.take());
    let success = match reclaimed {
        Some(mut c) => match c.wait() {
            Ok(status) => status.success(),
            Err(err) => {
                reset_clone_operation(&slot);
                return Err(format!("git clone failed: {err}"));
            }
        },
        None => false,
    };

    if success {
        if !claim_clone_publication(&slot)? {
            return Err("Clone canceled.".to_string());
        }
        let published = clone_target.publish();
        if let Ok(mut guard) = slot.lock() {
            guard.phase = if published.is_ok() {
                ClonePhase::Committed
            } else {
                ClonePhase::Idle
            };
        }
        published?;
        // Snap the bar to 100% before the UI swaps to the success screen.
        progress(&CloneProgress {
            stage: "Done".to_string(),
            pct: 100,
        });
        reset_clone_operation(&slot);
        Ok(dest.to_string_lossy().into_owned())
    } else {
        reset_clone_operation(&slot);
        // Dropping a private CloneTarget removes only its unpredictable staging
        // sibling. A pre-existing destination is deliberately left untouched.
        Err(extract_error(&transcript))
    }
}

/// Validate the source before any clone process or filesystem work begins.
/// Credentials belong in Git's helper/keychain flow, never in a URL that Git can
/// echo in progress output or persist in the cloned repository's remote config.
pub(super) fn validated_clone_url(url: &str) -> Result<&str, String> {
    let url = url.trim();
    if url.is_empty() {
        return Err("Enter a repository URL to clone.".to_string());
    }
    ensure_url_has_no_credentials(url)?;
    Ok(url)
}

pub(super) fn validated_clone_destination(dest: &str) -> Result<&Path, String> {
    let dest = dest.trim();
    if dest.is_empty() {
        return Err("Choose a destination folder for the clone.".to_string());
    }
    // Check the raw final component before `Path` normalization: Rust drops a
    // trailing `/.` component, which would otherwise turn `/parent/.` into the
    // apparently safe leaf `parent`. Recognise both separators so Windows-form
    // input is also rejected when tests or IPC reach a Unix build.
    let lexical = dest.trim_end_matches(['/', '\\']);
    let lexical_leaf = lexical.rsplit(['/', '\\']).next().unwrap_or("");
    ensure_safe_leaf(lexical_leaf).map_err(|_| "Choose a valid destination folder.".to_string())?;
    // Use platform-aware Path parsing, then apply the shared cross-platform
    // leaf guard. A slash-only split misses `C:\parent\..` on Windows and can
    // make the clone target the parent/grandparent instead of a fresh child.
    let path = Path::new(dest);
    let leaf = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Choose a valid destination folder.".to_string())?;
    ensure_safe_leaf(leaf).map_err(|_| "Choose a valid destination folder.".to_string())?;
    Ok(path)
}

pub(super) fn claim_clone_publication(slot: &CloneSlot) -> Result<bool, String> {
    let mut guard = slot.lock().map_err(|err| err.to_string())?;
    match guard.phase {
        ClonePhase::Running => {
            guard.phase = ClonePhase::Publishing;
            Ok(true)
        }
        ClonePhase::Cancelled => {
            guard.phase = ClonePhase::Idle;
            Ok(false)
        }
        _ => Err("Clone lifecycle changed before publication.".to_string()),
    }
}

fn reset_clone_operation(slot: &CloneSlot) {
    if let Ok(mut guard) = slot.lock() {
        guard.child = None;
        guard.phase = ClonePhase::Idle;
    }
}

fn clone_args(config_prefix: &[String], url: &str, dest: &str) -> Vec<String> {
    let mut args = config_prefix.to_vec();
    args.extend([
        "clone".to_string(),
        "--progress".to_string(),
        "--".to_string(),
        url.to_string(),
        dest.to_string(),
    ]);
    args
}

/// Parse one stderr `segment`, calling `progress_sink` when it advances the bar,
/// and append the raw segment to `transcript` (bounded) for error reporting.
fn emit_segment(
    progress_sink: &dyn Fn(&CloneProgress),
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
            progress_sink(&progress);
            *last = Some(progress);
        }
    }
}

/// Append `line` to the bounded transcript, keeping only the most recent ~8 KiB.
/// Clone failures (auth, not-found) surface early, but receiving-objects progress
/// can be voluminous, so cap the buffer rather than grow it for a big clone.
pub(super) fn record_transcript(transcript: &mut String, line: &str) {
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

/// Whether a `remote:` line is the server explaining itself (Bitbucket's
/// "API Token provided has no Bitbucket scopes.", GitHub's deprecation
/// notices) rather than object-transfer chatter. The explanation is often the
/// only place the actual cause appears, so it must survive into the error.
fn is_remote_note(line: &str) -> bool {
    let Some(payload) = line.strip_prefix("remote:") else {
        return false;
    };
    let payload = payload.trim_start();
    !(payload.is_empty()
        || payload.starts_with("Enumerating objects")
        || payload.starts_with("Counting objects")
        || payload.starts_with("Compressing objects")
        || payload.starts_with("Total "))
}

/// Pull the meaningful failure text out of the captured stderr transcript: the
/// server's own `remote:` explanation lines plus the `fatal:`/`error:` lines
/// git prints on failure. Falls back to the last non-empty line, then the
/// whole transcript, so an error is never empty.
pub(super) fn extract_error(transcript: &str) -> String {
    let raw = {
        let fatal: Vec<&str> = transcript
            .lines()
            .map(str::trim)
            .filter(|l| is_remote_note(l) || l.starts_with("fatal:") || l.starts_with("error:"))
            .collect();
        if !fatal.is_empty() {
            fatal.join("\n")
        } else {
            transcript
                .lines()
                .map(str::trim)
                .rfind(|l| !l.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| transcript.trim().to_string())
        }
    };
    // A failed clone often echoes the source URL; scrub any embedded credential.
    crate::redact::redact_secrets(&raw)
}

/// Map one git progress line to a blended overall-percent + friendly stage.
/// Each git phase reports its own `0..100`; we map them onto disjoint slices of
/// the overall bar so it only ever moves forward. Returns `None` for lines that
/// aren't a recognised progress phase (so plain messages don't move the bar).
pub(super) fn parse_progress(line: &str) -> Option<CloneProgress> {
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
pub(super) fn parse_percent(line: &str) -> Option<u32> {
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

/// Kill the in-flight clone child, if any. Idempotent: a no-op once the clone has
/// finished and reclaimed its handle.
pub fn cancel_clone(slot: &CloneSlot) -> Result<(), String> {
    let mut guard = slot.lock().map_err(|err| err.to_string())?;
    match guard.phase {
        ClonePhase::Running => {
            guard.phase = ClonePhase::Cancelled;
            if let Some(child) = guard.child.as_mut() {
                let _ = child.kill();
            }
            Ok(())
        }
        ClonePhase::Cancelled => Ok(()),
        ClonePhase::Publishing | ClonePhase::Committed => {
            Err("The clone has already finished and is being published.".to_string())
        }
        ClonePhase::Idle => Err("No clone is in progress.".to_string()),
    }
}
