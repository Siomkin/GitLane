//! Best-effort detection of advanced repository states surfaced with status.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use git2::{IndexEntryExtendedFlag, Repository, SubmoduleIgnore, SubmoduleStatus};

use crate::git::types::{
    AdvancedRepoState, FileAdvancedState, FileChange, LfsState, SparseCheckoutState,
    SubmoduleState, ADVANCED_KIND_SPARSE, ADVANCED_KIND_SUBMODULE,
};

pub(super) const MAX_GITATTRIBUTES_BYTES: usize = 256 * 1024;

pub(super) fn advanced_state(repo: &Repository, changed_paths: &[String]) -> AdvancedRepoState {
    let submodules = submodule_states(repo);
    let lfs = lfs_state(repo, changed_paths);
    let sparse_checkout = sparse_checkout_state(repo);

    AdvancedRepoState {
        submodules,
        lfs,
        sparse_checkout,
    }
}

pub(super) fn annotate_advanced_files(
    repo: &Repository,
    changes: &mut [FileChange],
    advanced: &AdvancedRepoState,
) {
    let submodule_messages: HashMap<&str, String> = advanced
        .submodules
        .iter()
        .filter(|submodule| submodule.dirty || !submodule.initialized)
        .map(|submodule| {
            (
                submodule.path.as_str(),
                format!("Submodule: {}", submodule.status),
            )
        })
        .collect();

    // Best-effort annotation for rows libgit2 already returned. Some
    // visible-but-outside-sparse paths are omitted from libgit2 status, so the
    // user-facing write guard also checks sparse patterns in the frontend.
    let sparse_paths = sparse_skip_worktree_paths(repo, changes);

    for change in changes {
        if let Some(message) = submodule_messages.get(change.path.as_str()) {
            change.advanced = Some(FileAdvancedState {
                kind: ADVANCED_KIND_SUBMODULE.to_string(),
                message: message.clone(),
            });
        } else if sparse_paths.contains(change.path.as_str()) {
            change.advanced = Some(FileAdvancedState {
                kind: ADVANCED_KIND_SPARSE.to_string(),
                message: "Outside sparse checkout".to_string(),
            });
        }
    }
}

fn sparse_skip_worktree_paths(
    repo: &Repository,
    changes: &[FileChange],
) -> std::collections::HashSet<String> {
    let mut out = std::collections::HashSet::new();
    let Ok(index) = repo.index() else {
        return out;
    };

    for change in changes {
        let Some(entry) = index.get_path(Path::new(&change.path), 0) else {
            continue;
        };
        let flags = IndexEntryExtendedFlag::from_bits_truncate(entry.flags_extended);
        if flags.is_skip_worktree() {
            out.insert(change.path.clone());
        }
    }

    out
}

fn submodule_states(repo: &Repository) -> Vec<SubmoduleState> {
    let mut out = Vec::new();
    let Ok(submodules) = repo.submodules() else {
        return out;
    };

    for submodule in submodules {
        let path = submodule.path().to_string_lossy().to_string();
        let name = submodule
            .name()
            .map(str::to_string)
            .unwrap_or_else(|_| path.clone());
        let url = submodule.url().ok().flatten().map(str::to_string);

        let status_result = repo.submodule_status(&name, SubmoduleIgnore::None);
        let (status, details, dirty, initialized) = match status_result {
            Ok(status) => summarize_submodule_status(status),
            Err(e) => (
                "status unavailable".to_string(),
                vec![e.message().to_string()],
                true,
                false,
            ),
        };

        out.push(SubmoduleState {
            path,
            name,
            url,
            status,
            details,
            dirty,
            initialized,
        });
    }

    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

fn summarize_submodule_status(status: SubmoduleStatus) -> (String, Vec<String>, bool, bool) {
    let mut details = Vec::new();

    let initialized = status.is_in_wd() && !status.is_wd_uninitialized();

    if status.is_index_added() {
        details.push("added in index".to_string());
    }
    if status.is_index_deleted() {
        details.push("deleted in index".to_string());
    }
    if status.is_index_modified() {
        details.push("index points at a different commit".to_string());
    }
    if status.is_wd_uninitialized() {
        details.push("not initialized".to_string());
    }
    if status.is_wd_added() {
        details.push("present in worktree but not index".to_string());
    }
    if status.is_wd_deleted() {
        details.push("missing from worktree".to_string());
    }
    if status.is_wd_modified() {
        details.push("worktree HEAD differs from index".to_string());
    }
    if status.is_wd_wd_modified() {
        details.push("modified files inside submodule".to_string());
    }
    if status.is_wd_untracked() {
        details.push("untracked files inside submodule".to_string());
    }

    let dirty = !details.is_empty();
    let status_text = if details.is_empty() {
        "clean".to_string()
    } else {
        details.join(", ")
    };

    (status_text, details, dirty, initialized)
}

fn lfs_state(repo: &Repository, changed_paths: &[String]) -> LfsState {
    let workdir = repo.workdir();
    let patterns = workdir.map(lfs_patterns).unwrap_or_default();

    let config_detected = repo
        .config()
        .ok()
        .map(|cfg| {
            cfg.get_string("filter.lfs.clean").is_ok()
                || cfg.get_string("filter.lfs.smudge").is_ok()
                || cfg.get_string("filter.lfs.process").is_ok()
        })
        .unwrap_or(false);

    let detected = !patterns.is_empty() || config_detected;
    let installed = if detected {
        // shell::command_on_path expands PATHEXT on Windows, so a normal
        // `git-lfs.exe` install is found — a bare-name check would miss it and
        // flag LFS as missing on every Windows LFS repo.
        Some(crate::shell::command_on_path("git-lfs"))
    } else {
        None
    };

    let changed_lfs_paths: Vec<&str> = changed_paths
        .iter()
        .filter_map(|path| lfs_path_matches(path, &patterns).then_some(path.as_str()))
        .collect();

    let pointers = if detected {
        workdir
            .map(|dir| missing_lfs_objects(dir, &changed_lfs_paths))
            .unwrap_or_default()
    } else {
        Vec::new()
    };

    let mut issues = Vec::new();
    if detected
        && installed == Some(false)
        && (!changed_lfs_paths.is_empty() || !pointers.is_empty())
    {
        issues.push("Git LFS is needed for changed or missing LFS-managed files, but git-lfs was not found on PATH.".to_string());
    }
    if detected {
        for pointer in pointers {
            issues.push(format!(
                "{pointer} is still an LFS pointer. Run git lfs pull to download the real file content."
            ));
            if issues.len() >= 4 {
                break;
            }
        }
    }

    LfsState {
        detected,
        installed,
        issues,
        patterns,
    }
}

fn lfs_patterns(workdir: &Path) -> Vec<String> {
    // Best-effort only: this intentionally reads the root attributes file.
    // Nested .gitattributes support would need a git attribute query per path.
    let Ok(bytes) = crate::git::worktree_fs::read_regular_worktree_file_bounded(
        workdir,
        ".gitattributes",
        MAX_GITATTRIBUTES_BYTES,
    ) else {
        return Vec::new();
    };
    let Ok(contents) = String::from_utf8(bytes) else {
        return Vec::new();
    };

    contents
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') || !trimmed.contains("filter=lfs") {
                return None;
            }
            trimmed.split_whitespace().next().map(str::to_string)
        })
        .collect()
}

