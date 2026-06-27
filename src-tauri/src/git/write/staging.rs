//! Working-tree staging, discard, and commit writes.

use super::cli::{run_git, run_git_with_input};

/// Stage a single file (also stages deletions).
pub fn stage_file(repo: &str, file: &str) -> Result<String, String> {
    run_git(repo, &["add", "-A", "--", file])
}

/// Unstage a single file, restoring it to its HEAD state in the index.
pub fn unstage_file(repo: &str, file: &str) -> Result<String, String> {
    run_git(repo, &["restore", "--staged", "--", file])
}

/// Stage one hunk from the worktree diff, or unstage one hunk from the staged
/// diff when `staged` is true. Git still owns patch parsing/application; the
/// frontend only chooses a hunk index from the diff it is showing.
pub fn apply_hunk(
    repo: &str,
    file: &str,
    staged: bool,
    hunk_index: usize,
    expected_header: &str,
    expected_body: &str,
) -> Result<String, String> {
    let args = patch_diff_args(staged, file);
    let diff = run_git(repo, &args)?;
    let patch = extract_single_hunk_patch(&diff, hunk_index, expected_header, expected_body)?;
    apply_hunk_patch(repo, &patch, staged)?;
    Ok(format!(
        "{} hunk in {file}",
        if staged { "Unstaged" } else { "Staged" }
    ))
}

