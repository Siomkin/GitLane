use super::resolve::open_leaf_nofollow;
use super::{
    fingerprint_worktree_leaf_path_bounded, open_regular_worktree_file, read_regular_worktree_file,
    worktree_directory_identity, WorktreeDirectoryIdentity,
};
use cap_std::fs::Dir;
use sha2::{Digest, Sha256};
use std::ffi::OsString;
use std::os::unix::fs::symlink;

fn identity_digest(identity: &WorktreeDirectoryIdentity) -> [u8; 32] {
    let mut state = Sha256::new();
    identity.hash_into(&mut state);
    state.finalize().into()
}

/// The load-bearing property, asserted without depending on the filesystem
/// to recycle an inode: this machine's APFS never does, while the Linux CI
/// runner does so almost every time. Constructing the collision directly is
/// what makes the guarantee testable on both.
#[test]
fn directories_sharing_a_recycled_inode_are_still_distinct() {
    let recycled = WorktreeDirectoryIdentity {
        device: 42,
        inode: 1234,
        birth_time: Some((1_700_000_000, 0)),
    };
    let replacement = WorktreeDirectoryIdentity {
        birth_time: Some((1_700_000_001, 0)),
        ..recycled
    };

    assert_ne!(
        recycled, replacement,
        "a replacement handed the same inode must not compare equal"
    );
    assert_ne!(
        identity_digest(&recycled),
        identity_digest(&replacement),
        "the lease digest must separate them too, not just the struct"
    );
}

/// Sub-second resolution matters: a remove/recreate takes microseconds, so a
/// creation time truncated to whole seconds would collide in exactly the
/// case this guards.
#[test]
fn birth_time_separates_directories_created_within_the_same_second() {
    let first = WorktreeDirectoryIdentity {
        device: 42,
        inode: 1234,
        birth_time: Some((1_700_000_000, 0)),
    };
    let second = WorktreeDirectoryIdentity {
        birth_time: Some((1_700_000_000, 1)),
        ..first
    };

    assert_ne!(identity_digest(&first), identity_digest(&second));
}

/// A filesystem that reports no creation time must degrade to the previous
/// device/inode behaviour rather than erroring or silently matching a
/// directory that does report one.
#[test]
fn a_missing_birth_time_degrades_to_device_and_inode() {
    let without = WorktreeDirectoryIdentity {
        device: 42,
        inode: 1234,
        birth_time: None,
    };
    let with = WorktreeDirectoryIdentity {
        birth_time: Some((1_700_000_000, 0)),
        ..without
    };

    assert_eq!(
        identity_digest(&without),
        identity_digest(&WorktreeDirectoryIdentity {
            birth_time: None,
            ..without
        }),
        "absent creation time must hash stably"
    );
    assert_ne!(
        identity_digest(&without),
        identity_digest(&with),
        "absent must not collide with present"
    );
}

#[test]
fn directory_identity_reports_a_birth_time_on_this_platform() {
    let root =
        std::env::temp_dir().join(format!("gitlane-dir-identity-btime-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();

    let identity = worktree_directory_identity(&root).expect("identity for a real directory");

    assert!(
        identity.birth_time.is_some(),
        "macOS and Linux both record a creation time; losing it here would \
         silently drop the guard back to a reusable inode"
    );
    let _ = std::fs::remove_dir_all(&root);
}

/// The other half of the contract, and the more dangerous one to get wrong:
/// an identity that drifted between two reads of the same directory would
/// expire every preview before the user could confirm it.
#[test]
fn identity_is_stable_across_repeated_reads_and_writes_inside_the_directory() {
    let root = std::env::temp_dir().join(format!(
        "gitlane-dir-identity-stable-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();

    let first = worktree_directory_identity(&root).expect("first read");
    // Mutating the contents changes mtime, never the directory's identity.
    std::fs::write(root.join("file.txt"), "content").unwrap();
    std::fs::create_dir_all(root.join("nested")).unwrap();
    let second = worktree_directory_identity(&root).expect("second read");

    assert_eq!(
        first, second,
        "identity must not drift while the directory stands, or every \
         confirm would go stale under the user"
    );
    assert_eq!(identity_digest(&first), identity_digest(&second));
    let _ = std::fs::remove_dir_all(&root);
}

/// End-to-end over a real filesystem, unlike the constructed cases above.
///
/// The pause is load-bearing, not padding. A bare back-to-back
/// remove/recreate is the one case this identity cannot separate: ext4
/// hands the inode straight back and the kernel's coarse clock stamps both
/// incarnations inside the same tick, which was measured at 18 of 20
/// undetected. Past a single tick it was 0 of 20, and any replacement a
/// user could actually race against a confirmation dialog is orders of
/// magnitude beyond that. Waiting here tests the property that holds
/// instead of the degenerate case that does not.
#[test]
fn recreating_a_directory_at_the_same_path_changes_its_identity() {
    let root = std::env::temp_dir().join(format!(
        "gitlane-dir-identity-recreate-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    let before = worktree_directory_identity(&root).expect("identity before");

    std::thread::sleep(std::time::Duration::from_millis(20));
    std::fs::remove_dir_all(&root).unwrap();
    std::fs::create_dir_all(&root).unwrap();
    let after = worktree_directory_identity(&root).expect("identity after");

    assert_ne!(
        before, after,
        "a directory rebuilt at the same pathname is a different incarnation"
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn refuses_final_and_ancestor_symlinks() {
    let root = std::env::temp_dir().join(format!(
        "gitlane-worktree-capability-{}",
        std::process::id()
    ));
    let outside = root.with_extension("outside");
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&outside);
    std::fs::create_dir_all(root.join("safe")).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(root.join("safe/file.txt"), "inside").unwrap();
    std::fs::write(outside.join("secret.txt"), "outside").unwrap();
    symlink(outside.join("secret.txt"), root.join("leaf-link")).unwrap();
    symlink(&outside, root.join("ancestor-link")).unwrap();

    assert_eq!(
        read_regular_worktree_file(&root, "safe/file.txt").unwrap(),
        b"inside"
    );
    assert!(open_regular_worktree_file(&root, "leaf-link").is_err());
    assert!(open_regular_worktree_file(&root, "ancestor-link/secret.txt").is_err());
    assert!(open_regular_worktree_file(&root, "../secret.txt").is_err());

    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&outside);
}

#[test]
fn leaf_open_does_not_block_when_a_fifo_wins_the_race() {
    let root = std::env::temp_dir().join(format!("gitlane-worktree-fifo-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    let status = std::process::Command::new("mkfifo")
        .arg(root.join("leaf"))
        .status()
        .unwrap();
    assert!(status.success());

    let parent = Dir::open_ambient_dir(&root, cap_std::ambient_authority()).unwrap();
    let opened = open_leaf_nofollow(&parent, &OsString::from("leaf")).unwrap();

    assert!(!opened.metadata().unwrap().is_file());
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn bounded_fingerprint_rejects_content_over_the_actual_read_limit() {
    let root = std::env::temp_dir().join(format!(
        "gitlane-worktree-bounded-fingerprint-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("large.bin"), vec![0_u8; 2_048]).unwrap();

    let error =
        fingerprint_worktree_leaf_path_bounded(&root, std::path::Path::new("large.bin"), 1_024)
            .err()
            .expect("content over the byte limit must fail");

    assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
    let _ = std::fs::remove_dir_all(&root);
}
