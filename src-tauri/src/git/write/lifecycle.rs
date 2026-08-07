//! Repository lifecycle writes: **clone** (with live progress) and **init**.
//!
//! These are the only writes that operate *outside* an existing repository, so
//! they don't go through `git -C <repo>` like every other write — they use
//! [`super::cli::run_git_bare`] / a freshly spawned `git clone`. Clone is also
//! the one streaming write: it spawns `git clone --progress`, parses the phase
//! percentages off stderr, and emits a `clone-progress` event so the onboarding
//! UI can paint a real determinate bar and cancel an in-flight clone (GL-38).

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::{Arc, Mutex};

use serde::Serialize;

use super::operands::{ensure_operand, ensure_safe_leaf, ensure_url_has_no_credentials};
use super::progress::ProgressSink;
use crate::git::transport_auth::TransportCredential;

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

/// Shared clone lifecycle. Cancellation stays sticky after the child is
/// reclaimed so it can still win the final race against publishing staging.
pub type CloneSlot = Arc<Mutex<CloneOperation>>;

#[derive(Default)]
pub struct CloneOperation {
    child: Option<Child>,
    phase: ClonePhase,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
enum ClonePhase {
    #[default]
    Idle,
    Running,
    Cancelled,
    Publishing,
    Committed,
}

/// Clone `url` into `dest`, streaming progress to the frontend.
///
/// Runs on the blocking pool (see `lib::blocking`). The spawned child is parked
/// in `slot` so a concurrent [`cancel_clone`] can terminate it; stderr is read
/// to EOF (emitting `clone-progress` as phases advance) and then the real exit
/// status decides success. On failure the meaningful `fatal:`/`error:` lines are
/// returned so the UI can classify the failure (exists / auth / unreachable).
pub fn clone(
    progress: &dyn ProgressSink,
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
    let mut cmd = super::cli::git_command_bare(&arg_refs)?;
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
        guard.child = Some(child);
        guard.phase = ClonePhase::Running;
        stderr
    };

