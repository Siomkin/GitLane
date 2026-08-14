//! Git apply runners and the pinned `git diff` args they consume.

use super::super::cli::run_git_with_input;

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
pub(in crate::git::write) fn patch_diff_args(staged: bool, file: &str) -> Vec<&str> {
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
    if staged {
        args.push("--cached");
    }
    args.extend(["--", file]);
    args
}

pub(in crate::git::write) fn apply_hunk_patch(
    repo: &str,
    patch: &str,
    reverse: bool,
) -> Result<String, String> {
    let args: Vec<&str> = if reverse {
        vec!["apply", "--cached", "--reverse", "--whitespace=nowarn", "-"]
    } else {
        vec!["apply", "--cached", "--whitespace=nowarn", "-"]
    };
    run_git_with_input(repo, &args, patch)
}

pub(super) fn apply_line_patch(repo: &str, patch: &str, reverse: bool) -> Result<String, String> {
    let args: Vec<&str> = if reverse {
        vec![
            "apply",
            "--cached",
            "--reverse",
            "--unidiff-zero",
            "--whitespace=nowarn",
            "-",
        ]
    } else {
        vec![
            "apply",
            "--cached",
            "--unidiff-zero",
            "--whitespace=nowarn",
            "-",
        ]
    };
    run_git_with_input(repo, &args, patch)
}
