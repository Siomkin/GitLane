//! One level of folders on this machine, for the remote open dialog's folder
//! browser (remote-ssh-repos). Names and flags only: no file contents are read.

use std::path::Path;

use super::types::DirectoryEntry;

/// Most sub-folders one listing returns; a home directory with more is not one
/// anyone browses by eye.
const MAX_ENTRIES: usize = 2000;

/// The visible sub-folders of `path`, sorted by name. A folder that can't be
/// read is listed with `readable: false` rather than failing the listing.
pub fn list_directory(path: &str) -> Result<Vec<DirectoryEntry>, String> {
    let dir = Path::new(path);
    if !dir.is_absolute() {
        return Err(format!("{path} is not an absolute path."));
    }
    let read = std::fs::read_dir(dir).map_err(|e| format!("Couldn't read {path}: {e}"))?;
    let mut entries: Vec<DirectoryEntry> = read
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            let full = entry.path();
            // `is_dir` follows symlinks, so a linked project folder is listed.
            if name.starts_with('.') || !full.is_dir() {
                return None;
            }
            Some(DirectoryEntry {
                is_repo: full.join(".git").exists(),
                readable: std::fs::read_dir(&full).is_ok(),
                name,
            })
        })
        .take(MAX_ENTRIES)
        .collect();
    entries.sort_by_key(|e| e.name.to_lowercase());
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let dir =
                std::env::temp_dir().join(format!("gitlane-dir-{tag}-{}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn lists_folders_marks_repositories_and_skips_files_and_dot_folders() {
        let tmp = TempDir::new("list");
        let root = tmp.path();
        std::fs::create_dir_all(root.join("app/.git")).unwrap();
        std::fs::create_dir(root.join("Notes")).unwrap();
        std::fs::create_dir(root.join(".cache")).unwrap();
        std::fs::write(root.join("file.txt"), "x").unwrap();

        let entries = list_directory(root.to_str().unwrap()).unwrap();
        let summary: Vec<_> = entries
            .iter()
            .map(|e| (e.name.as_str(), e.is_repo, e.readable))
            .collect();
        assert_eq!(summary, [("app", true, true), ("Notes", false, true)]);
    }

    #[cfg(unix)]
    #[test]
    fn an_unreadable_folder_is_flagged_not_fatal() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = TempDir::new("locked");
        let locked = tmp.path().join("locked");
        std::fs::create_dir(&locked).unwrap();
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();

        let entries = list_directory(tmp.path().to_str().unwrap());
        // Root reads it anyway; the flag must match what a read really does.
        let really_readable = std::fs::read_dir(&locked).is_ok();
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o700)).unwrap();
        let entries = entries.unwrap();
        assert_eq!(entries[0].name, "locked");
        assert_eq!(entries[0].readable, really_readable);
    }

    #[test]
    fn a_relative_path_is_refused() {
        assert!(list_directory("projects").is_err());
    }
}