/// Stage one changed line from the worktree diff, or unstage one changed line
/// from the staged diff when `staged` is true. The frontend identifies the
/// displayed line; Rust regenerates the current patch and rejects stale line
/// state before applying anything.
pub fn apply_line(
    repo: &str,
    file: &str,
    staged: bool,
    hunk_index: usize,
    line_index: usize,
    expected_kind: &str,
    expected_content: &str,
    expected_old_no: Option<u32>,
    expected_new_no: Option<u32>,
) -> Result<String, String> {
    let args = patch_diff_args(staged, file);
    let diff = run_git(repo, &args)?;
    let patch = extract_single_line_patch(
        &diff,
        hunk_index,
        line_index,
        expected_kind,
        expected_content,
        expected_old_no,
        expected_new_no,
    )?;
    apply_line_patch(repo, &patch, staged)?;
    Ok(format!(
        "{} line in {file}",
        if staged { "Unstaged" } else { "Staged" }
    ))
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
///
/// `extract_single_hunk_patch`/`extract_single_line_patch` additionally validate
/// the expected hunk range + body / line content before applying, so any residual
/// divergence fails safe ("refresh and try again") instead of staging the wrong hunk.
pub(super) fn patch_diff_args<'a>(staged: bool, file: &'a str) -> Vec<&'a str> {
    let mut args = vec![
        "diff",
        "--no-ext-diff",
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

pub(super) fn apply_hunk_patch(repo: &str, patch: &str, reverse: bool) -> Result<String, String> {
    let args: Vec<&str> = if reverse {
        vec!["apply", "--cached", "--reverse", "--whitespace=nowarn", "-"]
    } else {
        vec!["apply", "--cached", "--whitespace=nowarn", "-"]
    };
    run_git_with_input(repo, &args, patch)
}

fn apply_line_patch(repo: &str, patch: &str, reverse: bool) -> Result<String, String> {
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

fn extract_single_hunk_patch(
    diff: &str,
    hunk_index: usize,
    expected_header: &str,
    expected_body: &str,
) -> Result<String, String> {
    if diff.trim().is_empty() {
        return Err("No patch is available for this file".to_string());
    }

    let mut header = Vec::new();
    let mut current_hunk = Vec::new();
    let mut current_index = None;

    for line in diff.split_inclusive('\n') {
        if line.starts_with("diff --git ") && (!header.is_empty() || current_index.is_some()) {
            break;
        }

        if line.starts_with("@@ ") {
            if current_index == Some(hunk_index) {
                break;
            }
            current_index = Some(current_index.map_or(0, |idx| idx + 1));
            current_hunk.clear();
        }

        if current_index.is_some() {
            current_hunk.push(line);
        } else {
            header.push(line);
        }
    }

    let Some(found_index) = current_index else {
        return Err("Patch-level staging is unavailable for this file".to_string());
    };
    if found_index != hunk_index {
        return Err("That hunk is no longer available; refresh the diff and try again".to_string());
    }

    let actual_header = current_hunk
        .first()
        .map(|line| line.trim_end_matches(['\r', '\n']))
        .unwrap_or_default();
    if hunk_range(actual_header) != hunk_range(expected_header) {
        return Err("That hunk changed on disk; refresh the diff and try again".to_string());
    }

    // The @@ range alone can match while the body changed on disk (e.g. an edit
    // landed during the watcher debounce). Compare the body the UI displayed —
    // one `{sign}{content}` line per row (markers and trailing EOLs stripped),
    // matching the frontend's `hunkBody`.
    let actual_body = current_hunk
        .iter()
        .skip(1)
        .filter(|line| !line.starts_with('\\'))
        .map(|line| line.trim_end_matches(['\r', '\n']))
        .collect::<Vec<_>>()
        .join("\n");
    if actual_body != expected_body {
        return Err("That hunk changed on disk; refresh the diff and try again".to_string());
    }

    let mut patch = String::new();
    patch.extend(header);
    patch.extend(current_hunk);
    if !patch.ends_with('\n') {
        patch.push('\n');
    }
    Ok(patch)
}

#[derive(Clone)]
struct PatchLine {
    raw: String,
    kind: &'static str,
    old_no: Option<u32>,
    new_no: Option<u32>,
    content: String,
    marker_after: Option<String>,
}

fn extract_single_line_patch(
    diff: &str,
    hunk_index: usize,
    line_index: usize,
    expected_kind: &str,
    expected_content: &str,
    expected_old_no: Option<u32>,
    expected_new_no: Option<u32>,
) -> Result<String, String> {
    let (file_header, hunk_header, raw_lines) = find_hunk(diff, hunk_index)?;
    let lines = parse_hunk_lines(&hunk_header, &raw_lines)?;
    let Some(selected) = lines.get(line_index) else {
        return Err("That line is no longer available; refresh the diff and try again".to_string());
    };
    if selected.kind == "ctx" {
        return Err("Context lines cannot be staged on their own".to_string());
    }
    if selected.kind != expected_kind
        || selected.content != expected_content
        || selected.old_no != expected_old_no
        || selected.new_no != expected_new_no
    {
        return Err("That line changed on disk; refresh the diff and try again".to_string());
    }

    let (old_start, new_start, old_count, new_count) =
        single_line_range(&lines, line_index, &hunk_header)?;
    let mut patch = String::new();
    patch.extend(file_header);
    patch.push_str(&format!(
        "@@ -{old_start},{old_count} +{new_start},{new_count} @@\n"
    ));
    patch.push_str(&selected.raw);
    if let Some(marker) = &selected.marker_after {
        patch.push_str(marker);
    }
    if !patch.ends_with('\n') {
        patch.push('\n');
    }
    Ok(patch)
}

fn find_hunk(diff: &str, hunk_index: usize) -> Result<(Vec<&str>, String, Vec<String>), String> {
    if diff.trim().is_empty() {
        return Err("No patch is available for this file".to_string());
    }

    let mut file_header = Vec::new();
    let mut hunk_header = String::new();
    let mut raw_lines = Vec::new();
    let mut current_index = None;

    for line in diff.split_inclusive('\n') {
        if line.starts_with("diff --git ") && (!file_header.is_empty() || current_index.is_some()) {
            break;
        }

        if line.starts_with("@@ ") {
            if current_index == Some(hunk_index) {
                break;
            }
            current_index = Some(current_index.map_or(0, |idx| idx + 1));
            hunk_header = line.trim_end_matches(['\r', '\n']).to_string();
            raw_lines.clear();
            continue;
        }

        if current_index.is_some() {
            raw_lines.push(line.to_string());
        } else {
            file_header.push(line);
        }
    }

    match current_index {
        Some(index) if index == hunk_index => Ok((file_header, hunk_header, raw_lines)),
        Some(_) => {
            Err("That hunk is no longer available; refresh the diff and try again".to_string())
        }
        None => Err("Patch-level staging is unavailable for this file".to_string()),
    }
}

fn parse_hunk_lines(header: &str, raw_lines: &[String]) -> Result<Vec<PatchLine>, String> {
    let (mut old_no, mut new_no) = parse_hunk_starts(header)?;
    let mut lines = Vec::new();

    let mut index = 0;
    while index < raw_lines.len() {
        let raw = &raw_lines[index];
        if raw.starts_with('\\') || raw.is_empty() {
            index += 1;
            continue;
        }
        let (prefix, content) = raw.split_at(1);
        let content = content.trim_end_matches(['\r', '\n']).to_string();
        let marker_after = raw_lines
            .get(index + 1)
            .filter(|line| line.starts_with('\\'))
            .cloned();
        match prefix {
            " " => {
                lines.push(PatchLine {
                    raw: raw.clone(),
                    kind: "ctx",
                    old_no: Some(old_no),
                    new_no: Some(new_no),
                    content,
                    marker_after,
                });
                old_no += 1;
                new_no += 1;
            }
            "-" => {
                lines.push(PatchLine {
                    raw: raw.clone(),
                    kind: "del",
                    old_no: Some(old_no),
                    new_no: None,
                    content,
                    marker_after,
                });
                old_no += 1;
            }
            "+" => {
                lines.push(PatchLine {
                    raw: raw.clone(),
                    kind: "add",
                    old_no: None,
                    new_no: Some(new_no),
                    content,
                    marker_after,
                });
                new_no += 1;
            }
            _ => {}
        }
        index += 1;
    }

    Ok(lines)
}

fn hunk_range(header: &str) -> &str {
    header
        .strip_prefix("@@ ")
        .and_then(|rest| rest.find(" @@").map(|end| &header[..end + 6]))
        .unwrap_or(header)
}

fn single_line_range(
    lines: &[PatchLine],
    line_index: usize,
    hunk_header: &str,
) -> Result<(u32, u32, usize, usize), String> {
    let (hunk_old_start, hunk_new_start) = parse_hunk_starts(hunk_header)?;
    let selected = &lines[line_index];
    match selected.kind {
        "add" => {
            let old_start = previous_old_no(lines, line_index)
                .unwrap_or_else(|| hunk_old_start.saturating_sub(1));
            Ok((old_start, selected.new_no.unwrap_or(hunk_new_start), 0, 1))
        }
        "del" => {
            let new_start = previous_new_no(lines, line_index)
                .unwrap_or_else(|| hunk_new_start.saturating_sub(1));
            Ok((selected.old_no.unwrap_or(hunk_old_start), new_start, 1, 0))
        }
        _ => Err("Context lines cannot be staged on their own".to_string()),
    }
}

fn parse_hunk_starts(header: &str) -> Result<(u32, u32), String> {
    let Some(rest) = header.strip_prefix("@@ -") else {
        return Err("Could not parse hunk header".to_string());
    };
    let Some((old_spec, rest)) = rest.split_once(" +") else {
        return Err("Could not parse hunk header".to_string());
    };
    let Some((new_spec, _)) = rest.split_once(" @@") else {
        return Err("Could not parse hunk header".to_string());
    };
    Ok((parse_range_start(old_spec)?, parse_range_start(new_spec)?))
}

fn parse_range_start(spec: &str) -> Result<u32, String> {
    spec.split(',')
        .next()
        .and_then(|value| value.parse::<u32>().ok())
        .ok_or_else(|| "Could not parse hunk range".to_string())
}

fn previous_old_no(lines: &[PatchLine], start: usize) -> Option<u32> {
    lines[..start].iter().rev().find_map(|line| line.old_no)
}

fn previous_new_no(lines: &[PatchLine], start: usize) -> Option<u32> {
    lines[..start].iter().rev().find_map(|line| line.new_no)
}

/// Unstage several files in one atomic invocation (`git restore --staged -- A B…`)
/// so a partial failure can't leave some of the set staged. Paths follow `--`, so
/// a dash-prefixed path cannot be parsed as a flag.
pub fn unstage_files(repo: &str, files: &[String]) -> Result<String, String> {
    if files.is_empty() {
        return Ok(String::new());
    }
    let mut args: Vec<&str> = vec!["restore", "--staged", "--"];
    args.extend(files.iter().map(String::as_str));
    run_git(repo, &args)
}

/// Discard a single file's working-tree changes, reverting it to its HEAD/index
/// state. When `staged` is set the file is unstaged first, then its worktree
/// copy is restored — so "discard" works whether the change is staged or not.
///
/// Whether the file exists in HEAD decides how it's discarded: a file present in
/// HEAD is restored from it; a *new* file (untracked, or staged but never
/// committed — and every file in an unborn repo) has nothing to restore *to*, so
/// its worktree copy is removed with `git clean` instead. This branch is decided
/// up front from `cat-file`, rather than by catching a `git restore` error — so a
/// genuine restore failure on a committed file (a lock, a permission error)
/// surfaces as an error instead of being silently swallowed by the clean
/// fallback and reported as success.
pub fn discard_file(repo: &str, file: &str, staged: bool) -> Result<String, String> {
    // `cat-file -e HEAD:<path>` exits 0 only when the path resolves in HEAD; it
    // fails for a new path and for an unborn repo (no HEAD at all).
    let in_head = run_git(repo, &["cat-file", "-e", &format!("HEAD:{file}")]).is_ok();

    if staged {
        run_git(repo, &["restore", "--staged", "--", file])?;
    }

    if in_head {
        run_git(repo, &["restore", "--worktree", "--", file])?;
        Ok(format!("Discarded changes in {file}"))
    } else {
        // New file: remove the worktree copy (and any untracked dir it created).
        run_git(repo, &["clean", "-f", "-d", "--", file])?;
        Ok(format!("Discarded {file}"))
    }
}

/// Stage every change in the working tree.
pub fn stage_all(repo: &str) -> Result<String, String> {
    run_git(repo, &["add", "-A"])
}

/// Unstage everything, resetting the index to HEAD.
pub fn unstage_all(repo: &str) -> Result<String, String> {
    run_git(repo, &["reset", "-q", "HEAD"])
}

/// Create a commit. `description` (when non-empty) becomes a second message
/// paragraph; `amend` rewrites the previous commit instead.
///
/// When `name`/`email` are given they are pinned via `-c user.name`/
/// `-c user.email`, which sets **both author and committer** for this one
/// invocation — so a GitLane commit always uses the repo's bound identity
/// regardless of what global/local git config (or another tool) has set.
pub fn commit(
    repo: &str,
    summary: &str,
    description: &str,
    amend: bool,
    name: Option<&str>,
    email: Option<&str>,
) -> Result<String, String> {
    let mut args: Vec<String> = Vec::new();
    if let (Some(n), Some(e)) = (name, email) {
        if !n.is_empty() && !e.is_empty() {
            args.push("-c".into());
            args.push(format!("user.name={n}"));
            args.push("-c".into());
            args.push(format!("user.email={e}"));
        }
    }
    args.push("commit".into());
    if amend {
        args.push("--amend".into());
    }
    args.push("-m".into());
    args.push(summary.into());
    if !description.is_empty() {
        args.push("-m".into());
        args.push(description.into());
    }
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run_git(repo, &arg_refs)
}

/// Discard *all* uncommitted changes: reset tracked files to HEAD and remove
/// untracked files/directories (`git reset --hard HEAD` + `git clean -fd`).
/// Irreversible — the frontend gates this behind a confirmation.
///
/// An unborn repo (no HEAD yet) has no commit to reset to, but staged "added"
/// files are tracked in the *index*, so `git clean` alone would leave them
/// behind. Empty the index first (`git read-tree --empty`) so those files become
/// untracked and get cleaned with everything else.
pub fn discard_all(repo: &str) -> Result<String, String> {
    let has_head = run_git(repo, &["rev-parse", "--verify", "--quiet", "HEAD"]).is_ok();
    if has_head {
        run_git(repo, &["reset", "--hard", "HEAD"])?;
    } else {
        run_git(repo, &["read-tree", "--empty"])?;
    }
    run_git(repo, &["clean", "-f", "-d"])?;
    Ok("Discarded all changes".to_string())
}
