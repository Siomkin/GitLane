//! Creating a repository: `init` into a new directory (optionally seeding a
//! README and .gitignore), and `init_in_place` for a folder that already has
//! content.

use std::path::Path;

use super::super::operands::{ensure_operand, ensure_safe_leaf};

/// Initialize a new repository at `parent`/`name` on initial branch `branch`,
/// optionally seeding a README and a `.gitignore` template. Validates the target
/// isn't already a repo / a non-empty folder so init never lands the app on a
/// half-open or pre-existing repository. Returns the new repo's path.
pub fn init(
    parent: &str,
    name: &str,
    branch: &str,
    readme: bool,
    gitignore: &str,
) -> Result<String, String> {
    let parent = parent.trim().trim_end_matches('/');
    let name = name.trim();
    let branch = branch.trim();
    if parent.is_empty() {
        return Err("Choose a location for the new repository.".to_string());
    }
    let parent_path = Path::new(parent);
    if !parent_path.is_absolute() {
        return Err("Choose an absolute location for the new repository.".to_string());
    }
    if name.is_empty() {
        return Err("Enter a folder name for the new repository.".to_string());
    }
    // Reject `.`/`..`/separators so the new repo is always a fresh child of the
    // chosen parent (shared with the clone destination leaf check).
    ensure_safe_leaf(name)?;
    let branch = if branch.is_empty() { "main" } else { branch };
    ensure_operand(name)?;
    ensure_operand(branch)?;

    let target_path = parent_path.join(name);
    let target = target_path.to_string_lossy().to_string();
    if target_path.join(".git").exists() {
        return Err(format!("{target} is already a Git repository."));
    }
    let non_empty = std::fs::read_dir(&target)
        .map(|mut entries| entries.next().is_some())
        .unwrap_or(false);
    if non_empty {
        return Err(format!(
            "The folder {target} already exists and isn't empty. Choose an empty folder or a different name."
        ));
    }
    // Remember whether the directory already existed: a rollback must only remove
    // a directory this init created, never one the user already had.
    let existed_before = target_path.exists();
    std::fs::create_dir_all(&target).map_err(|e| format!("Couldn't create {target}: {e}"))?;

    // Run init + seed files as one fallible unit so a failure after the directory
    // exists can be rolled back rather than leaving an orphaned empty/partial repo.
    let seeded = (|| -> Result<(), String> {
        super::super::cli::run_git_bare(&["init", "-b", branch, "--", &target])?;
        if readme {
            std::fs::write(target_path.join("README.md"), format!("# {name}\n"))
                .map_err(|e| format!("Couldn't write README.md: {e}"))?;
        }
        if let Some(contents) = gitignore_template(gitignore) {
            std::fs::write(target_path.join(".gitignore"), contents)
                .map_err(|e| format!("Couldn't write .gitignore: {e}"))?;
        }
        Ok(())
    })();

    if let Err(e) = seeded {
        if !existed_before {
            let _ = std::fs::remove_dir_all(&target);
        }
        return Err(e);
    }

    Ok(target)
}

/// Initialize an already-existing, possibly non-empty directory as a git
/// repository **in place** — the "Initialize as git repo" recovery action for
/// a folder that lost its `.git` (GL-108's `notARepository` case, GL-153).
/// Unlike [`init`], this never scaffolds a README/`.gitignore` and never
/// rejects a non-empty directory (the whole point is adopting the user's
/// existing files); it only refuses a path that isn't a real directory or is
/// already a *valid* repo. Returns the canonical repo path from the post-init
/// open probe (same normalization as [`crate::git::read::summary_classified`]).
pub fn init_in_place(path: &str) -> Result<String, String> {
    if path.trim().is_empty() {
        return Err("Choose a folder to initialize.".to_string());
    }
    ensure_operand(path)?;
    let target_path = std::path::Path::new(path);
    if !target_path.is_dir() {
        return Err(format!("{path} is not a folder."));
    }
    // Block only when libgit2 can open the repo — the same probe `open_repo`
    // uses — so this action never disagrees with the missing-repo screen's
    // `notARepository` classification (GL-153 review). A broken or
    // partially-initialized `.git` still fails that probe and is repaired by
    // `git init` below; only a genuinely openable repo is rejected.
    if crate::git::read::summary_classified(path).is_ok() {
        return Err(format!(
            "{path} is already a Git repository — try Retry to open it."
        ));
    }
    // A `.git` *file* (a linked worktree's gitdir pointer) that failed the
    // open probe above is dangling — unlike a `.git` *directory*, which `init`
    // repairs in place (tested above), git refuses to `init` over a `.git`
    // file at all, even a broken one, so remove it first (GL-153 review).
    // Never touch a `.git` directory here; only a plain file, which we've
    // just proven libgit2 cannot open, is safe to replace.
    let dot_git = target_path.join(".git");
    if dot_git.is_file() {
        std::fs::remove_file(&dot_git)
            .map_err(|e| format!("Couldn't remove the stale .git file at {path}: {e}"))?;
    }
    super::super::cli::run_git_bare(&["init", "--", path])?;
    crate::git::read::summary_classified(path)
        .map(|summary| summary.path)
        .map_err(|e| e.message)
}

/// Starter `.gitignore` contents for a named template, or `None` for "None" /
/// any unknown name (in which case no `.gitignore` is written). Deliberately
/// small, common-case templates rather than a full template library.
pub(super) fn gitignore_template(name: &str) -> Option<&'static str> {
    match name.trim().to_ascii_lowercase().as_str() {
        "node" => Some("node_modules/\ndist/\nbuild/\n*.log\n.env\n.env.local\n.DS_Store\n"),
        "rust" => Some("/target\n**/*.rs.bk\nCargo.lock\n.DS_Store\n"),
        "python" => Some("__pycache__/\n*.py[cod]\n.venv/\nvenv/\n*.egg-info/\n.env\n.DS_Store\n"),
        "macos" => Some(".DS_Store\n.AppleDouble\n.LSOverride\n._*\n.Spotlight-V100\n.Trashes\n"),
        _ => None,
    }
}
