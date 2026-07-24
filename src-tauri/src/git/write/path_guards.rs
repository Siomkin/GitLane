//! Worktree-path guards shared by the path-scoped write commands.
//!
//! Every command that takes a repo-relative path from IPC — reveal, restore,
//! open, patch — must reject the same set of escapes before it touches the
//! filesystem or hands the path to git. Each used to carry its own copy of
//! that check, identical apart from the verb in the error text. Four copies of
//! a security boundary is where one divergent edit silently weakens some
//! callers and not others, so the check lives here once and the verb is a
//! parameter.
//!
//! The lexical check here is deliberately *not* the whole story: it stops `..`
//! and `.git` components, but a symlink can still redirect a later open — in an
//! ancestor, or as the leaf itself. [`resolve_existing_leaf`] therefore finishes
//! the job through [`crate::git::worktree_fs`]'s no-follow resolution and its
//! regular-file gate.

use std::path::{Component, Path, PathBuf};

use crate::git::read::open;
use crate::git::worktree_fs::{open_worktree_file, worktree_leaf_exists_nofollow};

use super::cli::run_git;

/// The user-facing verb a guard names when it refuses a path. Both spellings
/// are stored rather than derived so the wording each caller shipped stays
/// byte-identical — these strings are asserted on in tests and read by users.
#[derive(Clone, Copy)]
pub(super) enum PathVerb {
    Open,
    Patch,
    Restore,
    Reveal,
}

impl PathVerb {
    /// Mid-sentence form: "Missing path to **open**".
    fn lower(self) -> &'static str {
        match self {
            PathVerb::Open => "open",
            PathVerb::Patch => "patch",
            PathVerb::Restore => "restore",
            PathVerb::Reveal => "reveal",
        }
    }

    /// Sentence-initial form: "**Open** path must be repository-relative".
    fn capitalized(self) -> &'static str {
        match self {
            PathVerb::Open => "Open",
            PathVerb::Patch => "Patch",
            PathVerb::Restore => "Restore",
            PathVerb::Reveal => "Reveal",
        }
    }
}

/// Validate a repo-relative path from IPC and return it with surrounding
/// slashes trimmed. Rejects an empty path, an absolute path, any `..`
/// component, and any `.git` component (case-insensitively — HFS+/APFS and
/// NTFS would otherwise let `.GIT/config` through).
pub(super) fn normalize_relative(file: &str, verb: PathVerb) -> Result<String, String> {
    if file.is_empty() {
        return Err(format!("Missing path to {}", verb.lower()));
    }
    let relative = Path::new(file);
    if relative.is_absolute() {
        return Err(format!(
            "{} path must be repository-relative",
            verb.capitalized()
        ));
    }
    if relative
        .components()
        .any(|c| matches!(c, Component::ParentDir))
    {
        return Err(format!(
            "Refusing to {} path outside the worktree: {file}",
            verb.lower()
        ));
    }
    if relative
        .components()
        .any(|c| matches!(c, Component::Normal(name) if name.eq_ignore_ascii_case(".git")))
    {
        return Err(format!(
            "Refusing to {} path outside the worktree: {file}",
            verb.lower()
        ));
    }
    let trimmed = file.trim_matches('/');
    if trimmed.is_empty() {
        return Err(format!("Missing path to {}", verb.lower()));
    }
    Ok(trimmed.to_string())
}

/// True when HEAD resolves to a commit. False on an unborn HEAD (fresh
/// `git init`, no commits yet), where `restore --staged` / `reset HEAD` and
/// `diff HEAD` die with `fatal: could not resolve 'HEAD'` — callers must fall
/// back to index-only commands there.
pub(super) fn has_head(repo: &str) -> bool {
    run_git(repo, &["rev-parse", "--verify", "--quiet", "HEAD"]).is_ok()
}

/// Resolve `file` to an absolute worktree path, proving the leaf exists and
/// that no ancestor symlink redirects it outside the repository. Normalizing
/// here is idempotent, so callers holding an already-normalized path may pass
/// it straight through.
pub(super) fn resolve_existing_leaf(
    repo: &str,
    file: &str,
    verb: PathVerb,
) -> Result<PathBuf, String> {
    let relative = normalize_relative(file, verb)?;
    let repository = open(repo).map_err(|e| e.to_string())?;
    let workdir = repository
        .workdir()
        .ok_or_else(|| "repository has no working directory".to_string())?;
    match worktree_leaf_exists_nofollow(workdir, &relative) {
        Ok(true) => {
            ensure_regular_leaf(workdir, &relative, verb)?;
            Ok(workdir.join(&relative))
        }
        Ok(false) => Err(format!("{relative} is not on disk")),
        Err(error) => Err(format!("Couldn't {} {relative}: {error}", verb.lower())),
    }
}

