//! Git apply runners and the pinned `git diff` args they consume.

use super::super::cli::run_git_with_bytes;

/// The side of the index a hunk or line is taken from. A change shown in the
/// staged diff (index vs `HEAD`) is unstaged; one shown in the worktree diff
/// (worktree vs index) is staged.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IndexSide {
    /// Changes already in the index (`git diff --cached`); applying unstages.
    Staged,
    /// Changes in the working tree not yet staged (`git diff`); applying stages.
    Unstaged,
}

impl IndexSide {
    /// The side a request's `staged` flag names.
    pub fn from_staged(staged: bool) -> Self {
        if staged {
            Self::Staged
        } else {
            Self::Unstaged
        }
    }

    /// The past-tense verb for the result message.
    pub(in crate::git::write) fn done_verb(self) -> &'static str {
        match self {
            Self::Staged => "Unstaged",
            Self::Unstaged => "Staged",
        }
    }
}

/// Build the `git diff` args for the patch source that backs hunk/line staging.
///
/// The frontend chooses a hunk/line index from the **displayed** diff, which is
/// rendered by libgit2 (`git/status/*` with `context_lines(3)`). To keep those
/// indices addressing the same boundaries here — and to keep the patch parseable
/// and `git apply`-able — every formatting knob is pinned rather than inherited
/// from the user's config:
/// - `--diff-algorithm=myers --no-indent-heuristic` matches libgit2's segmentation
///   (overrides `diff.algorithm` / `diff.indentHeuristic`).
/// - `--unified=3 --inter-hunk-context=0` matches libgit2's 3-line context and
///   no inter-hunk merging (overrides `diff.context` / `diff.interHunkContext`).
/// - `--no-color` keeps ANSI escapes out of the parsed output (overrides `color.ui`).
/// - `--src-prefix=a/ --dst-prefix=b/` keeps the standard prefixes the extracted
///   patch is re-applied with via `git apply` (overrides `diff.noprefix` /
///   `diff.mnemonicPrefix`).
/// - `--literal-pathspecs` prevents a real filename containing glob/pathspec
///   syntax from selecting a different file's patch.
///
/// `extract_single_hunk_patch`/`extract_single_line_patch` additionally validate
/// the expected hunk range + body / line content before applying, so any residual
/// divergence fails safe ("refresh and try again") instead of staging the wrong hunk.
pub(in crate::git::write) fn patch_diff_args(side: IndexSide, file: &str) -> Vec<&str> {
    let mut args = vec![
        "-c",
        "diff.suppressBlankEmpty=false",
        "--literal-pathspecs",
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--no-indent-heuristic",
        "--diff-algorithm=myers",
        "--unified=3",
        "--inter-hunk-context=0",
        "--src-prefix=a/",
        "--dst-prefix=b/",
    ];
    if side == IndexSide::Staged {
        args.push("--cached");
    }
    args.extend(["--", file]);
    args
}

/// Apply a patch taken from `side`'s diff to the index: a staged-side patch is
/// applied in reverse (unstage), a worktree-side patch forward (stage).
pub(in crate::git::write) fn apply_hunk_patch(
    repo: &str,
    patch: &[u8],
    side: IndexSide,
) -> Result<String, String> {
    let args: Vec<&str> = match side {
        IndexSide::Staged => vec!["apply", "--cached", "--reverse", "--whitespace=nowarn", "-"],
        IndexSide::Unstaged => vec!["apply", "--cached", "--whitespace=nowarn", "-"],
    };
    run_git_with_bytes(repo, &args, patch)
}
