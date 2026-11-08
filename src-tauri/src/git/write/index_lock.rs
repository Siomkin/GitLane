//! Per-repo serialization of index-mutating writes, plus safe recovery for a
//! stranded `.git/index.lock` (GL-335).
//!
//! Git creates `index.lock`, writes the new index into it, then renames over
//! `index`. Concurrent writers race that lock; a crash between create and
//! rename leaves it stranded. GitLane never races itself (mutex below) and
//! never silently deletes a live lock (inspect / remove gate on mtime, openers,
//! and running git processes).

use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::{MutexGuard, OnceLock},
    time::{Duration, SystemTime},
};

use crate::git::types::IndexLockStatus;

use super::commondir_lock::{commondir_lock, CommondirLocks};

/// How old an `index.lock` must be before recovery will consider removing it.
/// Fresh locks are almost certainly a live writer (ours or a terminal).
const STALE_AFTER: Duration = Duration::from_secs(3);

const GIT_PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const GIT_PROBE_MAX_OUTPUT: usize = 4 * 1024 * 1024;

static INDEX_WRITE_LOCKS: CommondirLocks = OnceLock::new();

/// Serialize index-mutating writes for one repository (and its linked worktrees).
/// Linked worktrees share one lock because they share the repository's common
/// Git directory — and often contend for the same logical index operations from
/// the user's point of view (stage in A while stash runs in B still races the
/// shared object store / ref updates less often, but the per-worktree index
/// lock is still the failure mode we saw for concurrent IPC on one worktree).
/// Keyed by `commondir` so two worktrees of the same repo never take independent
/// locks while two unrelated repos stay independent.
pub(super) fn lock_index_writes(repo: &str) -> Result<MutexGuard<'static, ()>, String> {
    commondir_lock(&INDEX_WRITE_LOCKS, repo, "index")
}

/// Resolve the per-worktree `index.lock` path for `repo`.
fn index_lock_path(repo: &str) -> Result<PathBuf, String> {
    let repository = git2::Repository::discover(repo)
        .map_err(|error| format!("Failed to resolve the repository: {error}"))?;
    Ok(repository.path().join("index.lock"))
}

/// Whether any process currently has `path` open (live writer heuristic).
/// Failure to probe is treated as "unknown → not safe to delete" by the
/// caller, so the lock is never reported stale without a probe.
fn lock_file_has_openers(path: &Path) -> Result<bool, String> {
    #[cfg(test)]
    if let Some(override_fn) = test_openers_override() {
        return override_fn(path);
    }
    openers_probe(path)
}

/// Windows refuses to delete a file another process holds open, which is the
/// same "has openers" signal `lsof` gives — so the unlink in
/// [`remove_index_lock`] is the probe, and an old lock classifies as stale.
#[cfg(windows)]
fn openers_probe(_path: &Path) -> Result<bool, String> {
    Ok(false)
}

/// `lsof` on macOS and Linux. Without it (minimal Linux) there is no probe, so
/// the lock is never offered as stale.
#[cfg(not(windows))]
fn openers_probe(path: &Path) -> Result<bool, String> {
    let output = std::process::Command::new("lsof")
        .arg("--")
        .arg(path)
        .output()
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                "Can't tell whether a process still has the index lock open (`lsof` is not \
                 installed). Make sure no git process is running, then delete .git/index.lock."
                    .to_string()
            } else {
                format!("Failed to check whether the index lock is in use: {error}")
            }
        })?;
    // lsof exits 0 when at least one process has the file open, 1 when none.
    match output.status.code() {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        _ => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(format!(
                "Failed to check whether the index lock is in use: {}",
                stderr.trim()
            ))
        }
    }
}

/// Whether a git process is running anywhere on this machine. No opener does
/// not mean no writer: `git commit -a` closes `index.lock` and keeps it as its
/// index for the whole pre-commit hook, while the parent `git` stays alive.
fn git_is_running() -> Result<bool, String> {
    #[cfg(test)]
    let probe = TEST_GIT_PROBE.with(std::cell::Cell::get);
    #[cfg(not(test))]
    let probe = git_process_probe;
    probe()
}

