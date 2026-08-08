//! Nested-repository detection. A submodule or stray clone inside the worktree
//! is not ours to discard, so a tracked path that resolves into one aborts the
//! operation rather than reaching `git` with it.

use std::ffi::{OsStr, OsString};
use std::path::Path;

use super::super::state_lease::path_label;
use super::{git_path, ParsedStatus};

pub(super) fn looks_like_bare_repository(candidate: &Path) -> bool {
    candidate.join("HEAD").is_file()
        && candidate.join("objects").is_dir()
        && (candidate.join("refs").is_dir() || candidate.join("packed-refs").is_file())
}

pub(super) fn has_git_marker(candidate: &Path) -> bool {
    match std::fs::symlink_metadata(candidate.join(".git")) {
        Ok(_) => true,
        Err(error) => error.kind() != std::io::ErrorKind::NotFound,
    }
}

pub(super) fn nested_repository_root(workdir: &Path, path: &OsStr) -> Option<OsString> {
    Path::new(path).ancestors().find_map(|relative| {
        if relative.as_os_str().is_empty() {
            return None;
        }
        let candidate = workdir.join(relative);
        let directory = std::fs::symlink_metadata(&candidate)
            .map(|metadata| metadata.file_type().is_dir())
            .unwrap_or(false);
        if directory && (has_git_marker(&candidate) || looks_like_bare_repository(&candidate)) {
            Some(relative.as_os_str().to_os_string())
        } else {
            None
        }
    })
}

pub(super) fn reject_tracked_paths_in_nested_repositories(
    workdir: &Path,
    status: &ParsedStatus,
) -> Result<(), String> {
    for raw_path in &status.tracked_paths {
        let path = git_path(raw_path)?;
        if let Some(root) = nested_repository_root(workdir, &path) {
            return Err(format!(
                "Tracked parent-repository path {} is now inside nested Git repository {}. The newer nested repository and its files were preserved; refresh and preview again.",
                path_label(&path),
                path_label(&root)
            ));
        }
    }
    Ok(())
}
