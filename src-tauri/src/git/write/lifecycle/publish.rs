//! The staging directory a clone lands in, and the no-replace publish that
//! moves it to its final home. Named `publish` rather than `staging` because
//! `write/staging.rs` already means index staging (`git add`) — a different
//! thing entirely.
//!
//! Nothing is written directly to the destination: a clone fills a sibling
//! staging directory and is published only once it has succeeded, so a failed
//! or cancelled clone can never leave a half-written repository behind, and can
//! never overwrite something that appeared at the destination meanwhile — every
//! move refuses to replace an existing entry. `Drop` cleans up whatever was not
//! published.

use std::path::{Path, PathBuf};

/// Owns the filesystem target for one clone. All requested paths use a private
/// sibling so rollback never races with files created at the public path.
pub(super) struct CloneTarget {
    requested: PathBuf,
    work: PathBuf,
    owns_work: bool,
    publish_into_existing: bool,
}

impl CloneTarget {
    pub(super) fn prepare(requested: &Path) -> Result<Self, String> {
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

    pub(super) fn work_arg(&self) -> Result<&str, String> {
        self.work
            .to_str()
            .ok_or_else(|| "The clone destination is not valid UTF-8.".to_string())
    }

    pub(super) fn publish(&mut self) -> Result<(), String> {
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
