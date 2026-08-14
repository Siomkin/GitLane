//! Linked worktrees and the directory states around them: a feature
//! worktree, a dirty one, a handoff mid-conflict, and the staged directory
//! replacements the path guards are tested against.

use super::*;

/// A throwaway linked-worktree directory (lives outside the repo dir, so it needs
/// its own cleanup) that removes itself on drop.
pub(in crate::git::write::tests) struct LinkedDir(pub(in crate::git::write::tests) PathBuf);

impl LinkedDir {
    pub(in crate::git::write::tests) fn new(tag: &str) -> Self {
        static SEQ: AtomicU32 = AtomicU32::new(0);
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir =
            std::env::temp_dir().join(format!("gitlane-{tag}-linked-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        LinkedDir(dir)
    }
    pub(in crate::git::write::tests) fn as_str(&self) -> &str {
        self.0.to_str().unwrap()
    }
}

impl Drop for LinkedDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A repo on `main` (file.txt = "base") with a `feature` branch checked out in a
/// fresh linked worktree — the common starting point for the handoff tests.
pub(in crate::git::write::tests) fn repo_with_feature_worktree(tag: &str) -> (TempRepo, LinkedDir) {
    let repo = TempRepo::new(tag);
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["branch", "-M", "main"]);
    std::fs::write(repo.0.join("file.txt"), "base\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "initial"]);
    repo.git_ok(&["branch", "feature"]);

    let linked = LinkedDir::new(tag);
    repo.git_ok(&["worktree", "add", "-q", linked.as_str(), "feature"]);
    (repo, linked)
}

pub(in crate::git::write::tests) fn is_detached(dir: &std::path::Path) -> bool {
    !git_at(dir, &["symbolic-ref", "--quiet", "HEAD"])
        .status
        .success()
}

// The progress step ids are the UI contract for the hand-off dialog's live
// checklist: assert the happy-path order for a dirty source, and that the
// stash/apply steps never fire when everything is clean (the dialog folds the
// skipped rows in).

/// Set up a handoff whose destination re-apply genuinely conflicts: `feature`
/// changes file.txt one way (committed), the destination has an uncommitted change
/// to the same file the other way. Returns the repo (its linked worktree is kept
/// alive by the returned guard).
pub(in crate::git::write::tests) fn handoff_into_conflict(
    tag: &str,
) -> (TempRepo, LinkedDir, String) {
    let (repo, linked) = repo_with_feature_worktree(tag);
    // Give feature a divergent commit to file.txt (done inside the linked worktree
    // so the source stays clean).
    std::fs::write(linked.0.join("file.txt"), "feature\n").unwrap();
    git_ok_at(&linked.0, &["commit", "-q", "-am", "feature change"]);
    // Destination has a conflicting uncommitted change to the same file.
    std::fs::write(repo.0.join("file.txt"), "destination wip\n").unwrap();

    let msg = move_branch_to_worktree(
        repo.path(),
        "feature",
        linked.as_str(),
        repo.path(),
        true,
        &|_| {},
    )
    .expect("handoff should land structurally even when the carry conflicts");
    (repo, linked, msg)
}

/// A repo whose linked worktree is already dirty at preview time, for the drift
/// tests that need an existing porcelain record to mutate. Returns the repo, the
/// linked directory, and the tracked file inside it.
pub(in crate::git::write::tests) fn repo_with_dirty_linked_worktree(
    tag: &str,
) -> (TempRepo, LinkedDir, PathBuf) {
    let repo = TempRepo::new(tag);
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(repo.0.join("a.txt"), "a\n").unwrap();
    repo.git_ok(&["add", "."]);
    repo.git_ok(&["commit", "-q", "-m", "init"]);

    let linked = LinkedDir::new(tag);
    repo.git_ok(&["worktree", "add", "-q", "--detach", linked.as_str()]);
    let tracked = linked.0.join("a.txt");
    std::fs::write(&tracked, "edited once\n").unwrap();
    (repo, linked, tracked)
}

// The lease deliberately fingerprints porcelain *path + status*, not file bytes:
// typing more into an already-modified file must not expire a confirm the user
// is looking at. This is the half a leaf-byte fingerprint would have broken,
// which is why the removal lease deliberately does not reuse Discard All's.

/// A staged replacement for a directory the ABA tests need to swap out, kept so
/// the leased path provably ends up with a *different* `(device, inode)`.
///
/// `remove_dir_all` followed by a fresh `create_dir_all` at the same pathname is
/// not enough: the filesystem is free to hand the just-freed inode straight back,
/// and the GitHub-hosted Linux runners do exactly that — measured at 20 out of 20
/// remove/recreate cycles with no concurrent load, where macOS and the
/// self-hosted runner happen not to. Under `cargo test`'s parallel threads a
/// neighbouring test sometimes claims the freed inode first, which is why this
/// showed up as an intermittent-looking failure rather than a constant one.
/// When the inode does come back, the fingerprint the removal lease compares is
/// unchanged, the lease correctly allows the removal, and the test fails having
/// exercised nothing.
///
/// Copying the directory aside **while the original still exists** forces the
/// allocator to pick a different inode for the copy, and `rename` carries that
/// inode onto the leased path — so the identity change is guaranteed by
/// construction rather than left to allocator luck.
pub(in crate::git::write::tests) struct StagedDirReplacement {
    target: std::path::PathBuf,
    staging: std::path::PathBuf,
    /// Identity of the directory as it stood when it was staged — the one the
    /// lease captured, and the one the replacement must not collide with.
    #[cfg(unix)]
    original: (u64, u64),
}

impl StagedDirReplacement {
    /// Copy `target` aside. Must be called while the original directory is still
    /// in place — that overlap is what guarantees the distinct inode.
    pub(in crate::git::write::tests) fn stage(target: &std::path::Path) -> std::io::Result<Self> {
        let name = target
            .file_name()
            .expect("a directory to replace has a file name");
        let mut staged_name = name.to_os_string();
        staged_name.push(".gitlane-staged-replacement");
        let staging = target.with_file_name(staged_name);
        let _ = std::fs::remove_dir_all(&staging);
        #[cfg(unix)]
        let original = dir_identity(target)?;
        copy_dir_recursive(target, &staging)?;
        Ok(Self {
            target: target.to_path_buf(),
            staging,
            #[cfg(unix)]
            original,
        })
    }

    /// Replace whatever now sits at the target path with the staged copy. The
    /// contents are identical; only the filesystem identity differs.
    ///
    /// The post-condition is asserted rather than assumed: a test that swapped
    /// in a directory the lease cannot tell apart would pass its setup and then
    /// fail on the lease assertion, which reads as a lease bug instead of a
    /// filesystem one.
    pub(in crate::git::write::tests) fn apply(self) -> std::io::Result<()> {
        std::fs::remove_dir_all(&self.target)?;
        std::fs::rename(&self.staging, &self.target)?;
        #[cfg(unix)]
        assert_ne!(
            dir_identity(&self.target)?,
            self.original,
            "the replacement at {} came back with the original directory's \
             identity, so there is no ABA for the lease to detect",
            self.target.display(),
        );
        Ok(())
    }
}

/// The `(device, inode)` pair the worktree leases fingerprint a directory by.
#[cfg(unix)]
fn dir_identity(path: &std::path::Path) -> std::io::Result<(u64, u64)> {
    use std::os::unix::fs::MetadataExt as _;
    let metadata = std::fs::metadata(path)?;
    Ok((metadata.dev(), metadata.ino()))
}

pub(in crate::git::write::tests) fn copy_dir_recursive(
    from: &std::path::Path,
    to: &std::path::Path,
) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let dest = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&entry.path(), &dest)?;
        } else {
            std::fs::copy(entry.path(), dest)?;
        }
    }
    Ok(())
}

/// Restores a directory's mode on drop so a test that makes one unwritable
/// cannot leave `TempRepo`'s recursive delete unable to clean up.
#[cfg(unix)]
pub(in crate::git::write::tests) struct RestoredMode(
    pub(in crate::git::write::tests) PathBuf,
    pub(in crate::git::write::tests) u32,
);

#[cfg(unix)]
impl RestoredMode {
    pub(in crate::git::write::tests) fn clamp(path: PathBuf, mode: u32) -> Self {
        use std::os::unix::fs::PermissionsExt;
        let original = std::fs::metadata(&path).unwrap().permissions().mode();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode)).unwrap();
        Self(path, original)
    }
}

#[cfg(unix)]
impl Drop for RestoredMode {
    fn drop(&mut self) {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&self.0, std::fs::Permissions::from_mode(self.1));
    }
}
