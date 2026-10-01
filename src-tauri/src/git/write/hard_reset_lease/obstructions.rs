//! Untracked paths a hard reset's target would overwrite — which the confirm
//! lists, and which the case-folding of the filesystem decides.

use super::scope::{discover_scope, run_scoped_git_stdout_raw};
use std::collections::{BTreeSet, HashSet};

use git2::Repository;

use super::super::state_lease::RepositoryScope;

/// The untracked paths in `untracked_raw` that collide with a path in
/// `target_raw` (both NUL-separated, as `-z` prints them): the same path, a
/// path under a target file, or a directory holding a target path.
///
/// One pass builds the set of target keys and the set of all their directory
/// prefixes, so each untracked path costs O(depth) lookups rather than a scan
/// of the whole target tree — `node_modules/` against a large tree is common.
fn obstructing_paths(
    target_raw: &[u8],
    untracked_raw: &[u8],
    case_insensitive: bool,
) -> BTreeSet<Vec<u8>> {
    let nonempty = |raw: &'_ [u8]| -> Vec<Vec<u8>> {
        raw.split(|byte| *byte == 0)
            .filter(|path| !path.is_empty())
            .map(<[u8]>::to_vec)
            .collect()
    };
    let slashes = |key: &[u8]| -> Vec<usize> {
        key.iter()
            .enumerate()
            .filter(|(_, byte)| **byte == b'/')
            .map(|(i, _)| i)
            .collect()
    };
    let mut target_files = HashSet::new();
    let mut target_dirs = HashSet::new();
    for path in nonempty(target_raw) {
        let key = obstruction_key(&path, case_insensitive);
        for i in slashes(&key) {
            target_dirs.insert(key[..i].to_vec());
        }
        target_files.insert(key);
    }
    nonempty(untracked_raw)
        .into_iter()
        .filter(|untracked| {
            let key = obstruction_key(untracked, case_insensitive);
            target_files.contains(&key)
                || target_dirs.contains(&key)
                || slashes(&key)
                    .into_iter()
                    .any(|i| target_files.contains(&key[..i]))
        })
        .collect()
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
    // Deliberately omit `--exclude-standard`: ignored files are still untracked
    // and reset --hard overwrites them when the target tree tracks that path.
    let untracked_raw = run_scoped_git_stdout_raw(scope, &["ls-files", "--others", "-z"])?;
    // Paths come back as git reported them — the key is only for matching.
    Ok(obstructing_paths(
        &target_raw,
        &untracked_raw,
        case_insensitive,
    ))
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

#[cfg(test)]
mod tests {
    use super::*;

    fn found(target: &[&str], untracked: &[&str], case_insensitive: bool) -> Vec<String> {
        let raw = |paths: &[&str]| paths.join("\0").into_bytes();
        obstructing_paths(&raw(target), &raw(untracked), case_insensitive)
            .into_iter()
            .map(|path| String::from_utf8(path).unwrap())
            .collect()
    }

    #[test]
    fn same_path_nested_path_and_holding_directory_obstruct() {
        let target = ["a.txt", "dir/b.txt", "deep/x/y.txt"];
        let untracked = [
            "a.txt",       // same path
            "a.txt/inner", // under a target file
            "deep/x",      // a directory holding a target path
            "dir/c.txt",   // sibling: no collision
            "dir.txt",     // shares a prefix but not a component
            "deep/x2",
        ];
        assert_eq!(
            found(&target, &untracked, false),
            ["a.txt", "a.txt/inner", "deep/x"]
        );
    }

    #[test]
    fn case_folding_applies_only_on_case_insensitive_checkouts() {
        assert_eq!(found(&["foo"], &["Foo"], true), ["Foo"]);
        assert!(found(&["foo"], &["Foo"], false).is_empty());
    }

    #[test]
    fn ten_thousand_by_ten_thousand_finishes_quickly() {
        let target: Vec<String> = (0..10_000)
            .map(|i| format!("src/m{}/f{i}.rs", i % 100))
            .collect();
        let untracked: Vec<String> = (0..10_000)
            .map(|i| format!("node_modules/p{}/i{i}.js", i % 100))
            .chain(["src/m1/f1.rs".to_string()])
            .collect();
        let target: Vec<&str> = target.iter().map(String::as_str).collect();
        let untracked: Vec<&str> = untracked.iter().map(String::as_str).collect();
        let started = std::time::Instant::now();
        assert_eq!(found(&target, &untracked, true), ["src/m1/f1.rs"]);
        assert!(started.elapsed() < std::time::Duration::from_secs(1));
    }
}
