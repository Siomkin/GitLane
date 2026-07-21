//! Working-tree staging, discard, and commit writes.

use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use git2::{Status, StatusOptions};
use sha2::{Digest, Sha256};

#[cfg(unix)]
use std::os::unix::ffi::OsStrExt;
#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;

use crate::git::types::DiscardFilePreview;
use crate::git::worktree_fs::{
    fingerprint_worktree_leaf, validate_worktree_leaf_observation, WorktreeLeafFingerprint,
    WorktreeLeafObservation,
};

use super::cli::{run_git, run_git_literal_paths, run_git_with_input};

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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum IndexPathState {
    Missing,
    IntentToAdd,
    Present,
}

struct DiscardSnapshot {
    expected_state: String,
    workdir: PathBuf,
    in_head: bool,
    index_state: IndexPathState,
}

struct DiscardSemanticSnapshot {
    signature: [u8; 32],
    workdir: PathBuf,
    in_head: bool,
    index_state: IndexPathState,
}

#[cfg(test)]
std::thread_local! {
    static DISCARD_CAPTURE_TEST_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
}

/// Deterministically mutate a fixture after the expensive content pass but
/// before the fresh semantic/leaf checks. Thread-local state prevents parallel
/// tests for unrelated repositories from consuming the hook.
#[cfg(test)]
pub(crate) fn set_discard_capture_test_hook(hook: impl FnOnce() + 'static) {
    DISCARD_CAPTURE_TEST_HOOK.with(|slot| {
        assert!(slot.borrow_mut().replace(Box::new(hook)).is_none());
    });
}

#[cfg(test)]
fn run_discard_capture_test_hook() {
    DISCARD_CAPTURE_TEST_HOOK.with(|slot| {
        if let Some(hook) = slot.borrow_mut().take() {
            hook();
        }
    });
}

#[cfg(not(test))]
fn run_discard_capture_test_hook() {}

fn hash_field(state: &mut Sha256, bytes: &[u8]) {
    state.update((bytes.len() as u64).to_le_bytes());
    state.update(bytes);
}

#[cfg(unix)]
fn hash_filesystem_path(state: &mut Sha256, path: &Path) {
    hash_field(state, path.as_os_str().as_bytes());
}

#[cfg(windows)]
fn hash_filesystem_path(state: &mut Sha256, path: &Path) {
    let bytes: Vec<u8> = path
        .as_os_str()
        .encode_wide()
        .flat_map(u16::to_le_bytes)
        .collect();
    hash_field(state, &bytes);
}

#[cfg(not(any(unix, windows)))]
fn hash_filesystem_path(state: &mut Sha256, path: &Path) {
    hash_field(state, path.to_string_lossy().as_bytes());
}

fn hash_index_entry(state: &mut Sha256, entry: Option<git2::IndexEntry>, stage: i32) {
    state.update([stage as u8]);
    let Some(entry) = entry else {
        state.update([0]);
        return;
    };
    state.update([1]);
    state.update(entry.id.as_bytes());
    state.update(entry.mode.to_le_bytes());
    state.update(entry.flags.to_le_bytes());
    state.update(entry.flags_extended.to_le_bytes());
}

fn index_path_state(index: &git2::Index, file: &str) -> IndexPathState {
    let Some(entry) = index.get_path(Path::new(file), 0) else {
        return IndexPathState::Missing;
    };
    let flags = git2::IndexEntryExtendedFlag::from_bits_truncate(entry.flags_extended);
    if entry.id.is_zero() || flags.contains(git2::IndexEntryExtendedFlag::INTENT_TO_ADD) {
        IndexPathState::IntentToAdd
    } else {
        IndexPathState::Present
    }
}

fn status_mentions(entry: &git2::StatusEntry<'_>, file: &str) -> bool {
    entry.path().ok() == Some(file)
        || entry.head_to_index().is_some_and(|delta| {
            delta.old_file().path() == Some(Path::new(file))
                || delta.new_file().path() == Some(Path::new(file))
        })
        || entry.index_to_workdir().is_some_and(|delta| {
            delta.old_file().path() == Some(Path::new(file))
                || delta.new_file().path() == Some(Path::new(file))
        })
}

