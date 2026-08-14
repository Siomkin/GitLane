//! Untracked paths a hard reset's target would overwrite — which the confirm
//! lists, and which the case-folding of the filesystem decides.

use super::scope::{discover_scope, run_scoped_git_stdout_raw};
use std::collections::BTreeSet;

use git2::Repository;

use super::super::state_lease::RepositoryScope;

pub(super) fn path_conflicts_with_reset_target(untracked: &[u8], target_path: &[u8]) -> bool {
    untracked == target_path
        || (untracked.starts_with(target_path) && untracked.get(target_path.len()) == Some(&b'/'))
        || (target_path.starts_with(untracked) && target_path.get(untracked.len()) == Some(&b'/'))
}

/// Whether this checkout resolves paths case-insensitively.
///
/// Git probes the filesystem at init/clone and records the answer in
/// `core.ignorecase`, so it is the authoritative signal — a default macOS (APFS)
/// or Windows checkout is case-insensitive. When the key is missing we fall back
/// to the platform default rather than assuming the permissive answer.
pub(in crate::git::write) fn case_insensitive_paths(repository: &Repository) -> bool {
    repository
        .config()
        .and_then(|config| config.get_bool("core.ignorecase"))
        .unwrap_or(cfg!(any(target_os = "macos", target_os = "windows")))
}

/// The form of `path` used to compare it against target-tree paths.
///
/// Case folding is ASCII-only: it catches `Foo` vs `foo`, the collision that
/// actually occurs, without pulling in a Unicode dependency. Paths differing
/// only by Unicode case or NFC/NFD normalization are therefore still missed —
/// see [`target_obstruction_paths`].
pub(super) fn obstruction_key(path: &[u8], case_insensitive: bool) -> Vec<u8> {
    if case_insensitive {
        path.to_ascii_lowercase()
    } else {
        path.to_vec()
    }
}

/// Untracked paths (including ignored) that `git reset --hard` may overwrite
/// because they collide with a path in the target tree. Status porcelain omits
/// ignored files, so these must be leased separately (GL-302 review).
///
/// On a case-insensitive checkout an ignored `Foo` and a tracked target `foo`
/// are the *same* filesystem entry, so the comparison folds case there — GitLane
/// runs on macOS, where that is the default. Over-matching is the safe
/// direction: a false positive only leases one extra path, while a miss leaves a
/// file the reset overwrites outside the state the user confirmed. Unicode case
/// and NFC/NFD differences remain uncovered; those need a normalization
/// dependency the crate does not carry.
pub(super) fn target_obstruction_paths(
    scope: &RepositoryScope,
    target_oid: &str,
    case_insensitive: bool,
) -> Result<BTreeSet<Vec<u8>>, String> {
    let target_tree = format!("{target_oid}^{{tree}}");
    let target_raw = run_scoped_git_stdout_raw(
        scope,
        &[
            "--no-replace-objects",
            "ls-tree",
            "-r",
            "-z",
            "--name-only",
            &target_tree,
        ],
    )?;
    let target_keys = target_raw
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
        .map(|path| obstruction_key(path, case_insensitive))
        .collect::<Vec<_>>();
    // Deliberately omit `--exclude-standard`: ignored files are still untracked
    // and reset --hard overwrites them when the target tree tracks that path.
    let untracked_raw = run_scoped_git_stdout_raw(scope, &["ls-files", "--others", "-z"])?;
    let mut obstructions = BTreeSet::new();
    for untracked in untracked_raw
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
    {
        let untracked_key = obstruction_key(untracked, case_insensitive);
        if target_keys
            .iter()
            .any(|target_key| path_conflicts_with_reset_target(&untracked_key, target_key))
        {
            // Lease the path as git reported it — the key is only for matching.
            obstructions.insert(untracked.to_vec());
        }
    }
    Ok(obstructions)
}

/// Untracked (including ignored) paths that may be deleted by `git reset --hard`
/// because they collide with the target tree — for the confirmation warning list.
/// Shares detection with the lease fingerprint so preview and execute cannot drift.
pub(in crate::git::write) fn preview_untracked_obstructions(
    repo: &str,
    target_oid: &str,
) -> Result<Vec<String>, String> {
    let (repository, scope) = discover_scope(repo)?;
    // Same folding as the lease, or the warning list and the fingerprinted set
    // would disagree on a case-insensitive checkout.
    let paths = target_obstruction_paths(&scope, target_oid, case_insensitive_paths(&repository))?;
    Ok(paths
        .into_iter()
        .take(16)
        .map(|path| format!("?? {}", String::from_utf8_lossy(&path)))
        .collect())
}