    // Nudge the bar before git's first percentage lands.
    progress.emit(&CloneProgress {
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
        progress.emit(&CloneProgress {
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
fn validated_clone_url(url: &str) -> Result<&str, String> {
    let url = url.trim();
    if url.is_empty() {
        return Err("Enter a repository URL to clone.".to_string());
    }
    ensure_url_has_no_credentials(url)?;
    Ok(url)
}

fn validated_clone_destination(dest: &str) -> Result<&Path, String> {
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

fn claim_clone_publication(slot: &CloneSlot) -> Result<bool, String> {
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

/// Owns the filesystem target for one clone. All requested paths use a private
/// sibling so rollback never races with files created at the public path.
struct CloneTarget {
    requested: PathBuf,
    work: PathBuf,
    owns_work: bool,
    publish_into_existing: bool,
}

impl CloneTarget {
    fn prepare(requested: &Path) -> Result<Self, String> {
        let publish_into_existing = match std::fs::symlink_metadata(requested) {
            Ok(metadata) => {
                if !metadata.file_type().is_dir() {
                    return Err(
                        "The clone destination already exists and isn't a folder.".to_string()
                    );
                }
                let mut entries = std::fs::read_dir(requested)
                    .map_err(|err| format!("Couldn't inspect the clone destination: {err}"))?;
                if entries.next().is_some() {
                    return Err("The clone destination already exists and isn't empty.".to_string());
                }
                true
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => false,
            Err(err) => return Err(format!("Couldn't inspect the clone destination: {err}")),
        };
        let parent = requested
            .parent()
            .ok_or_else(|| "Choose a clone destination with a parent folder.".to_string())?;
        for _ in 0..16 {
            let work = parent.join(format!(".gitlane-clone-{}", random_clone_nonce()?));
            match std::fs::create_dir(&work) {
                Ok(()) => {
                    return Ok(Self {
                        requested: requested.to_path_buf(),
                        work,
                        owns_work: true,
                        publish_into_existing,
                    })
                }
                Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(err) => return Err(format!("Couldn't prepare the clone destination: {err}")),
            }
        }
        Err("Couldn't allocate a private clone destination.".to_string())
    }

    fn work_arg(&self) -> Result<&str, String> {
        self.work
            .to_str()
            .ok_or_else(|| "The clone destination is not valid UTF-8.".to_string())
    }

    fn publish(&mut self) -> Result<(), String> {
        // Remove the still-empty user-owned directory immediately before the
        // no-replace publish. If anything appeared since prepare(), remove_dir
        // fails and leaves it untouched. Publishing never walks a user-owned
        // path, so a concurrent symlink swap cannot redirect clone contents.
        let removed_existing = self.publish_into_existing;
        if removed_existing {
            std::fs::remove_dir(&self.requested).map_err(|err| {
                format!("The clone finished, but the destination is no longer empty: {err}")
            })?;
            self.publish_into_existing = false;
        }
        match rename_no_replace(&self.work, &self.requested) {
            Ok(()) => {
                self.owns_work = false;
                Ok(())
            }
            Err(err)
                if matches!(
                    err.kind(),
                    std::io::ErrorKind::Unsupported | std::io::ErrorKind::InvalidInput
                ) =>
            {
                // exFAT/SMB/NFS commonly support ordinary rename but not the
                // platform's no-replace flag. Claim the public directory
                // exclusively, then populate it without ever replacing a leaf.
                // Once claimed, preserve both trees on a partial failure: Drop
                // must not erase the completed clone remainder.
                self.claim_fallback_destination(removed_existing, |path| {
                    std::fs::create_dir(path)
                })?;
                publish_directory_fallback(&self.work, &self.requested).map_err(|move_err| {
                    format!(
                        "The clone finished, but publishing it failed. The partial destination and private clone staging were preserved: {move_err}"
                    )
                })
            }
            Err(err) => {
                // Restore the empty directory the user selected when the
                // platform publish itself fails before creating anything.
                if removed_existing {
                    let _ = std::fs::create_dir(&self.requested);
                }
                Err(format!(
                    "The clone finished, but the destination became unavailable: {err}"
                ))
            }
        }
    }

    fn claim_fallback_destination(
        &mut self,
        removed_existing: bool,
        claim: impl FnOnce(&Path) -> std::io::Result<()>,
    ) -> Result<(), String> {
        if let Err(claim_err) = claim(&self.requested) {
            // The clone itself is complete. A destination claim failure must
            // never turn Drop back into destructive rollback; leave staging
            // recoverable and restore the user's original empty directory on
            // best effort when publish() removed it above.
            self.owns_work = false;
            let restore_note = if removed_existing {
                match std::fs::create_dir(&self.requested) {
                    Ok(()) => " The original empty destination was restored.".to_string(),
                    Err(restore_err) => format!(
                        " The original empty destination could not be restored: {restore_err}."
                    ),
                }
            } else {
                String::new()
            };
            return Err(format!(
                "The clone finished, but the destination became unavailable: {claim_err}. The completed private clone staging was preserved at {}.{restore_note}",
                self.work.display()
            ));
        }
        self.owns_work = false;
        Ok(())
    }
}

/// Populate an exclusively-created destination without replacing any leaf.
/// Regular files use hard links (same sibling filesystem) and fall back to an
/// exclusive copy when links are unsupported. Directories and symlinks are
/// likewise created with no-replace primitives. Source entries are removed only
/// after their destination is complete, so a failure leaves recoverable data.
fn publish_directory_fallback(from: &Path, to: &Path) -> std::io::Result<()> {
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let source = entry.path();
        let destination = to.join(entry.file_name());
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            let permissions = entry.metadata()?.permissions();
            std::fs::create_dir(&destination)?;
            publish_directory_fallback(&source, &destination)?;
            std::fs::set_permissions(&destination, permissions)?;
        } else if file_type.is_file() {
            move_regular_file_no_replace(&source, &destination, &entry.metadata()?)?;
        } else if file_type.is_symlink() {
            move_symlink_no_replace(&source, &destination)?;
        } else {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Unsupported,
                format!("unsupported clone entry type at {}", source.display()),
            ));
        }
    }
    std::fs::remove_dir(from)
}

fn move_regular_file_no_replace(
    from: &Path,
    to: &Path,
    metadata: &std::fs::Metadata,
) -> std::io::Result<()> {
    match std::fs::hard_link(from, to) {
        Ok(()) => std::fs::remove_file(from),
        Err(err)
            if matches!(
                err.kind(),
                std::io::ErrorKind::Unsupported | std::io::ErrorKind::PermissionDenied
            ) =>
        {
            let mut source = std::fs::File::open(from)?;
            // Open separately so cleanup below runs only after *our* exclusive
            // create succeeded; an AlreadyExists error may belong to a
            // concurrent writer and must never remove that writer's file.
            let mut destination = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(to)?;
            let copied = (|| -> std::io::Result<()> {
                std::io::copy(&mut source, &mut destination)?;
                destination.set_permissions(metadata.permissions())?;
                destination.sync_all()
            })();
            if let Err(copy_err) = copied {
                let _ = std::fs::remove_file(to);
                return Err(copy_err);
            }
            std::fs::remove_file(from)
        }
        Err(err) => Err(err),
    }
}

#[cfg(unix)]
fn move_symlink_no_replace(from: &Path, to: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(std::fs::read_link(from)?, to)?;
    std::fs::remove_file(from)
}

#[cfg(windows)]
fn move_symlink_no_replace(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::os::windows::fs::{symlink_dir, symlink_file, FileTypeExt};

    let target = std::fs::read_link(from)?;
    let kind = std::fs::symlink_metadata(from)?.file_type();
    if kind.is_symlink_dir() {
        symlink_dir(target, to)?;
    } else if kind.is_symlink_file() {
        symlink_file(target, to)?;
    } else {
        return Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "unknown Windows symlink type in clone staging",
        ));
    }
    std::fs::remove_file(from)
}

#[cfg(not(any(unix, windows)))]
fn move_symlink_no_replace(from: &Path, to: &Path) -> std::io::Result<()> {
    let _ = (from, to);
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "publishing symlinks is unsupported on this platform",
    ))
}

