//! Per-repo serialization of index-mutating writes, plus safe recovery for a
//! stranded `.git/index.lock` (GL-335).
//!
//! Git creates `index.lock`, writes the new index into it, then renames over
//! `index`. Concurrent writers race that lock; a crash between create and
//! rename leaves it stranded. GitLane never races itself (mutex below) and
//! never silently deletes a live lock (inspect / remove gate on mtime + openers).

use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::{Mutex, MutexGuard, OnceLock},
    time::{Duration, SystemTime},
};

use crate::git::types::IndexLockStatus;

/// How old an `index.lock` must be before recovery will consider removing it.
/// Fresh locks are almost certainly a live writer (ours or a terminal).
const STALE_AFTER: Duration = Duration::from_secs(3);

type IndexWriteMutex = &'static Mutex<()>;
static INDEX_WRITE_LOCKS: OnceLock<Mutex<HashMap<PathBuf, IndexWriteMutex>>> = OnceLock::new();

/// Serialize index-mutating writes for one repository (and its linked worktrees).
/// Linked worktrees share one lock because they share the repository's common
/// Git directory — and often contend for the same logical index operations from
/// the user's point of view (stage in A while stash runs in B still races the
/// shared object store / ref updates less often, but the per-worktree index
/// lock is still the failure mode we saw for concurrent IPC on one worktree).
/// Keyed by `commondir` so two worktrees of the same repo never take independent
/// locks while two unrelated repos stay independent.
pub(super) fn lock_index_writes(repo: &str) -> Result<MutexGuard<'static, ()>, String> {
    let repository = git2::Repository::discover(repo)
        .map_err(|error| format!("Failed to resolve the repository index lock: {error}"))?;
    let common_dir = repository
        .commondir()
        .canonicalize()
        .map_err(|error| format!("Failed to resolve the repository index lock: {error}"))?;
    let locks = INDEX_WRITE_LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let lock = {
        let mut locks = locks
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *locks
            .entry(common_dir)
            .or_insert_with(|| Box::leak(Box::new(Mutex::new(()))))
    };

    // No recoverable state behind the mutex — each caller re-opens the repo.
    // Preserve serialization after a panic instead of bricking writes for the
    // rest of the process lifetime.
    Ok(lock
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner))
}

/// True when a git failure is the stranded-/contended-`index.lock` shape —
/// the same predicate `classify` uses to give such failures `kind: indexLock`.
#[cfg(test)]
pub fn is_index_lock_error(message: &str) -> bool {
    super::classify::is_index_lock_failure(message)
}

/// Resolve the per-worktree `index.lock` path for `repo`.
fn index_lock_path(repo: &str) -> Result<PathBuf, String> {
    let repository = git2::Repository::discover(repo)
        .map_err(|error| format!("Failed to resolve the repository: {error}"))?;
    Ok(repository.path().join("index.lock"))
}

/// Whether any process currently has `path` open (live writer heuristic).
/// `lsof` is the portable-enough check on macOS; failure to run it is treated
/// as "unknown → not safe to delete" by the caller.
fn lock_file_has_openers(path: &Path) -> Result<bool, String> {
    #[cfg(test)]
    if let Some(override_fn) = test_openers_override() {
        return override_fn(path);
    }

    let output = Command::new("lsof")
        .arg("--")
        .arg(path)
        .output()
        .map_err(|error| format!("Failed to check whether the index lock is in use: {error}"))?;
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
        Ok(false) => Ok(IndexLockStatus {
            present: true,
            stale: true,
            detail: "The index lock looks stranded (old, and no process has it open).".into(),
        }),
        Err(error) => Ok(IndexLockStatus {
            present: true,
            stale: false,
            detail: error,
        }),
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
    fs::remove_file(&path).map_err(|error| format!("Failed to remove the index lock: {error}"))
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
static TEST_OPENERS_OVERRIDE: Mutex<Option<OpenersProbe>> = Mutex::new(None);

/// Serializes opener-override tests — they share process-wide hook state.
#[cfg(test)]
static OPENERS_TEST_MUTEX: Mutex<()> = Mutex::new(());

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
        // Stamp an old mtime without pulling in `filetime` / `libc`.
        let status = Command::new("touch")
            .args(["-t", "202001010000", "--"])
            .arg(path)
            .status()
            .expect("touch should spawn");
        assert!(status.success(), "touch should set mtime");
    }

    #[test]
    fn detects_index_lock_error_shapes() {
        assert!(is_index_lock_error(
            "fatal: Unable to create '/repo/.git/index.lock': File exists.\n\nAnother git process seems to be running in this repository, or the lock file may be stale."
        ));
        assert!(is_index_lock_error("could not write index\nindex.lock"));
        assert!(!is_index_lock_error("fatal: not a git repository"));
        assert!(!is_index_lock_error(
            "fatal: Unable to create '/repo/.git/index.lock': Permission denied"
        ));
        assert!(!is_index_lock_error(
            "error: cannot lock ref 'refs/remotes/origin/x': Unable to create '/repo/.git/refs/remotes/origin/x.lock': File exists."
        ));
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
}
