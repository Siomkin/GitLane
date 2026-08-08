//! Capturing a directory's filesystem incarnation for scope-guarding leases.

use std::io;
use std::path::Path;

use cap_fs_ext::MetadataExt as CapMetadataExt;
use cap_std::fs::{Dir, Metadata};

use super::WorktreeDirectoryIdentity;

/// Creation time of `metadata`, or `None` when the platform or filesystem does
/// not record one (cap-std reports that as an error rather than a value).
fn directory_birth_time(metadata: &Metadata) -> Option<(i64, u32)> {
    let created = metadata.created().ok()?.into_std();
    match created.duration_since(std::time::UNIX_EPOCH) {
        Ok(since) => Some((i64::try_from(since.as_secs()).ok()?, since.subsec_nanos())),
        // Created before the epoch: carry the negative offset rather than
        // dropping the field, so two pre-epoch directories stay distinct.
        Err(before) => {
            let ago = before.duration();
            Some((
                i64::try_from(ago.as_secs()).ok()?.checked_neg()?,
                ago.subsec_nanos(),
            ))
        }
    }
}

pub(crate) fn worktree_directory_identity(path: &Path) -> io::Result<WorktreeDirectoryIdentity> {
    let dir = Dir::open_ambient_dir(path, cap_std::ambient_authority())?;
    let metadata = dir.dir_metadata()?;
    if !metadata.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("refusing non-directory repository scope: {path:?}"),
        ));
    }
    Ok(WorktreeDirectoryIdentity {
        device: CapMetadataExt::dev(&metadata),
        inode: CapMetadataExt::ino(&metadata),
        birth_time: directory_birth_time(&metadata),
    })
}