fn source_entry_matches(
    entry: &git2::StatusEntry<'_>,
    index: &git2::Index,
    file: &str,
    previous_file: Option<&str>,
    staged: bool,
) -> bool {
    let status = entry.status();
    let entry_path = entry.path().ok().unwrap_or_default();
    let intent_to_add = index_path_state(index, entry_path) == IndexPathState::IntentToAdd;
    let source_present = if staged {
        !intent_to_add
            && status.intersects(
                Status::INDEX_NEW
                    | Status::INDEX_MODIFIED
                    | Status::INDEX_DELETED
                    | Status::INDEX_RENAMED
                    | Status::INDEX_TYPECHANGE,
            )
    } else {
        intent_to_add
            || status.intersects(
                Status::WT_NEW
                    | Status::WT_MODIFIED
                    | Status::WT_DELETED
                    | Status::WT_RENAMED
                    | Status::WT_TYPECHANGE,
            )
    };
    if !source_present {
        return false;
    }

    let is_rename = if staged {
        status.contains(Status::INDEX_RENAMED)
    } else {
        status.contains(Status::WT_RENAMED)
    };
    let delta = if staged {
        entry.head_to_index()
    } else {
        entry.index_to_workdir()
    };
    let target = delta
        .as_ref()
        .and_then(|delta| delta.new_file().path().or_else(|| delta.old_file().path()))
        .or_else(|| entry.path().ok().map(Path::new));
    if target != Some(Path::new(file)) {
        return false;
    }

    match previous_file {
        Some(previous) => {
            is_rename
                && delta.as_ref().and_then(|delta| delta.old_file().path())
                    == Some(Path::new(previous))
        }
        None => !is_rename,
    }
}

fn staged_change_has_external_worktree_rename(
    statuses: &git2::Statuses<'_>,
    file: &str,
    previous_file: Option<&str>,
) -> bool {
    let is_operand = |path: Option<&Path>| {
        path.is_some_and(|path| {
            path == Path::new(file)
                || previous_file.is_some_and(|previous| path == Path::new(previous))
        })
    };
    statuses.iter().any(|entry| {
        if !entry.status().contains(Status::WT_RENAMED) {
            return false;
        }
        let Some(delta) = entry.index_to_workdir() else {
            return false;
        };
        let old_inside = is_operand(delta.old_file().path());
        let new_inside = is_operand(delta.new_file().path());
        old_inside != new_inside
    })
}

fn hash_semantic_path_state(
    state: &mut Sha256,
    head: Option<&git2::Tree<'_>>,
    index: &git2::Index,
    file: &str,
) {
    hash_field(state, file.as_bytes());

    match head.and_then(|tree| tree.get_path(Path::new(file)).ok()) {
        Some(entry) => {
            state.update([1]);
            state.update(entry.id().as_bytes());
            state.update(entry.filemode_raw().to_le_bytes());
        }
        None => state.update([0]),
    }

    for stage in 0..=3 {
        hash_index_entry(state, index.get_path(Path::new(file), stage), stage);
    }
}

fn hash_diff_file(state: &mut Sha256, file: git2::DiffFile<'_>) {
    state.update(file.id().as_bytes());
    state.update(i32::from(file.mode()).to_le_bytes());
    state.update(file.size().to_le_bytes());
    state.update([u8::from(file.exists()), u8::from(file.is_valid_id())]);
    match file.path_bytes() {
        Some(path) => {
            state.update([1]);
            hash_field(state, path);
        }
        None => state.update([0]),
    }
}