fn git_probe_failed() -> String {
    "Can't tell whether a git process is still running. Make sure none is, then delete \
     .git/index.lock."
        .to_string()
}

fn process_listing(mut cmd: Command) -> Option<String> {
    crate::shell::hide_console(&mut cmd);
    let bytes = crate::shell::output_within(cmd, GIT_PROBE_TIMEOUT, GIT_PROBE_MAX_OUTPUT)?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

#[cfg(windows)]
fn git_process_probe() -> Result<bool, String> {
    let mut cmd = Command::new("tasklist");
    cmd.args(["/FI", "IMAGENAME eq git.exe", "/FO", "CSV", "/NH"]);
    let listing = process_listing(cmd).ok_or_else(git_probe_failed)?;
    Ok(tasklist_lists_git(&listing))
}

#[cfg(not(windows))]
fn ps_listing() -> Result<String, String> {
    let mut cmd = Command::new("ps");
    // `-ww`: a long path to a bundled git must not be cut off.
    cmd.args(["-ww", "-eo", "args="]);
    // `ps` always lists itself, so empty output means an unusable `ps`.
    process_listing(cmd)
        .filter(|listing| !listing.trim().is_empty())
        .ok_or_else(git_probe_failed)
}

#[cfg(not(windows))]
fn git_process_probe() -> Result<bool, String> {
    Ok(ps_listing()?.lines().any(ps_line_is_git))
}

/// Matches a `git.exe` row, never the no-match text, which is localized.
#[cfg(any(windows, test))]
fn tasklist_lists_git(listing: &str) -> bool {
    listing.lines().any(|row| {
        row.split(',')
            .next()
            .is_some_and(|image| image.trim().eq_ignore_ascii_case("\"git.exe\""))
    })
}

#[cfg(any(not(windows), test))]
fn is_git_executable(token: &str) -> bool {
    let name = token.rsplit('/').next().unwrap_or(token);
    name == "git" || name.starts_with("git-")
}

/// Whether one `ps` command line is a git process that could hold the lock.
/// Long-lived daemons (fsmonitor, credential-cache) are skipped. Errs towards
/// "live", which only withholds the one-click removal.
#[cfg(any(not(windows), test))]
fn ps_line_is_git(line: &str) -> bool {
    let mut tokens = line.split_whitespace();
    let Some(mut executable) = tokens.next() else {
        return false;
    };
    if !is_git_executable(executable) {
        // `ps` doesn't quote, so a git under a path with spaces arrives split:
        // a later piece contains `/` but, unlike a path argument, doesn't start
        // with one.
        if !executable.contains('/') {
            return false;
        }
        let Some(found) = tokens.by_ref().find(|token| {
            token.contains('/') && !token.starts_with('/') && is_git_executable(token)
        }) else {
            return false;
        };
        executable = found;
    }
    let name = executable.rsplit('/').next().unwrap_or(executable);
    let command = match name.strip_prefix("git-") {
        Some(command) => Some(command),
        None => tokens.next(),
    };
    !command.is_some_and(is_daemon_command)
}

/// Exact names only: a repository path in the first argument can contain
/// "daemon" too.
#[cfg(any(not(windows), test))]
fn is_daemon_command(command: &str) -> bool {
    command == "daemon" || (command.ends_with("--daemon") && !command.starts_with('-'))
}

fn lock_mtime_age(path: &Path) -> Result<Duration, String> {
    let meta =
        fs::metadata(path).map_err(|error| format!("Failed to read the index lock: {error}"))?;
    let modified = meta
        .modified()
        .map_err(|error| format!("Failed to read the index lock timestamp: {error}"))?;
    // A future mtime (clock skew, or a writer that just touched it) reads as
    // age zero — i.e. fresh, never stale.
    Ok(SystemTime::now()
        .duration_since(modified)
        .unwrap_or(Duration::ZERO))
}

fn classify_lock(path: &Path) -> Result<IndexLockStatus, String> {
    if !path.exists() {
        return Ok(IndexLockStatus {
            present: false,
            stale: false,
            detail: "No index lock file is present.".into(),
        });
    }

    let age = lock_mtime_age(path)?;
    if age < STALE_AFTER {
        return Ok(IndexLockStatus {
            present: true,
            stale: false,
            detail: format!(
                "The index lock is only {}s old — a git process may still be writing.",
                age.as_secs()
            ),
        });
    }

    match lock_file_has_openers(path) {
        Ok(true) => Ok(IndexLockStatus {
            present: true,
            stale: false,
            detail: "A process still has the index lock open.".into(),
        }),
        Ok(false) => Ok(classify_unopened_lock()),
        Err(error) => Ok(IndexLockStatus {
            present: true,
            stale: false,
            detail: error,
        }),
    }
}

fn classify_unopened_lock() -> IndexLockStatus {
    let (stale, detail) = match git_is_running() {
        Ok(false) => (
            true,
            "The index lock looks stranded (old, no process has it open, and no git is running)."
                .to_string(),
        ),
        Ok(true) => (
            false,
            "A git process is still running. Finish other git commands, then retry.".to_string(),
        ),
        Err(error) => (false, error),
    };
    IndexLockStatus {
        present: true,
        stale,
        detail,
    }
}

/// Inspect `.git/index.lock` for recovery UI. Never removes anything.
pub fn inspect_index_lock(repo: &str) -> Result<IndexLockStatus, String> {
    classify_lock(&index_lock_path(repo)?)
}

/// Remove a stranded `index.lock` only when the staleness gate passes.
/// Holds the per-repo index write mutex so a concurrent GitLane writer cannot
/// create a live lock between classify and unlink (GL-335 review).
pub fn remove_index_lock(repo: &str) -> Result<(), String> {
    let _index_guard = lock_index_writes(repo)?;
    let path = index_lock_path(repo)?;
    let status = classify_lock(&path)?;
    if !status.present {
        return Ok(());
    }
    if !status.stale {
        return Err(status.detail);
    }
    // Re-classify immediately before unlink — an external git could still race us.
    let again = classify_lock(&path)?;
    if !again.present {
        return Ok(());
    }
    if !again.stale {
        return Err(again.detail);
    }
    fs::remove_file(&path).map_err(|error| {
        // ERROR_SHARING_VIOLATION (32) is what an open handle without
        // FILE_SHARE_DELETE (git's) returns; std may not classify it.
        if cfg!(windows)
            && (error.raw_os_error() == Some(32)
                || error.kind() == std::io::ErrorKind::PermissionDenied)
        {
            // Windows' "has openers" answer (see `openers_probe`).
            "A process still has the index lock open.".to_string()
        } else {
            format!("Failed to remove the index lock: {error}")
        }
    })
}

/// Stand-in for [`lock_file_has_openers`] so tests can force either answer
/// without a real `lsof` or a real second process holding the lock.
#[cfg(test)]
type OpenersProbe = fn(&Path) -> Result<bool, String>;

#[cfg(test)]
fn test_openers_override() -> Option<OpenersProbe> {
    TEST_OPENERS_OVERRIDE.lock().ok().and_then(|g| *g)
}

#[cfg(test)]
static TEST_OPENERS_OVERRIDE: std::sync::Mutex<Option<OpenersProbe>> = std::sync::Mutex::new(None);

// Per thread, and "no git" by default: other tests really do run git.
#[cfg(test)]
thread_local! {
    static TEST_GIT_PROBE: std::cell::Cell<fn() -> Result<bool, String>> =
        const { std::cell::Cell::new(|| Ok(false)) };
}

/// Serializes opener-override tests — they share process-wide hook state.
#[cfg(test)]
static OPENERS_TEST_MUTEX: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
fn with_openers_override<R>(override_fn: OpenersProbe, body: impl FnOnce() -> R) -> R {
    let _serial = OPENERS_TEST_MUTEX
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let previous = {
        let mut slot = TEST_OPENERS_OVERRIDE
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        slot.replace(override_fn)
    };
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(body));
    let mut slot = TEST_OPENERS_OVERRIDE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    *slot = previous;
    match result {
        Ok(value) => value,
        Err(panic) => std::panic::resume_unwind(panic),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        sync::atomic::{AtomicU64, Ordering},
        thread,
        time::Duration,
    };

    static NEXT_REPO_ID: AtomicU64 = AtomicU64::new(0);

    struct TestRepo(PathBuf);

    impl TestRepo {
        fn new(tag: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "gitlane-index-lock-{tag}-{}-{}",
                std::process::id(),
                NEXT_REPO_ID.fetch_add(1, Ordering::Relaxed)
            ));
            git2::Repository::init(&path).expect("test repository should initialize");
            Self(path)
        }

        fn path_str(&self) -> String {
            self.0.to_string_lossy().into_owned()
        }

        fn lock_path(&self) -> PathBuf {
            self.0.join(".git").join("index.lock")
        }
    }

    impl Drop for TestRepo {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn openers_none(_path: &Path) -> Result<bool, String> {
        Ok(false)
    }

    fn openers_yes(_path: &Path) -> Result<bool, String> {
        Ok(true)
    }

    /// Plant a lock file and backdate its mtime well past `STALE_AFTER`.
    fn plant_stale_lock(path: &Path) {
        fs::write(path, b"stranded\n").expect("plant lock");
        fs::File::options()
            .write(true)
            .open(path)
            .and_then(|file| {
                file.set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(1 << 30))
            })
            .expect("backdate lock mtime");
    }

    #[test]
    fn index_lock_recovers_after_poisoning() {
        let repo = TestRepo::new("poison");
        let repo_path = repo.path_str();
        let panic = thread::spawn(move || {
            let _guard = lock_index_writes(&repo_path).expect("index lock should be available");
            panic!("poison the index lock");
        })
        .join();

        assert!(panic.is_err());
        assert!(lock_index_writes(&repo.path_str()).is_ok());
    }

    #[test]
    fn different_repositories_have_independent_index_locks() {
        let first = TestRepo::new("first");
        let second = TestRepo::new("second");
        let first_guard = lock_index_writes(&first.path_str()).expect("first lock");
        let second_path = second.path_str();
        let (acquired_tx, acquired_rx) = std::sync::mpsc::channel();

        let second_thread = thread::spawn(move || {
            let _guard = lock_index_writes(&second_path).expect("second lock");
            acquired_tx.send(()).expect("report acquisition");
        });

        assert!(acquired_rx.recv_timeout(Duration::from_secs(1)).is_ok());
        drop(first_guard);
        second_thread
            .join()
            .expect("second lock thread should finish");
    }

    #[test]
    fn same_repository_serializes_index_writes() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;

        let repo = TestRepo::new("serialize");
        let held = lock_index_writes(&repo.path_str()).expect("hold lock");
        let repo_path = repo.path_str();
        let acquired = Arc::new(AtomicBool::new(false));
        let acquired_flag = Arc::clone(&acquired);

        let waiter = thread::spawn(move || {
            let _guard = lock_index_writes(&repo_path).expect("waiter lock");
            acquired_flag.store(true, Ordering::SeqCst);
        });

        thread::sleep(Duration::from_millis(80));
        assert!(
            !acquired.load(Ordering::SeqCst),
            "second acquire must block while the first guard is held"
        );
        drop(held);
        waiter.join().expect("waiter should finish");
        assert!(acquired.load(Ordering::SeqCst));
    }

    #[test]
    fn inspect_reports_absent_lock() {
        let repo = TestRepo::new("absent");
        let status = inspect_index_lock(&repo.path_str()).expect("inspect");
        assert!(!status.present);
        assert!(!status.stale);
    }

    #[test]
    fn inspect_fresh_lock_is_not_stale() {
        let repo = TestRepo::new("fresh");
        fs::write(repo.lock_path(), b"live\n").expect("plant lock");
        let status = with_openers_override(openers_none, || {
            inspect_index_lock(&repo.path_str()).expect("inspect")
        });
        assert!(status.present);
        assert!(!status.stale);
    }

    #[test]
    fn inspect_old_lock_without_openers_is_stale() {
        let repo = TestRepo::new("old");
        plant_stale_lock(&repo.lock_path());
        let status = with_openers_override(openers_none, || {
            inspect_index_lock(&repo.path_str()).expect("inspect")
        });
        assert!(status.present);
        assert!(status.stale);
    }

    #[test]
    fn inspect_old_lock_with_openers_is_not_stale() {
        let repo = TestRepo::new("held");
        plant_stale_lock(&repo.lock_path());
        let status = with_openers_override(openers_yes, || {
            inspect_index_lock(&repo.path_str()).expect("inspect")
        });
        assert!(status.present);
        assert!(!status.stale);
    }

    /// No probe (minimal Linux without `lsof`): the lock is never offered as
    /// stale, so the UI does not promise a removal that cannot happen.
    #[test]
    fn inspect_old_lock_without_a_probe_is_not_stale() {
        fn no_probe(_path: &Path) -> Result<bool, String> {
            Err("`lsof` is not installed".into())
        }
        let repo = TestRepo::new("no-probe");
        plant_stale_lock(&repo.lock_path());
        let status = with_openers_override(no_probe, || {
            inspect_index_lock(&repo.path_str()).expect("inspect")
        });
        assert!(status.present);
        assert!(!status.stale);
        assert!(status.detail.contains("lsof"));
    }

    /// Windows: the unlink itself is the openers probe — an open handle makes
    /// removal fail, and closing it lets the same call succeed.
    #[cfg(windows)]
    #[test]
    fn windows_removal_refuses_a_lock_that_is_still_open() {
        let repo = TestRepo::new("windows-open");
        plant_stale_lock(&repo.lock_path());
        // Hold it the way git does — without FILE_SHARE_DELETE. (std's default
        // share mode includes it, which would let the delete through.)
        let handle = {
            use std::os::windows::fs::OpenOptionsExt;
            fs::OpenOptions::new()
                .read(true)
                .share_mode(1) // FILE_SHARE_READ only
                .open(repo.lock_path())
                .expect("hold lock open")
        };
        assert!(inspect_index_lock(&repo.path_str()).expect("inspect").stale);
        let err = remove_index_lock(&repo.path_str()).expect_err("open lock must survive");
        assert!(err.contains("still has the index lock open"));
        assert!(repo.lock_path().exists());
        drop(handle);
        remove_index_lock(&repo.path_str()).expect("closed lock is removable");
        assert!(!repo.lock_path().exists());
    }

    #[test]
    fn remove_only_when_stale() {
        let repo = TestRepo::new("remove");
        plant_stale_lock(&repo.lock_path());
        with_openers_override(openers_none, || {
            remove_index_lock(&repo.path_str()).expect("remove stale");
        });
        assert!(!repo.lock_path().exists());

        plant_stale_lock(&repo.lock_path());
        let err = with_openers_override(openers_yes, || {
            remove_index_lock(&repo.path_str()).expect_err("must refuse live lock")
        });
        assert!(repo.lock_path().exists());
        assert!(err.contains("open") || err.contains("still"));
    }

    /// Restores the previous probe: `--test-threads=1` reuses one thread.
    fn with_git_probe<R>(probe: fn() -> Result<bool, String>, body: impl FnOnce() -> R) -> R {
        struct Restore(fn() -> Result<bool, String>);
        impl Drop for Restore {
            fn drop(&mut self) {
                TEST_GIT_PROBE.with(|slot| slot.set(self.0));
            }
        }
        let _restore = Restore(TEST_GIT_PROBE.with(|slot| slot.replace(probe)));
        body()
    }

    /// A `git commit -a` in its pre-commit hook: old lock, no opener, live git.
    #[test]
    fn a_running_git_keeps_an_unopened_lock() {
        let repo = TestRepo::new("live-git");
        plant_stale_lock(&repo.lock_path());
        with_git_probe(
            || Ok(true),
            || {
                with_openers_override(openers_none, || {
                    let status = inspect_index_lock(&repo.path_str()).expect("inspect");
                    assert!(status.present);
                    assert!(!status.stale);
                    assert!(status.detail.contains("git process"));
                    let err = remove_index_lock(&repo.path_str()).expect_err("must refuse");
                    assert!(err.contains("git process"));
                });
            },
        );
        assert!(repo.lock_path().exists());
    }

    #[test]
    fn a_failed_git_probe_keeps_the_lock() {
        let repo = TestRepo::new("probe-failed");
        plant_stale_lock(&repo.lock_path());
        with_git_probe(
            || Err(git_probe_failed()),
            || {
                with_openers_override(openers_none, || {
                    let status = inspect_index_lock(&repo.path_str()).expect("inspect");
                    assert!(!status.stale);
                    remove_index_lock(&repo.path_str()).expect_err("must refuse");
                });
            },
        );
        assert!(repo.lock_path().exists());
    }

    #[test]
    fn the_real_probe_sees_a_running_git() {
        // The marker singles out this git: parallel tests run git too.
        let marker = format!("--path=gitlane-probe-{}", std::process::id());
        let mut git = Command::new("git")
            .args(["hash-object", "--stdin", &marker])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .spawn()
            .expect("spawn git");
        let seen = git_process_probe();
        #[cfg(not(windows))]
        let line_matched = ps_listing().map(|listing| {
            listing
                .lines()
                .any(|l| l.contains(&marker) && ps_line_is_git(l))
        });
        let _ = git.kill();
        let _ = git.wait();
        assert_eq!(seen, Ok(true));
        #[cfg(not(windows))]
        assert_eq!(line_matched, Ok(true));
    }

    #[test]
    fn ps_lines_count_real_git_processes_only() {
        for live in [
            "git commit -am two",
            "/usr/bin/git status",
            "/opt/git-core/git-remote-https origin https://example.com/r.git",
            "git -c core.editor=true rebase --continue",
            "git commit -m daemon-fix",
            "/Applications/GitHub Desktop.app/Contents/Resources/git/bin/git commit -a",
            "/Applications/Dev - Tools/git/bin/git commit -a",
            "./My Tools/git commit -a",
            "git --git-dir=/work/daemon-svc/.git commit -a",
            "git --git-dir=/work/svc--daemon commit -a",
            "/usr/lib/git-core/git-receive-pack /srv/daemon/repo.git",
        ] {
            assert!(ps_line_is_git(live), "{live}");
        }
        for idle in [
            "git fsmonitor--daemon run --detach",
            "/usr/lib/git-core/git-credential-cache--daemon /tmp/socket",
            "git daemon --reuseaddr",
            "/usr/lib/git-core/git-daemon --reuseaddr",
            "/Applications/GitHub Desktop.app/Contents/Resources/git/bin/git fsmonitor--daemon run",
            "gitlane --flag",
            "github-desktop",
            "/usr/bin/vim /repo/git-notes.txt",
            "/usr/bin/python3 git-watch.py",
            "/usr/bin/tail git-debug.log",
            "bash -c git status",
            "",
        ] {
            assert!(!ps_line_is_git(idle), "{idle}");
        }
    }

    #[test]
    fn tasklist_rows_are_matched_by_image_name() {
        assert!(tasklist_lists_git(
            "\"git.exe\",\"1234\",\"Console\",\"1\",\"12,000 K\"\r\n"
        ));
        assert!(tasklist_lists_git(
            "\"GIT.EXE\",\"1\",\"Console\",\"1\",\"1 K\""
        ));
        assert!(!tasklist_lists_git(
            "\"git-lfs.exe\",\"1\",\"Console\",\"1\",\"1 K\""
        ));
        assert!(!tasklist_lists_git(
            "INFO: No tasks are running which match the specified criteria.\r\n"
        ));
        assert!(!tasklist_lists_git(""));
    }
}
