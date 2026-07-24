//! Collision-safe email patch creation in the repository worktree.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Component, Path, PathBuf};

use super::cli::{run_git, run_git_stdout_raw, run_git_stdout_raw_allow_exit_codes};
use super::history::is_merge_commit;
use super::operands::ensure_operand;

/// Write a patch for one non-merge commit into the worktree without allowing
/// git's generated filename to overwrite an existing file. `format-patch -1`
/// silently skips merge commits and selects a nearby non-merge ancestor, so
/// merges are rejected until the UI exposes an explicit first-parent policy.
pub fn create_patch(repo: &str, sha: &str) -> Result<String, String> {
    ensure_operand(sha)?;
    if is_merge_commit(repo, sha)? {
        return Err(
            "Merge commits do not have a single email-patch delta. Review a parent diff or choose a non-merge commit."
                .to_string(),
        );
    }

    let patch = run_git_stdout_raw(repo, &["format-patch", "--stdout", "-1", sha])?;
    let subject = run_git(
        repo,
        &["show", "-s", "--no-show-signature", "--format=%f", sha],
    )?;
    let fallback: String = sha.chars().take(12).collect();
    let safe_subject: String = subject.trim().chars().take(96).collect();
    let safe_subject = if safe_subject.is_empty() {
        fallback.as_str()
    } else {
        safe_subject.as_str()
    };

    write_collision_safe(repo, &format!("0001-{safe_subject}"), &patch)
}

/// Write a single mailbox file covering every commit in the contiguous
/// `base..head` range (`git format-patch --stdout`). Callers gate this on a
/// first-parent-contiguous selection (the same range the batch "Compare" uses),
/// so the range is a straight line; a merge inside it is rejected because
/// `format-patch` would silently drop it, producing a patch that doesn't match
/// what the user selected.
pub fn create_patch_range(repo: &str, base: &str, head: &str) -> Result<String, String> {
    ensure_operand(base)?;
    ensure_operand(head)?;
    let range = format!("{base}..{head}");

    let merges = run_git(repo, &["rev-list", "--merges", "--count", &range])?;
    if merges.trim() != "0" {
        return Err(
            "The selection includes a merge commit, which has no single email-patch delta. Choose a range of non-merge commits."
                .to_string(),
        );
    }

    let patch = run_git_stdout_raw(repo, &["format-patch", "--stdout", &range])?;
    if patch.is_empty() {
        return Err("The selected commits produced no patch.".to_string());
    }

    let count = run_git(repo, &["rev-list", "--count", &range])?;
    let count = count.trim();
    let subject = run_git(
        repo,
        &["show", "-s", "--no-show-signature", "--format=%f", head],
    )?;
    let fallback: String = head.chars().take(12).collect();
    let safe_subject: String = subject.trim().chars().take(96).collect();
    let safe_subject = if safe_subject.is_empty() {
        fallback.as_str()
    } else {
        safe_subject.as_str()
    };

    write_collision_safe(repo, &format!("{count}-commits-{safe_subject}"), &patch)
}

/// Write a unified diff for one working-tree path into the worktree as a
/// collision-safe `.patch` file (GL-337). Tracked paths use `git diff HEAD`;
/// untracked paths use `git diff --no-index` against an empty file.
pub fn create_working_tree_patch(repo: &str, file: &str) -> Result<String, String> {
    // Path lands after `--` with `--literal-pathspecs`, so leading `-` in a
    // real filename is fine — do not call [`ensure_operand`] here.
    let relative = normalize_relative(file)?;
    let patch = working_tree_patch_bytes(repo, &relative)?;
    if patch.is_empty() {
        return Err(format!("No working-tree changes to patch for {relative}"));
    }
    let stem = Path::new(&relative)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("change");
    let safe_stem: String = stem
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .take(96)
        .collect();
    write_collision_safe(repo, &format!("wip-{safe_stem}"), &patch)
}

fn working_tree_patch_bytes(repo: &str, file: &str) -> Result<Vec<u8>, String> {
    // Prefer an explicit HEAD (or staged) delta so staged deletions — which
    // have no index entry — still produce a deletion patch instead of being
    // misclassified as untracked (GL-337 review). `--binary` keeps binary
    // content in the mailbox rather than an "Binary files differ" stub.
    if has_head(repo) {
        let patch = run_git_stdout_raw(
            repo,
            &[
                "--literal-pathspecs",
                "diff",
                "--binary",
                "HEAD",
                "--",
                file,
            ],
        )?;
        if !patch.is_empty() {
            return Ok(patch);
        }
    } else {
        // Unborn HEAD has no empty-tree equivalent for `diff HEAD`. A coherent
        // "final worktree" patch (matching born `diff HEAD` net effect) is
        // `--no-index` against /dev/null when the leaf exists. Concatenating
        // `--cached` + unstaged produces a corrupt mailbox `git apply` rejects.
        // If the leaf is gone, fall back to the staged delta alone.
        if ensure_safe_worktree_leaf(repo, file).is_ok() {
            return no_index_new_file_patch(repo, file);
        }
        let cached = run_git_stdout_raw(
            repo,
            &[
                "--literal-pathspecs",
                "diff",
                "--binary",
                "--cached",
                "--",
                file,
            ],
        )?;
        if !cached.is_empty() {
            return Ok(cached);
        }
    }

    // Truly untracked on-disk leaf: synthesize a "new file" patch.
    ensure_safe_worktree_leaf(repo, file)?;
    no_index_new_file_patch(repo, file)
}