fn hash_diff_delta(state: &mut Sha256, delta: Option<git2::DiffDelta<'_>>) {
    let Some(delta) = delta else {
        state.update([0]);
        return;
    };
    state.update([1, delta.status() as u8]);
    state.update(delta.nfiles().to_le_bytes());
    hash_diff_file(state, delta.old_file());
    hash_diff_file(state, delta.new_file());
}

fn hash_status_entry(state: &mut Sha256, entry: &git2::StatusEntry<'_>) {
    state.update(entry.status().bits().to_le_bytes());
    hash_field(state, entry.path_bytes());
    hash_diff_delta(state, entry.head_to_index());
    hash_diff_delta(state, entry.index_to_workdir());
}

fn capture_discard_semantics(
    repo: &str,
    file: &str,
    previous_file: Option<&str>,
    staged: bool,
) -> Result<DiscardSemanticSnapshot, String> {
    let repository = git2::Repository::discover(repo)
        .map_err(|error| format!("Could not inspect {file} before discarding it: {error}"))?;
    let workdir = repository
        .workdir()
        .ok_or_else(|| "Cannot discard a file in a bare repository".to_string())?;
    let index = repository.index().map_err(|error| {
        format!("Could not inspect the index before discarding {file}: {error}")
    })?;

    let mut options = StatusOptions::new();
    options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .renames_head_to_index(true)
        .renames_index_to_workdir(true);
    let statuses = repository
        .statuses(Some(&mut options))
        .map_err(|error| format!("Could not inspect {file} before discarding it: {error}"))?;

    let involved = previous_file.into_iter().chain(std::iter::once(file));
    for path in involved.clone() {
        let conflicted = (1..=3).any(|stage| index.get_path(Path::new(path), stage).is_some())
            || statuses.iter().any(|entry| {
                entry.status().contains(Status::CONFLICTED) && status_mentions(&entry, path)
            });
        if conflicted {
            return Err(format!(
                "{path} is conflicted. Resolve or abort the operation before discarding this file."
            ));
        }
    }

    if staged && staged_change_has_external_worktree_rename(&statuses, file, previous_file) {
        return Err(format!(
            "The staged change for {file} has an unstaged rename outside this row. Discard the unstaged rename first, then retry the staged change."
        ));
    }

    let source_exists = statuses
        .iter()
        .any(|entry| source_entry_matches(&entry, &index, file, previous_file, staged));
    if !source_exists {
        return Err(format!(
            "The {} change for {file} is no longer available. Refresh and try again.",
            if staged { "staged" } else { "unstaged" }
        ));
    }

    let head = repository
        .head()
        .ok()
        .and_then(|head| head.peel_to_commit().ok())
        .and_then(|commit| commit.tree().ok());
    let in_head = head
        .as_ref()
        .and_then(|tree| tree.get_path(Path::new(file)).ok())
        .is_some();
    let index_state = index_path_state(&index, file);

    let mut state = Sha256::new();
    hash_field(&mut state, b"gitlane-discard-semantics-v1");
    // Keep repository/worktree ownership in the signature even when two
    // worktrees happen to contain byte-identical path state.
    hash_filesystem_path(&mut state, repository.path());
    hash_filesystem_path(&mut state, workdir);
    state.update([u8::from(staged)]);
    match previous_file {
        Some(previous) => {
            state.update([1]);
            hash_semantic_path_state(&mut state, head.as_ref(), &index, previous);
        }
        None => state.update([0]),
    }
    hash_semantic_path_state(&mut state, head.as_ref(), &index, file);

    let relevant_count = statuses
        .iter()
        .filter(|entry| involved.clone().any(|path| status_mentions(entry, path)))
        .count() as u64;
    state.update(relevant_count.to_le_bytes());
    for entry in statuses
        .iter()
        .filter(|entry| involved.clone().any(|path| status_mentions(entry, path)))
    {
        hash_status_entry(&mut state, &entry);
    }

    Ok(DiscardSemanticSnapshot {
        signature: state.finalize().into(),
        workdir: workdir.to_path_buf(),
        in_head,
        index_state,
    })
}