/// Refuse a leaf that is not a regular file. [`worktree_leaf_exists_nofollow`]
/// blocks a symlink in any *ancestor*, but it is existence-only about the leaf
/// itself: a symlink there answers `true`. That is safe wherever git does the
/// reading — git diffs a symlink as its link text, never the target — and
/// unsafe for every caller that touches the filesystem directly: the OS opener
/// (`open` / `xdg-open` / `ShellExecuteW`) follows it, and so does
/// `git diff --no-index`. A repository can commit `link -> /etc/passwd`, so
/// cloning a hostile one must not put the user's own files one click away, nor
/// inline them into a generated patch (GL-337 review).
///
/// `open_worktree_file` is the existing no-follow gate for this — it answers
/// `None` for anything that is not a regular file. The handle it returns is
/// dropped immediately; only the verdict is wanted.
fn ensure_regular_leaf(workdir: &Path, relative: &str, verb: PathVerb) -> Result<(), String> {
    match open_worktree_file(workdir, relative) {
        Ok(Some(_)) => Ok(()),
        Ok(None) => Err(format!(
            "Refusing to {} {relative}: not a regular file. Symlinks and special files can point outside the worktree.",
            verb.lower()
        )),
        Err(error) => Err(format!("Couldn't {} {relative}: {error}", verb.lower())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_relative_rejects_every_escape_shape() {
        for verb in [
            PathVerb::Open,
            PathVerb::Patch,
            PathVerb::Restore,
            PathVerb::Reveal,
        ] {
            assert!(normalize_relative("", verb).is_err(), "empty");
            assert!(normalize_relative("/abs", verb).is_err(), "absolute");
            assert!(normalize_relative("../outside", verb).is_err(), "parent");
            assert!(normalize_relative("a/../../b", verb).is_err(), "mid parent");
            assert!(normalize_relative(".git/config", verb).is_err(), ".git");
            assert!(normalize_relative("///", verb).is_err(), "all slashes");
        }
    }

    #[test]
    fn normalize_relative_rejects_dot_git_whatever_its_case() {
        // APFS and NTFS are case-insensitive, so `.GIT/config` reaches the same
        // files `.git/config` does.
        for spelling in [".GIT/config", ".Git/config", "nested/.gIt/hooks"] {
            assert!(
                normalize_relative(spelling, PathVerb::Open).is_err(),
                "{spelling} must be refused"
            );
        }
    }

    #[test]
    fn normalize_relative_accepts_and_trims_a_worktree_path() {
        assert_eq!(
            normalize_relative("src/main.rs", PathVerb::Patch).unwrap(),
            "src/main.rs"
        );
        assert_eq!(
            normalize_relative("/src/main.rs/", PathVerb::Patch).unwrap_err(),
            "Patch path must be repository-relative"
        );
        assert_eq!(
            normalize_relative("src/main.rs/", PathVerb::Patch).unwrap(),
            "src/main.rs"
        );
        // A leading `-` is a real filename, not an option: these paths always
        // reach git after `--` with `--literal-pathspecs`.
        assert_eq!(
            normalize_relative("-notes.txt", PathVerb::Patch).unwrap(),
            "-notes.txt"
        );
    }

    /// The wording each caller shipped before these guards were merged (GL-342),
    /// transcribed from the four `normalize_relative` copies at b680071f. The
    /// extraction was meant to be invisible to users, so every message a verb
    /// can produce is pinned here rather than spot-checked.
    #[test]
    fn every_verb_reproduces_the_wording_it_shipped_with() {
        let cases = [
            (
                PathVerb::Reveal,
                "Missing path to reveal",
                "Reveal path must be repository-relative",
                "Refusing to reveal path outside the worktree: ",
            ),
            (
                PathVerb::Restore,
                "Missing path to restore",
                "Restore path must be repository-relative",
                "Refusing to restore path outside the worktree: ",
            ),
            (
                PathVerb::Open,
                "Missing path to open",
                "Open path must be repository-relative",
                "Refusing to open path outside the worktree: ",
            ),
            (
                PathVerb::Patch,
                "Missing path to patch",
                "Patch path must be repository-relative",
                "Refusing to patch path outside the worktree: ",
            ),
        ];

        for (verb, missing, absolute, outside) in cases {
            assert_eq!(normalize_relative("", verb).unwrap_err(), missing);
            assert_eq!(normalize_relative("/abs", verb).unwrap_err(), absolute);
            assert_eq!(
                normalize_relative("../x", verb).unwrap_err(),
                format!("{outside}../x")
            );
            assert_eq!(
                normalize_relative(".git/config", verb).unwrap_err(),
                format!("{outside}.git/config")
            );
        }
    }
}
