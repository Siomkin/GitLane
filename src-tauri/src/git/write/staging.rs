//! Working-tree staging, discard, and commit writes.

use std::ffi::{OsStr, OsString};
use std::path::Path;

#[cfg(unix)]
use std::os::unix::ffi::OsStringExt;

use super::cli::{
    run_git, run_git_literal_paths, run_git_os_paths, run_git_stdout_raw, run_git_with_input,
};

/// Stage one literal repository path (also stages deletions).
pub fn stage_file(repo: &str, file: &str) -> Result<String, String> {
    run_git_literal_paths(repo, &["add", "-A", "--", file])
}

/// True when HEAD resolves to a commit. False on an unborn HEAD (fresh
/// `git init`, no commits yet), where `restore --staged` / `reset HEAD` die
/// with `fatal: could not resolve 'HEAD'` — callers must fall back to
/// index-only commands there.
fn has_head(repo: &str) -> bool {
    run_git(repo, &["rev-parse", "--verify", "--quiet", "HEAD"]).is_ok()
}

/// Unstage a single file, restoring it to its HEAD state in the index. On an
/// unborn HEAD there is no HEAD state to restore, so the entry is dropped from
/// the index instead (`git rm --cached`), leaving the file untracked — `-f`
/// because losing the staged snapshot is exactly what unstage means, even when
/// the worktree copy has moved on.
pub fn unstage_file(repo: &str, file: &str) -> Result<String, String> {
    if has_head(repo) {
        run_git_literal_paths(repo, &["restore", "--staged", "--", file])
    } else {
        run_git_literal_paths(repo, &["rm", "--cached", "-f", "-q", "--", file])
    }
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
#[allow(clippy::too_many_arguments)] // Each value guards one displayed line field.
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
/// - `--literal-pathspecs` prevents a real filename containing glob/pathspec
///   syntax from selecting a different file's patch.
///
/// `extract_single_hunk_patch`/`extract_single_line_patch` additionally validate
/// the expected hunk range + body / line content before applying, so any residual
/// divergence fails safe ("refresh and try again") instead of staging the wrong hunk.
pub(super) fn patch_diff_args(staged: bool, file: &str) -> Vec<&str> {
    let mut args = vec![
        "--literal-pathspecs",
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
    patch.extend(
        header
            .into_iter()
            .filter(|&line| !is_mode_change_line(line)),
    );
    patch.extend(current_hunk);
    if !patch.ends_with('\n') {
        patch.push('\n');
    }
    Ok(patch)
}

/// A file-header `old mode`/`new mode` line. Stripped from partial (single-hunk
/// or single-line) patches: reusing the full header would also stage a chmod the
/// user never selected as part of the content action.
fn is_mode_change_line(line: &str) -> bool {
    line.starts_with("old mode ") || line.starts_with("new mode ")
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
    patch.extend(
        file_header
            .into_iter()
            .filter(|&line| !is_mode_change_line(line)),
    );
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

/// Stage several literal files in one atomic invocation (`git add -A -- A B…`,
/// also staging deletions) so a folder roll-up can't leave some of the set
/// unstaged. `--` blocks option parsing; literal mode also blocks pathspec magic.
pub fn stage_files(repo: &str, files: &[String]) -> Result<String, String> {
    if files.is_empty() {
        return Ok(String::new());
    }
    let mut args: Vec<&str> = vec!["add", "-A", "--"];
    args.extend(files.iter().map(String::as_str));
    run_git_literal_paths(repo, &args)
}

/// Unstage several literal files in one atomic invocation (`git restore --staged
/// -- A B…`) so a partial failure can't leave some of the set staged. `--`
/// blocks options and literal mode blocks pathspec expansion. Unborn HEAD falls
/// back to dropping the entries from the index, as in [`unstage_file`].
pub fn unstage_files(repo: &str, files: &[String]) -> Result<String, String> {
    if files.is_empty() {
        return Ok(String::new());
    }
    let mut args: Vec<&str> = if has_head(repo) {
        vec!["restore", "--staged", "--"]
    } else {
        vec!["rm", "--cached", "-f", "-q", "--"]
    };
    args.extend(files.iter().map(String::as_str));
    run_git_literal_paths(repo, &args)
}

/// Discard a single file's working-tree changes, reverting it to its HEAD/index
/// state. When `staged` is set the file is unstaged first, then its worktree
/// copy is restored — so "discard" works whether the change is staged or not.
///
/// Whether the file exists in HEAD decides how it's discarded: a file present in
/// HEAD is restored from it; a *new* file (untracked, or staged but never
/// committed — and every file in an unborn repo) has nothing to restore *to*, so
/// it is removed instead. This branch is decided up front from `cat-file`,
/// rather than by catching a `git restore` error — so a genuine restore failure
/// on a committed file (a lock, a permission error) surfaces as an error instead
/// of being silently swallowed by the removal fallback and reported as success.
///
/// For the new-file branch the *index* — not the caller's `staged` flag, which
/// can be stale — decides between `git rm -f` (staged-new: clears index and
/// worktree; `git clean` would silently skip a tracked file and report success)
/// and scoped `git clean -f` (genuinely untracked file). Skipping
/// `restore --staged` here also keeps the staged case working on an unborn HEAD.
pub fn discard_file(repo: &str, file: &str, staged: bool) -> Result<String, String> {
    // `cat-file -e HEAD:<path>` exits 0 only when the path resolves in HEAD; it
    // fails for a new path and for an unborn repo (no HEAD at all).
    let in_head = run_git(repo, &["cat-file", "-e", &format!("HEAD:{file}")]).is_ok();

    if in_head {
        if staged {
            run_git_literal_paths(repo, &["restore", "--staged", "--", file])?;
        }
        run_git_literal_paths(repo, &["restore", "--worktree", "--", file])?;
        Ok(format!("Discarded changes in {file}"))
    } else if run_git_literal_paths(repo, &["ls-files", "--error-unmatch", "--", file]).is_ok() {
        // Staged-new file: drop it from index and worktree in one step.
        run_git_literal_paths(repo, &["rm", "-f", "-q", "--", file])?;
        Ok(format!("Discarded {file}"))
    } else {
        // An explicit literal file path makes `-d` irrelevant; omit it so this
        // matches the file-only cleanup contract used by `discard_all`.
        run_git_literal_paths(repo, &["clean", "-f", "--", file])?;
        Ok(format!("Discarded {file}"))
    }
}

/// Stage every change in the working tree.
pub fn stage_all(repo: &str) -> Result<String, String> {
    run_git(repo, &["add", "-A"])
}

/// Unstage everything, resetting the index to HEAD. An unborn HEAD has no
/// commit to reset to, so the index is emptied instead (`git read-tree
/// --empty`), leaving every staged file untracked — the same guard
/// [`discard_all`] uses.
pub fn unstage_all(repo: &str) -> Result<String, String> {
    if has_head(repo) {
        run_git(repo, &["reset", "-q", "HEAD"])
    } else {
        run_git(repo, &["read-tree", "--empty"])
    }
}

/// Create a commit. `description` (when non-empty) becomes a second message
/// paragraph; `amend` rewrites the previous commit instead.
///
/// When `name`/`email` are given they are pinned via `-c user.name`/
/// `-c user.email`, which sets **both author and committer** for this one
/// invocation — so a GitLane commit always uses the repo's bound identity
/// regardless of what global/local git config (or another tool) has set.
#[cfg(test)]
#[allow(clippy::too_many_arguments)] // Test-only wrapper mirrors the guarded commit contract exactly.
pub fn commit(
    repo: &str,
    summary: &str,
    description: &str,
    amend: bool,
    name: Option<&str>,
    email: Option<&str>,
    identity: Option<&crate::git::types::RepoIdentity>,
    identity_captured: bool,
) -> Result<String, String> {
    let _identity_guard = super::identity::lock_identity_config(repo)?;
    commit_locked(
        repo,
        summary,
        description,
        amend,
        name,
        email,
        identity,
        identity_captured,
    )
}

#[allow(clippy::too_many_arguments)] // Internal half of the guarded IPC contract.
fn commit_locked(
    repo: &str,
    summary: &str,
    description: &str,
    amend: bool,
    name: Option<&str>,
    email: Option<&str>,
    identity: Option<&crate::git::types::RepoIdentity>,
    identity_captured: bool,
) -> Result<String, String> {
    // Guard an empty subject with a clear message instead of letting git fail
    // with its raw "Aborting commit due to empty commit message" — the commit
    // always carries an explicit `-m <summary>`, so an empty subject is a user
    // error, not an editor abort.
    if summary.trim().is_empty() {
        return Err("A commit message is required.".to_string());
    }
    let mut args: Vec<String> = Vec::new();
    let expected_author = match (name, email) {
        (Some(n), Some(e)) if !n.is_empty() && !e.is_empty() => Some((n, e)),
        _ => None,
    };
    if let Some((n, e)) = expected_author {
        args.push("-c".into());
        args.push(format!("user.name={n}"));
        args.push("-c".into());
        args.push(format!("user.email={e}"));
    }
    args.extend(super::identity::pinned_signing_args(
        repo,
        expected_author,
        identity,
        identity_captured,
        super::identity::SigningOperation::Commit,
    )?);
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

/// Commit only while HEAD still matches the branch/oid snapshot the composer
/// was opened against. This applies to ordinary commits and amend alike.
#[allow(clippy::too_many_arguments)] // Mirrors the guarded commit IPC contract.
pub fn commit_expected(
    repo: &str,
    expected_branch: Option<&str>,
    expected_oid: Option<&str>,
    summary: &str,
    description: &str,
    amend: bool,
    name: Option<&str>,
    email: Option<&str>,
    identity: Option<&crate::git::types::RepoIdentity>,
    identity_captured: bool,
) -> Result<String, String> {
    let _identity_guard = super::identity::lock_identity_config(repo)?;
    super::head::ensure_expected_head(repo, expected_branch, expected_oid)?;
    commit_locked(
        repo,
        summary,
        description,
        amend,
        name,
        email,
        identity,
        identity_captured,
    )
}

/// Replace the current tip range with one commit behind a single guarded IPC
/// contract. The rollback is attempted only while the same branch still owns
/// the soft-reset state, so an external checkout cannot make recovery reset a
/// different branch.
#[allow(clippy::too_many_arguments)] // Mirrors the guarded squash IPC contract.
pub fn squash_commits(
    repo: &str,
    expected_branch: Option<&str>,
    expected_oid: &str,
    parent_oid: &str,
    summary: &str,
    description: &str,
    name: Option<&str>,
    email: Option<&str>,
    identity: Option<&crate::git::types::RepoIdentity>,
    identity_captured: bool,
) -> Result<String, String> {
    let _identity_guard = super::identity::lock_identity_config(repo)?;
    super::head::ensure_expected_head(repo, expected_branch, Some(expected_oid))?;
    super::head::ensure_commit_exists(repo, parent_oid)?;
    super::branches::reset(repo, parent_oid, "soft")?;
    super::head::ensure_expected_head(repo, expected_branch, Some(parent_oid))?;
    match commit_locked(
        repo,
        summary,
        description,
        false,
        name,
        email,
        identity,
        identity_captured,
    ) {
        Ok(output) => Ok(output),
        Err(error) => {
            if super::head::ensure_expected_head(repo, expected_branch, Some(parent_oid)).is_ok() {
                let _ = super::branches::reset(repo, expected_oid, "soft");
            }
            Err(error)
        }
    }
}

fn bytes_to_os_string(bytes: &[u8]) -> Result<OsString, String> {
    #[cfg(unix)]
    {
        Ok(OsString::from_vec(bytes.to_vec()))
    }
    #[cfg(not(unix))]
    {
        String::from_utf8(bytes.to_vec())
            .map(OsString::from)
            .map_err(|_| {
                "Untracked cleanup cannot handle a repository path that is not valid UTF-8 on this platform".to_string()
            })
    }
}

fn parse_nul_delimited_paths(output: &[u8]) -> Result<Vec<OsString>, String> {
    output
        .split(|&byte| byte == 0)
        .filter(|path| !path.is_empty())
        .map(bytes_to_os_string)
        .collect()
}

fn path_arg_bytes(path: &OsString) -> usize {
    path.as_os_str().as_encoded_bytes().len()
}

/// Return untracked cleanup candidates Git reports as working-tree files.
/// Ordinary directory rollups are deliberately avoided. With explicit
/// pathspecs, `git clean` affects only matching untracked paths and `-d` is
/// irrelevant; the single `-f` also keeps nested Git repositories protected.
fn untracked_paths(repo: &str) -> Result<Vec<OsString>, String> {
    let output = run_git_stdout_raw(repo, &["ls-files", "--others", "--exclude-standard", "-z"])?;
    parse_nul_delimited_paths(&output)
}

// Stay comfortably below macOS's ARG_MAX and Windows' smaller command-line
// limit after accounting for fixed arguments. The count cap also keeps each
// cleanup invocation cheap when paths are very short.
#[cfg(not(windows))]
const CLEAN_PATH_BATCH_MAX_BYTES: usize = 64 * 1024;
#[cfg(windows)]
const CLEAN_PATH_BATCH_MAX_BYTES: usize = 24 * 1024;
pub(super) const CLEAN_PATH_BATCH_MAX_ARGS: usize = 500;

#[derive(Debug)]
struct UntrackedCleanup {
    removed_any: bool,
    preserved_nested_repos: Vec<OsString>,
}

fn is_nested_git_repository(repo: &str, path: &OsStr) -> bool {
    let candidate = Path::new(repo).join(path);
    std::fs::symlink_metadata(&candidate)
        .map(|metadata| metadata.file_type().is_dir())
        .unwrap_or(false)
        && candidate.join(".git").exists()
}

fn partition_untracked_paths(repo: &str, paths: Vec<OsString>) -> (Vec<OsString>, Vec<OsString>) {
    paths
        .into_iter()
        .partition(|path| !is_nested_git_repository(repo, path))
}

pub(super) fn nested_untracked_repo_labels(repo: &str) -> Result<Vec<String>, String> {
    let (_, nested_repos) = partition_untracked_paths(repo, untracked_paths(repo)?);
    Ok(nested_repos
        .into_iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect())
}

/// Remove only untracked paths Git reports, rather than letting an unscoped
/// `git clean -fd` also delete unrelated empty directories that never appear in
/// status or the discard preview.
fn clean_untracked_paths(repo: &str) -> Result<UntrackedCleanup, String> {
    let (paths, _) = partition_untracked_paths(repo, untracked_paths(repo)?);
    let removed_any = !paths.is_empty();

    let mut start = 0;
    while start < paths.len() {
        let mut end = start;
        let mut bytes = 0;
        while end < paths.len() && end - start < CLEAN_PATH_BATCH_MAX_ARGS {
            let next_bytes = path_arg_bytes(&paths[end]) + 1;
            if end > start && bytes + next_bytes > CLEAN_PATH_BATCH_MAX_BYTES {
                break;
            }
            bytes += next_bytes;
            end += 1;
        }

        // `--` stops option parsing but does not disable pathspec magic. Pin
        // literal semantics so a real filename such as `:(` cannot fail or
        // expand into a broader cleanup pattern. File pathspecs leave their
        // directory shells, while nested repositories remain protected because
        // Git requires a second `-f` to remove them.
        run_git_os_paths(
            repo,
            &["--literal-pathspecs", "clean", "-f", "--"],
            &paths[start..end],
        )
        .map_err(|error| {
            format!(
                "Untracked cleanup could not finish; some files may already have been removed: {error}"
            )
        })?;
        start = end;
    }

    // Verify only the paths this cleanup was asked to remove. Files created
    // concurrently (editor temp files, build artifacts, Finder's .DS_Store)
    // are not a cleanup failure and must not abort the discard.
    let (remaining, preserved_nested_repos) =
        partition_untracked_paths(repo, untracked_paths(repo)?);
    let requested: std::collections::HashSet<&OsString> = paths.iter().collect();
    if remaining.iter().any(|path| requested.contains(path)) {
        return Err("Untracked cleanup did not remove every reported path".to_string());
    }

    Ok(UntrackedCleanup {
        removed_any,
        preserved_nested_repos,
    })
}

fn discard_all_message(cleanup: &UntrackedCleanup) -> String {
    if cleanup.preserved_nested_repos.is_empty() {
        return "Discarded all changes".to_string();
    }
    let paths = cleanup
        .preserved_nested_repos
        .iter()
        .map(|path| path.to_string_lossy())
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "Discarded tracked and removable untracked changes; preserved nested Git repositories: {paths}"
    )
}

/// Discard *all* uncommitted changes: remove reported untracked paths and reset
/// tracked files to HEAD.
/// Irreversible — the frontend gates this behind a confirmation.
///
/// An unborn repo (no HEAD yet) has no commit to reset to, but staged "added"
/// files are tracked in the *index*. Empty the index first (`git read-tree
/// --empty`) so those files become untracked and can be cleaned through the
/// same explicitly-scoped path list.
pub fn discard_all(repo: &str) -> Result<String, String> {
    let cleanup = if has_head(repo) {
        // Clean first so a permission failure cannot discard tracked edits and
        // then report the overall operation as failed.
        let cleanup = clean_untracked_paths(repo)?;
        run_git(repo, &["reset", "--hard", "HEAD"]).map_err(|error| {
            if cleanup.removed_any {
                format!(
                    "Untracked cleanup completed, but tracked changes could not be reset: {error}"
                )
            } else if !cleanup.preserved_nested_repos.is_empty() {
                format!(
                    "Nested Git repositories were preserved, but tracked changes could not be reset: {error}"
                )
            } else {
                error
            }
        })?;
        cleanup
    } else {
        run_git(repo, &["read-tree", "--empty"])?;
        clean_untracked_paths(repo).map_err(|error| {
            format!("The index was cleared, but untracked cleanup could not finish: {error}")
        })?
    };
    Ok(discard_all_message(&cleanup))
}

#[cfg(test)]
mod untracked_path_tests {
    use super::parse_nul_delimited_paths;
    #[cfg(unix)]
    use std::os::unix::ffi::OsStrExt;

    #[test]
    #[cfg(unix)]
    fn parse_nul_delimited_paths_preserves_non_utf8_bytes() {
        let raw = b"good.txt\0untracked\xff.txt\0";
        let paths = parse_nul_delimited_paths(raw).expect("parse");
        assert_eq!(paths.len(), 2);
        assert_eq!(paths[0].as_os_str().as_bytes(), b"good.txt");
        assert_eq!(paths[1].as_os_str().as_bytes(), b"untracked\xff.txt");
    }
}