fn hash_worktree_fingerprint(
    state: &mut Sha256,
    fingerprint: WorktreeLeafFingerprint,
    file: &str,
) -> Result<(), String> {
    match fingerprint {
        WorktreeLeafFingerprint::Missing => state.update([0]),
        WorktreeLeafFingerprint::Regular { len, mode, digest } => {
            state.update([1]);
            state.update(len.to_le_bytes());
            state.update(mode.to_le_bytes());
            state.update(digest);
        }
        WorktreeLeafFingerprint::Symlink { mode, target } => {
            state.update([2]);
            state.update(mode.to_le_bytes());
            hash_field(state, &target);
        }
        WorktreeLeafFingerprint::Other { .. } => {
            return Err(format!(
                "Refusing to discard non-file worktree path {file}. Use the terminal for this repository state."
            ));
        }
    }
    Ok(())
}

fn capture_discard_snapshot(
    repo: &str,
    file: &str,
    previous_file: Option<&str>,
    staged: bool,
) -> Result<DiscardSnapshot, String> {
    let previous_file = previous_file.filter(|previous| *previous != file);
    let initial = capture_discard_semantics(repo, file, previous_file, staged)?;

    let mut state = Sha256::new();
    hash_field(&mut state, b"gitlane-discard-v1");
    hash_field(&mut state, &initial.signature);
    let involved = previous_file.into_iter().chain(std::iter::once(file));
    let mut observations: Vec<(&str, WorktreeLeafObservation)> = Vec::new();
    for path in involved.clone() {
        hash_field(&mut state, path.as_bytes());
        let (fingerprint, observation) = fingerprint_worktree_leaf(&initial.workdir, path)
            .map_err(|error| format!("Could not inspect {path} before discarding it: {error}"))?;
        hash_worktree_fingerprint(&mut state, fingerprint, path)?;
        observations.push((path, observation));
    }

    run_discard_capture_test_hook();

    // Status/index/HEAD may change while a large worktree file is streamed.
    // Recompute their path-local semantic signature after content capture, and
    // use this fresh capture for the mutation branch as well as the token.
    let fresh = capture_discard_semantics(repo, file, previous_file, staged)?;
    if fresh.signature != initial.signature {
        return Err(format!(
            "Changes to {file} changed while GitLane was inspecting them. Refresh and try again."
        ));
    }

    // Recheck every pathname only after all slow work. A rename's first path
    // therefore cannot change unnoticed while the second path is being hashed.
    for (path, observation) in &observations {
        let unchanged = validate_worktree_leaf_observation(&fresh.workdir, path, observation)
            .map_err(|error| format!("Could not recheck {path} before discarding it: {error}"))?;
        if !unchanged {
            return Err(format!(
                "Changes to {file} changed while GitLane was inspecting them. Refresh and try again."
            ));
        }
    }

    Ok(DiscardSnapshot {
        expected_state: format!("v1:{}", URL_SAFE_NO_PAD.encode(state.finalize())),
        workdir: fresh.workdir,
        in_head: fresh.in_head,
        index_state: fresh.index_state,
    })
}

/// Capture the exact path-local HEAD/index/worktree state that a destructive
/// per-file confirmation is asking the user to approve.
pub fn preview_discard_file(
    repo: &str,
    file: &str,
    previous_file: Option<&str>,
    staged: bool,
) -> Result<DiscardFilePreview, String> {
    let previous_file = previous_file.filter(|previous| *previous != file);
    let snapshot = capture_discard_snapshot(repo, file, previous_file, staged)?;
    let summary = match previous_file {
        Some(previous) => format!("Discard rename {previous} → {file}"),
        None if staged => format!("Unstage and discard changes in {file}"),
        None => format!("Discard unstaged changes in {file}"),
    };
    let detail = if previous_file.is_some() {
        if staged {
            "Both rename paths in the index and worktree will be restored from HEAD.".to_string()
        } else {
            "The index version at the old path will be preserved.".to_string()
        }
    } else if staged && snapshot.in_head {
        "Both the index and worktree copy will be restored from HEAD.".to_string()
    } else if staged {
        "The staged-new file will be removed from both the index and worktree.".to_string()
    } else {
        match snapshot.index_state {
            IndexPathState::Present => {
                "The staged/index version will be preserved in both the index and worktree."
                    .to_string()
            }
            IndexPathState::IntentToAdd => {
                "The intent-to-add entry and its worktree file will be removed.".to_string()
            }
            IndexPathState::Missing => "The untracked worktree file will be removed.".to_string(),
        }
    };
    Ok(DiscardFilePreview {
        summary,
        details: vec![detail],
        warnings: vec!["These file changes cannot be recovered by GitLane.".to_string()],
        expected_state: snapshot.expected_state,
    })
}

