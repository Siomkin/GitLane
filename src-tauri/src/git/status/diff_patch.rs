//! A commit, a range, or a revision against the working tree as patch text,
//! for an AI-action prompt (the agent would otherwise run `git show`/`git diff`).

use git2::DiffOptions;

use super::range::tree_for;
use super::staged_patch::print_capped;
use crate::git::read::open;

/// Patch text, or `None` over `max_bytes` (see `staged_patch`):
/// - `head` alone: that commit against its first parent, after its message,
///   as `git show <head>` prints it;
/// - `base` and `head`: `git diff <base> <head>`;
/// - `base` alone: `git diff <base>` plus untracked files with their content.
pub fn diff_patch(
    path: &str,
    base: Option<&str>,
    head: Option<&str>,
    max_bytes: usize,
) -> Result<Option<String>, git2::Error> {
    let repo = open(path)?;
    let mut prefix = Vec::new();
    let mut diff = match (base, head) {
        (None, Some(head)) => {
            let commit = repo.revparse_single(head)?.peel_to_commit()?;
            let parent = commit.parent(0).ok().map(|p| p.tree()).transpose()?;
            prefix = format!("commit {}\n\n", commit.id()).into_bytes();
            for line in String::from_utf8_lossy(commit.message_bytes()).lines() {
                prefix.extend_from_slice(format!("    {line}\n").as_bytes());
            }
            prefix.push(b'\n');
            repo.diff_tree_to_tree(parent.as_ref(), Some(&commit.tree()?), None)?
        }
        (Some(base), Some(head)) => {
            let (base, head) = (tree_for(&repo, base)?, tree_for(&repo, head)?);
            repo.diff_tree_to_tree(Some(&base), Some(&head), None)?
        }
        (Some(base), None) => {
            let base = tree_for(&repo, base)?;
            let mut opts = DiffOptions::new();
            opts.include_untracked(true)
                .recurse_untracked_dirs(true)
                .show_untracked_content(true);
            repo.diff_tree_to_workdir_with_index(Some(&base), Some(&mut opts))?
        }
        (None, None) => return Err(git2::Error::from_str("diff_patch needs a base or a head")),
    };
    diff.find_similar(None)?;
    print_capped(&diff, prefix, max_bytes, |_| false)
}