fn no_index_new_file_patch(repo: &str, file: &str) -> Result<Vec<u8>, String> {
    // `diff --no-index` exits 1 when the files differ, which is the success
    // case. Raw stdout keeps non-UTF-8 / binary bytes intact.
    let null = if cfg!(windows) { "NUL" } else { "/dev/null" };
    run_git_stdout_raw_allow_exit_codes(
        repo,
        &[
            "--literal-pathspecs",
            "diff",
            "--binary",
            "--no-index",
            "--",
            null,
            file,
        ],
        &[1],
    )
}

fn ensure_safe_worktree_leaf(repo: &str, file: &str) -> Result<(), String> {
    let repository = crate::git::read::open(repo).map_err(|e| e.to_string())?;
    let workdir = repository
        .workdir()
        .ok_or_else(|| "repository has no working directory".to_string())?;
    match crate::git::worktree_fs::worktree_leaf_exists_nofollow(workdir, file) {
        // Existence alone is not enough here: the caller feeds this path to
        // `git diff --no-index`, which reads the leaf through the filesystem
        // rather than as a git blob. A symlink leaf answers `true` above, so
        // without the regular-file gate a committed `link -> /etc/passwd`
        // would end up inlined into the generated patch. The tracked
        // `diff HEAD` branch needs no such check — git reads a symlink there
        // as its link text, never the target.
        Ok(true) => match crate::git::worktree_fs::open_worktree_file(workdir, file) {
            Ok(Some(_)) => Ok(()),
            Ok(None) => Err(format!(
                "Refusing to patch {file}: not a regular file. Symlinks and special files can point outside the worktree."
            )),
            Err(error) => Err(format!("Couldn't patch {file}: {error}")),
        },
        Ok(false) => Err(format!("{file} is not on disk")),
        Err(error) => Err(format!("Couldn't patch {file}: {error}")),
    }
}

fn has_head(repo: &str) -> bool {
    run_git(repo, &["rev-parse", "--verify", "--quiet", "HEAD"]).is_ok()
}

fn normalize_relative(file: &str) -> Result<String, String> {
    if file.is_empty() {
        return Err("Missing path to patch".to_string());
    }
    let relative = Path::new(file);
    if relative.is_absolute() {
        return Err("Patch path must be repository-relative".to_string());
    }
    if relative
        .components()
        .any(|c| matches!(c, Component::ParentDir))
    {
        return Err(format!(
            "Refusing to patch path outside the worktree: {file}"
        ));
    }
    if relative
        .components()
        .any(|c| matches!(c, Component::Normal(name) if name.eq_ignore_ascii_case(".git")))
    {
        return Err(format!(
            "Refusing to patch path outside the worktree: {file}"
        ));
    }
    let trimmed = file.trim_matches('/');
    if trimmed.is_empty() {
        return Err("Missing path to patch".to_string());
    }
    Ok(trimmed.to_string())
}

/// Write `patch` into the repo worktree under `<base_name>.patch`, never
/// overwriting an existing file — a numeric suffix is appended on collision so
/// git's generated name can't clobber the user's files.
fn write_collision_safe(repo: &str, base_name: &str, patch: &[u8]) -> Result<String, String> {
    let worktree_raw = run_git_stdout_raw(repo, &["rev-parse", "--show-toplevel"])?;
    let worktree = String::from_utf8(worktree_raw)
        .map_err(|_| "The repository worktree path is not valid UTF-8.".to_string())?;
    let worktree = PathBuf::from(worktree.trim_end_matches(['\r', '\n']));

    for collision in 0..10_000 {
        let filename = if collision == 0 {
            format!("{base_name}.patch")
        } else {
            format!("{base_name}-{}.patch", collision + 1)
        };
        let path = worktree.join(&filename);
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                if let Err(error) = file.write_all(patch) {
                    let _ = std::fs::remove_file(&path);
                    return Err(format!("Couldn't write patch {filename}: {error}"));
                }
                return Ok(filename);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("Couldn't create patch {filename}: {error}")),
        }
    }

    Err("Couldn't choose an unused patch filename in the worktree.".to_string())
}