/// Publish without replacing any destination that appeared during the clone.
/// Linux/Android and Apple expose explicit no-replace flags; Windows' rename
/// already fails when the destination exists. Other targets fail closed rather
/// than falling back to Unix rename semantics that may replace an empty folder.
#[cfg(any(target_os = "linux", target_os = "android", target_vendor = "apple"))]
fn rename_no_replace(from: &Path, to: &Path) -> std::io::Result<()> {
    use rustix::fs::{renameat_with, RenameFlags, CWD};

    renameat_with(CWD, from, CWD, to, RenameFlags::NOREPLACE).map_err(Into::into)
}

#[cfg(target_os = "windows")]
fn rename_no_replace(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::rename(from, to)
}

#[cfg(not(any(
    target_os = "linux",
    target_os = "android",
    target_os = "windows",
    target_vendor = "apple"
)))]
fn rename_no_replace(from: &Path, to: &Path) -> std::io::Result<()> {
    let _ = (from, to);
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "atomic no-replace rename is unsupported on this platform",
    ))
}

impl Drop for CloneTarget {
    fn drop(&mut self) {
        if self.owns_work {
            let _ = std::fs::remove_dir_all(&self.work);
        }
    }
}

fn random_clone_nonce() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes)
        .map_err(|err| format!("Couldn't secure the clone destination: {err}"))?;
    let mut nonce = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(nonce, "{byte:02x}");
    }
    Ok(nonce)
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