/// Discard exactly the file state captured by [`preview_discard_file`]. A change
/// to either involved worktree path, its index entries, or its HEAD tree entry
/// fails closed before spawning Git. Unstaged discards restore from the index
/// even for a staged-new file, preserving its staged blob; staged discards
/// restore/remove both index and worktree sides.
pub fn discard_file(
    repo: &str,
    file: &str,
    previous_file: Option<&str>,
    staged: bool,
    expected_state: &str,
) -> Result<String, String> {
    let previous_file = previous_file.filter(|previous| *previous != file);
    let snapshot = capture_discard_snapshot(repo, file, previous_file, staged).map_err(|_| {
        format!("Changes to {file} changed after the confirmation opened. Refresh and try again.")
    })?;
    if snapshot.expected_state != expected_state {
        return Err(format!(
            "Changes to {file} changed after the confirmation opened. Refresh and try again."
        ));
    }
    let command_repo = snapshot.workdir.to_str().ok_or_else(|| {
        "Cannot discard a file from a worktree path that is not valid UTF-8".to_string()
    })?;

    if let Some(previous) = previous_file {
        if staged {
            // Restore both index paths and the worktree in one command. Besides
            // avoiding partial index state, this is essential for case-only
            // renames: on a case-insensitive filesystem the two spellings name
            // one file, so restoring the old side and then removing the new side
            // would delete the file that was just restored.
            run_git_literal_paths(
                command_repo,
                &[
                    "restore",
                    "--source=HEAD",
                    "--staged",
                    "--worktree",
                    "--",
                    previous,
                    file,
                ],
            )?;
        } else {
            // An unstaged rename is index(old) → worktree(new). Remove the
            // untracked new side first, then restore the old side *from the
            // index*, preserving any staged content already recorded there.
            run_git_literal_paths(command_repo, &["clean", "-f", "--", file])?;
            run_git_literal_paths(command_repo, &["restore", "--worktree", "--", previous])?;
        }
        return Ok(format!("Discarded rename {previous} → {file}"));
    }

    if staged {
        if snapshot.in_head {
            run_git_literal_paths(
                command_repo,
                &[
                    "restore",
                    "--source=HEAD",
                    "--staged",
                    "--worktree",
                    "--",
                    file,
                ],
            )?;
            Ok(format!("Discarded changes in {file}"))
        } else {
            run_git_literal_paths(command_repo, &["rm", "-f", "-q", "--", file])?;
            Ok(format!("Discarded {file}"))
        }
    } else {
        match snapshot.index_state {
            IndexPathState::Present => {
                run_git_literal_paths(command_repo, &["restore", "--worktree", "--", file])?;
                Ok(format!("Discarded unstaged changes in {file}"))
            }
            IndexPathState::IntentToAdd => {
                run_git_literal_paths(command_repo, &["rm", "-f", "-q", "--", file])?;
                Ok(format!("Discarded {file}"))
            }
            IndexPathState::Missing => {
                run_git_literal_paths(command_repo, &["clean", "-f", "--", file])?;
                Ok(format!("Discarded {file}"))
            }
        }
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