fn lfs_path_matches(path: &str, patterns: &[String]) -> bool {
    patterns.iter().any(|pattern| {
        if pattern == path {
            return true;
        }
        if let Some(ext) = pattern.strip_prefix("*.") {
            return path
                .rsplit_once('.')
                .is_some_and(|(_, path_ext)| path_ext == ext);
        }
        if let Some(prefix) = pattern.strip_suffix("/**") {
            return path.starts_with(prefix);
        }
        if let Some(prefix) = pattern.strip_suffix('/') {
            return path.starts_with(prefix);
        }
        false
    })
}

fn missing_lfs_objects(workdir: &Path, paths: &[&str]) -> Vec<String> {
    if paths.is_empty() {
        return Vec::new();
    }

    let mut out = Vec::new();
    for path in paths {
        if out.len() >= 4 {
            break;
        }
        if looks_like_lfs_pointer(workdir, path) {
            out.push((*path).to_string());
        }
    }
    out
}

fn looks_like_lfs_pointer(workdir: &Path, path: &str) -> bool {
    use std::io::Read;

    const MAX_POINTER_BYTES: u64 = 512;
    let Ok(mut opened) = crate::git::worktree_fs::open_regular_worktree_file(workdir, path) else {
        return false;
    };
    if opened.len() > MAX_POINTER_BYTES {
        return false;
    }
    let mut bytes = Vec::with_capacity(opened.len() as usize);
    if opened.reader().read_to_end(&mut bytes).is_err() {
        return false;
    }
    let contents = String::from_utf8_lossy(&bytes);
    contents.starts_with("version https://git-lfs.github.com/spec/v1\n")
        && contents.contains("\noid sha256:")
        && contents.contains("\nsize ")
}

fn sparse_checkout_state(repo: &Repository) -> SparseCheckoutState {
    let enabled = repo
        .config()
        .ok()
        .and_then(|cfg| cfg.get_bool("core.sparseCheckout").ok())
        .unwrap_or(false);

    let mode = repo
        .config()
        .ok()
        .and_then(|cfg| cfg.get_bool("core.sparseCheckoutCone").ok())
        .map(|cone| if cone { "cone" } else { "pattern" }.to_string());

    let (patterns, truncated) = if enabled {
        sparse_patterns(repo)
    } else {
        (Vec::new(), false)
    };

    SparseCheckoutState {
        enabled,
        mode,
        patterns,
        truncated,
    }
}

/// Upper bound on sparse patterns shipped to the frontend. Realistic cone
/// checkouts stay well under this; the cap only guards against a pathological
/// sparse-checkout file inflating every status payload. Beyond it the list is
/// reported as `truncated` so the frontend stops trusting it for write guards.
const SPARSE_PATTERN_CAP: usize = 256;

/// Returns the (possibly capped) sparse-checkout patterns and whether the file
/// held more than `SPARSE_PATTERN_CAP` of them.
fn sparse_patterns(repo: &Repository) -> (Vec<String>, bool) {
    let gitdir = repo.path();
    let common_dir = PathBuf::from(repo.commondir());
    let candidates = [
        gitdir.join("info/sparse-checkout"),
        common_dir.join("info/sparse-checkout"),
    ];

    for candidate in candidates {
        let Ok(contents) = std::fs::read_to_string(candidate) else {
            continue;
        };
        let mut patterns: Vec<String> = contents
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty() && !line.starts_with('#'))
            .map(str::to_string)
            .collect();
        let truncated = patterns.len() > SPARSE_PATTERN_CAP;
        patterns.truncate(SPARSE_PATTERN_CAP);
        return (patterns, truncated);
    }

    (Vec::new(), false)
}