/// Parse one stderr `segment`, emitting `clone-progress` when it advances the
/// bar, and append the raw segment to `transcript` (bounded) for error reporting.
fn emit_segment(
    sink: &dyn ProgressSink,
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
            sink.emit(&progress);
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
fn extract_error(transcript: &str) -> String {
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
    let parent_path = Path::new(parent);
    if !parent_path.is_absolute() {
        return Err("Choose an absolute location for the new repository.".to_string());
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

    let target_path = parent_path.join(name);
    let target = target_path.to_string_lossy().to_string();
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
        super::cli::run_git_bare(&["init", "-b", branch, "--", &target])?;
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

/// Initialize an already-existing, possibly non-empty directory as a git
/// repository **in place** — the "Initialize as git repo" recovery action for
/// a folder that lost its `.git` (GL-108's `notARepository` case, GL-153).
/// Unlike [`init`], this never scaffolds a README/`.gitignore` and never
/// rejects a non-empty directory (the whole point is adopting the user's
/// existing files); it only refuses a path that isn't a real directory or is
/// already a *valid* repo. Returns the canonical repo path from the post-init
/// open probe (same normalization as [`crate::git::read::summary_classified`]).
pub fn init_in_place(path: &str) -> Result<String, String> {
    if path.trim().is_empty() {
        return Err("Choose a folder to initialize.".to_string());
    }
    ensure_operand(path)?;
    let target_path = std::path::Path::new(path);
    if !target_path.is_dir() {
        return Err(format!("{path} is not a folder."));
    }
    // Block only when libgit2 can open the repo — the same probe `open_repo`
    // uses — so this action never disagrees with the missing-repo screen's
    // `notARepository` classification (GL-153 review). A broken or
    // partially-initialized `.git` still fails that probe and is repaired by
    // `git init` below; only a genuinely openable repo is rejected.
    if crate::git::read::summary_classified(path).is_ok() {
        return Err(format!(
            "{path} is already a Git repository — try Retry to open it."
        ));
    }
    // A `.git` *file* (a linked worktree's gitdir pointer) that failed the
    // open probe above is dangling — unlike a `.git` *directory*, which `init`
    // repairs in place (tested above), git refuses to `init` over a `.git`
    // file at all, even a broken one, so remove it first (GL-153 review).
    // Never touch a `.git` directory here; only a plain file, which we've
    // just proven libgit2 cannot open, is safe to replace.
    let dot_git = target_path.join(".git");
    if dot_git.is_file() {
        std::fs::remove_file(&dot_git)
            .map_err(|e| format!("Couldn't remove the stale .git file at {path}: {e}"))?;
    }
    super::cli::run_git_bare(&["init", "--", path])?;
    crate::git::read::summary_classified(path)
        .map(|summary| summary.path)
        .map_err(|e| e.message)
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
    fn clone_url_rejects_password_userinfo_but_keeps_username_selectors() {
        assert_eq!(
            validated_clone_url(" https://alice@example.com/team/repo.git ").unwrap(),
            "https://alice@example.com/team/repo.git"
        );
        assert!(validated_clone_url("git@example.com:team/repo.git").is_ok());

        let error = validated_clone_url("https://alice:clone-secret@example.com/team/repo.git")
            .unwrap_err();
        assert!(
            error.contains("must not contain"),
            "unexpected error: {error}"
        );
        assert!(
            !error.contains("clone-secret"),
            "clone validation echoed the secret: {error}"
        );
    }

    #[test]
    fn clone_destination_rejects_dot_segments_and_both_separator_styles() {
        assert!(validated_clone_destination("/tmp/new-repo").is_ok());
        for invalid in ["", "/", "/tmp/..", "/tmp/.", r"C:\parent\.."] {
            assert!(
                validated_clone_destination(invalid).is_err(),
                "{invalid:?} should not be a clone leaf"
            );
        }
    }

    #[test]
    fn parse_percent_reads_digits_before_the_sign() {
        assert_eq!(
            parse_percent("Receiving objects:  73% (730/1000)"),
            Some(73)
        );
        assert_eq!(
            parse_percent("Resolving deltas: 100% (50/50), done."),
            Some(100)
        );
        assert_eq!(
            parse_percent("remote: Counting objects: 5% (1/20)"),
            Some(5)
        );
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
    fn extract_error_keeps_the_servers_own_explanation() {
        let transcript = "Cloning into 'r'...\nremote: Enumerating objects: 10\nremote: API Token provided has no Bitbucket scopes.\nfatal: unable to access 'https://bitbucket.org/w/r.git/': The requested URL returned error: 403\n";
        assert_eq!(
            extract_error(transcript),
            "remote: API Token provided has no Bitbucket scopes.\nfatal: unable to access 'https://bitbucket.org/w/r.git/': The requested URL returned error: 403"
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
            record_transcript(
                &mut t,
                "Receiving objects: 50% (500/1000), 12.30 MiB | 4 MiB/s",
            );
        }
        assert!(t.len() <= 8 * 1024 + 64);
        // Still valid UTF-8 / not split mid-char (String guarantees this; the
        // boundary trim must keep it intact).
        assert!(t.is_char_boundary(0));
    }

    #[test]
    fn private_clone_target_preserves_a_concurrent_destination_on_publish_failure() {
        let base = std::env::temp_dir().join(format!("gitlane-clone-race-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let requested = base.join("repo");
        let mut target = CloneTarget::prepare(&requested).unwrap();
        let work = target.work.clone();
        std::fs::write(work.join("clone-owned.txt"), "clone").unwrap();

        // Another process wins the public destination while clone is running.
        std::fs::create_dir(&requested).unwrap();
        std::fs::write(requested.join("concurrent.txt"), "keep").unwrap();
        assert!(target.publish().is_err());
        drop(target);

        assert_eq!(
            std::fs::read_to_string(requested.join("concurrent.txt")).unwrap(),
            "keep"
        );
        assert!(!work.exists(), "only private clone staging is rolled back");

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn cancellation_wins_after_child_reclaim_but_before_publication() {
        let slot = CloneSlot::default();
        slot.lock().unwrap().phase = ClonePhase::Running;

        cancel_clone(&slot).expect("cancel before publication");

        assert!(!claim_clone_publication(&slot).expect("publication decision"));
        assert_eq!(slot.lock().unwrap().phase, ClonePhase::Idle);
    }

    #[test]
    fn publication_wins_atomically_against_a_late_cancel() {
        let slot = CloneSlot::default();
        slot.lock().unwrap().phase = ClonePhase::Running;

        assert!(claim_clone_publication(&slot).expect("claim publication"));

        assert!(cancel_clone(&slot).is_err());
        assert_eq!(slot.lock().unwrap().phase, ClonePhase::Publishing);
    }

    #[test]
    fn private_clone_target_publishes_atomically() {
        let base =
            std::env::temp_dir().join(format!("gitlane-clone-publish-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let requested = base.join("repo");
        let mut target = CloneTarget::prepare(&requested).unwrap();
        let work = target.work.clone();
        std::fs::write(work.join("README.md"), "done").unwrap();

        target.publish().unwrap();

        assert!(!work.exists());
        assert_eq!(
            std::fs::read_to_string(requested.join("README.md")).unwrap(),
            "done"
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn private_clone_target_does_not_replace_a_concurrent_empty_directory() {
        let base =
            std::env::temp_dir().join(format!("gitlane-clone-empty-race-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let requested = base.join("repo");
        let mut target = CloneTarget::prepare(&requested).unwrap();
        let work = target.work.clone();
        std::fs::write(work.join("clone-owned.txt"), "clone").unwrap();
        std::fs::create_dir(&requested).unwrap();

        assert!(target.publish().is_err());
        assert!(requested.is_dir());
        assert!(std::fs::read_dir(&requested).unwrap().next().is_none());
        drop(target);
        assert!(!work.exists());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn fallback_publish_moves_a_complete_tree_without_replacing_entries() {
        let base = std::env::temp_dir().join(format!(
            "gitlane-clone-fallback-publish-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&base);
        let work = base.join("work");
        let requested = base.join("repo");
        std::fs::create_dir_all(work.join("nested")).unwrap();
        std::fs::create_dir(&requested).unwrap();
        std::fs::write(work.join("README.md"), "done").unwrap();
        std::fs::write(work.join("nested/file.txt"), "nested").unwrap();

        publish_directory_fallback(&work, &requested).unwrap();

        assert!(!work.exists());
        assert_eq!(
            std::fs::read_to_string(requested.join("README.md")).unwrap(),
            "done"
        );
        assert_eq!(
            std::fs::read_to_string(requested.join("nested/file.txt")).unwrap(),
            "nested"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn fallback_publish_preserves_source_when_a_destination_leaf_appears() {
        let base = std::env::temp_dir().join(format!(
            "gitlane-clone-fallback-collision-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&base);
        let work = base.join("work");
        let requested = base.join("repo");
        std::fs::create_dir_all(&work).unwrap();
        std::fs::create_dir(&requested).unwrap();
        std::fs::write(work.join("same.txt"), "clone").unwrap();
        std::fs::write(requested.join("same.txt"), "concurrent").unwrap();

        assert!(publish_directory_fallback(&work, &requested).is_err());
        assert_eq!(
            std::fs::read_to_string(work.join("same.txt")).unwrap(),
            "clone"
        );
        assert_eq!(
            std::fs::read_to_string(requested.join("same.txt")).unwrap(),
            "concurrent"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn fallback_claim_failure_restores_empty_destination_and_preserves_clone() {
        let base = std::env::temp_dir().join(format!(
            "gitlane-clone-fallback-claim-failure-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let requested = base.join("repo");
        std::fs::create_dir(&requested).unwrap();
        let mut target = CloneTarget::prepare(&requested).unwrap();
        let work = target.work.clone();
        std::fs::write(work.join("README.md"), "done").unwrap();

        // Model publish() after it removed the user's still-empty directory
        // and no-replace rename reported Unsupported. Inject the following
        // exclusive-claim failure so the recovery branch is deterministic.
        std::fs::remove_dir(&requested).unwrap();
        let error = target
            .claim_fallback_destination(true, |_| Err(std::io::Error::other("claim failed")))
            .unwrap_err();

        assert!(error.contains("private clone staging was preserved"));
        assert!(error.contains("empty destination was restored"));
        assert!(!target.owns_work);
        assert!(requested.is_dir());
        drop(target);
        assert_eq!(
            std::fs::read_to_string(work.join("README.md")).unwrap(),
            "done"
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn cancelled_clone_into_existing_empty_directory_cleans_only_staging() {
        let base =
            std::env::temp_dir().join(format!("gitlane-clone-existing-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let requested = base.join("repo");
        std::fs::create_dir(&requested).unwrap();
        let target = CloneTarget::prepare(&requested).unwrap();
        let work = target.work.clone();
        assert_ne!(work, requested);
        assert!(target.owns_work);
        assert!(target.publish_into_existing);
        std::fs::write(work.join("partial.pack"), "partial").unwrap();

        drop(target);

        assert!(!work.exists());
        assert!(requested.is_dir());
        assert!(std::fs::read_dir(&requested).unwrap().next().is_none());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn completed_clone_publishes_into_existing_empty_directory() {
        let base = std::env::temp_dir().join(format!(
            "gitlane-clone-existing-publish-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let requested = base.join("repo");
        std::fs::create_dir(&requested).unwrap();
        let mut target = CloneTarget::prepare(&requested).unwrap();
        let work = target.work.clone();
        std::fs::write(work.join("README.md"), "done").unwrap();

        target.publish().unwrap();

        assert!(!work.exists());
        assert_eq!(
            std::fs::read_to_string(requested.join("README.md")).unwrap(),
            "done"
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn existing_destination_is_preserved_when_an_entry_appears_before_publish() {
        let base = std::env::temp_dir().join(format!(
            "gitlane-clone-existing-race-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let requested = base.join("repo");
        std::fs::create_dir(&requested).unwrap();
        let mut target = CloneTarget::prepare(&requested).unwrap();
        let work = target.work.clone();
        std::fs::write(work.join("README.md"), "clone").unwrap();
        std::fs::write(requested.join("concurrent.txt"), "keep").unwrap();

        assert!(target.publish().is_err());
        drop(target);

        assert!(!work.exists());
        assert_eq!(
            std::fs::read_to_string(requested.join("concurrent.txt")).unwrap(),
            "keep"
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn clone_target_rejects_an_existing_nonempty_directory() {
        let base = std::env::temp_dir().join(format!(
            "gitlane-clone-existing-nonempty-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&base);
        let requested = base.join("repo");
        std::fs::create_dir_all(&requested).unwrap();
        std::fs::write(requested.join("keep.txt"), "keep").unwrap();

        let err = match CloneTarget::prepare(&requested) {
            Ok(_) => panic!("non-empty destinations must be rejected"),
            Err(err) => err,
        };

        assert!(err.contains("isn't empty"));
        assert_eq!(
            std::fs::read_to_string(requested.join("keep.txt")).unwrap(),
            "keep"
        );

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
        assert!(
            super::init("relative-parent", "repo", "main", false, "None").is_err(),
            "init must not reinterpret a crafted relative destination"
        );
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
