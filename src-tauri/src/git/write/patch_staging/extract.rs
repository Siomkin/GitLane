//! Extract a single-hunk or single-line patch from a unified diff.
//!
//! Everything here works on **bytes**. A patch is file content, so it can hold
//! any byte sequence — a Latin-1 byte, a lone CR at end of line — and a lossy
//! UTF-8 round trip would stage a replacement character or drop the CR without
//! failing. The guards that compare against what the UI displayed still work on
//! text, because the frontend receives the diff through the same lossy
//! conversion: decoding only for the comparison keeps those checks identical
//! while the emitted patch stays faithful.

/// Strip a line's trailing EOL bytes, in either encoding.
fn trim_eol(line: &[u8]) -> &[u8] {
    let mut end = line.len();
    while end > 0 && matches!(line[end - 1], b'\n' | b'\r') {
        end -= 1;
    }
    &line[..end]
}

/// A line as the UI displayed it: lossy, EOL-stripped.
fn displayed(line: &[u8]) -> String {
    String::from_utf8_lossy(trim_eol(line)).into_owned()
}

pub(super) fn extract_single_hunk_patch(
    diff: &[u8],
    hunk_index: usize,
    expected_header: &str,
    expected_body: &str,
) -> Result<Vec<u8>, String> {
    if trim_eol(diff).is_empty() {
        return Err("No patch is available for this file".to_string());
    }

    let mut header: Vec<&[u8]> = Vec::new();
    let mut current_hunk: Vec<&[u8]> = Vec::new();
    let mut current_index = None;

    for line in diff.split_inclusive(|byte| *byte == b'\n') {
        if line.starts_with(b"diff --git ") && (!header.is_empty() || current_index.is_some()) {
            break;
        }

        if line.starts_with(b"@@ ") {
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
        .map(|line| displayed(line))
        .unwrap_or_default();
    if hunk_range(&actual_header) != hunk_range(expected_header) {
        return Err("That hunk changed on disk; refresh the diff and try again".to_string());
    }

    // The @@ range alone can match while the body changed on disk (e.g. an edit
    // landed during the watcher debounce). Compare the body the UI displayed —
    // one `{sign}{content}` line per row (markers and trailing EOLs stripped),
    // matching the frontend's `hunkBody`.
    let actual_body = current_hunk
        .iter()
        .skip(1)
        .filter(|line| !line.starts_with(b"\\"))
        .map(|line| displayed(line))
        .collect::<Vec<_>>()
        .join("\n");
    if actual_body != expected_body {
        return Err("That hunk changed on disk; refresh the diff and try again".to_string());
    }

    let mut patch: Vec<u8> = Vec::new();
    for line in header.into_iter().filter(|line| !is_mode_change_line(line)) {
        patch.extend_from_slice(line);
    }
    for line in current_hunk {
        patch.extend_from_slice(line);
    }
    if !patch.ends_with(b"\n") {
        patch.push(b'\n');
    }
    Ok(patch)
}

/// A file-header `old mode`/`new mode` line. Stripped from partial (single-hunk
/// or single-line) patches: reusing the full header would also stage a chmod the
/// user never selected as part of the content action.
fn is_mode_change_line(line: &[u8]) -> bool {
    line.starts_with(b"old mode ") || line.starts_with(b"new mode ")
}

#[derive(Clone)]
struct PatchLine {
    raw: Vec<u8>,
    kind: &'static str,
    old_no: Option<u32>,
    new_no: Option<u32>,
    content: String,
    marker_after: Option<Vec<u8>>,
}

#[allow(clippy::too_many_arguments)]
pub(super) fn extract_single_line_patch(
    diff: &[u8],
    hunk_index: usize,
    line_index: usize,
    expected_kind: &str,
    expected_content: &str,
    expected_old_no: Option<u32>,
    expected_new_no: Option<u32>,
    reverse: bool,
) -> Result<Vec<u8>, String> {
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

    let mut patch: Vec<u8> = Vec::new();
    for line in file_header
        .into_iter()
        .filter(|line| !is_mode_change_line(line))
    {
        patch.extend_from_slice(line);
    }
    patch.extend_from_slice(&single_line_hunk(
        &lines,
        line_index,
        &hunk_header,
        reverse,
    )?);
    if !patch.ends_with(b"\n") {
        patch.push(b'\n');
    }
    Ok(patch)
}

type Hunk<'a> = (Vec<&'a [u8]>, String, Vec<Vec<u8>>);

fn find_hunk(diff: &[u8], hunk_index: usize) -> Result<Hunk<'_>, String> {
    if trim_eol(diff).is_empty() {
        return Err("No patch is available for this file".to_string());
    }

    let mut file_header: Vec<&[u8]> = Vec::new();
    let mut hunk_header = String::new();
    let mut raw_lines: Vec<Vec<u8>> = Vec::new();
    let mut current_index = None;

    for line in diff.split_inclusive(|byte| *byte == b'\n') {
        if line.starts_with(b"diff --git ") && (!file_header.is_empty() || current_index.is_some())
        {
            break;
        }

        if line.starts_with(b"@@ ") {
            if current_index == Some(hunk_index) {
                break;
            }
            current_index = Some(current_index.map_or(0, |idx| idx + 1));
            hunk_header = displayed(line);
            raw_lines.clear();
            continue;
        }

        if current_index.is_some() {
            raw_lines.push(line.to_vec());
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

fn parse_hunk_lines(header: &str, raw_lines: &[Vec<u8>]) -> Result<Vec<PatchLine>, String> {
    let (mut old_no, mut new_no) = parse_hunk_starts(header)?;
    let mut lines = Vec::new();

    let mut index = 0;
    while index < raw_lines.len() {
        let raw = &raw_lines[index];
        if raw.starts_with(b"\\") || raw.is_empty() {
            index += 1;
            continue;
        }
        let (kind, old, new) = match raw[0] {
            b' ' => ("ctx", Some(old_no), Some(new_no)),
            b'-' => ("del", Some(old_no), None),
            b'+' => ("add", None, Some(new_no)),
            _ => {
                index += 1;
                continue;
            }
        };
        if old.is_some() {
            old_no += 1;
        }
        if new.is_some() {
            new_no += 1;
        }
        lines.push(PatchLine {
            raw: raw.clone(),
            kind,
            old_no: old,
            new_no: new,
            content: displayed(&raw[1..]),
            marker_after: raw_lines
                .get(index + 1)
                .filter(|line| line.starts_with(b"\\"))
                .cloned(),
        });
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

/// Rebuild the hunk so that only the selected line changes.
///
/// `git apply` locates a fragment by matching its **preimage** against the file
/// it is patching, so the patch has to carry the hunk's real context. A
/// zero-context fragment has nothing to match and is placed by line number
/// alone — and the numbers in the displayed diff belong to a different image
/// than the one being patched, so any other pending change in the file moves
/// the result. Every line that exists in the preimage is therefore emitted,
/// with unselected changes on that side demoted to context; lines that exist
/// only in the postimage are dropped. This is the shape `git add -p` produces
/// when it splits a hunk.
///
/// Which side is the preimage depends on the direction: staging applies the
/// patch forward, so the preimage is the old side; unstaging applies it with
/// `--reverse`, so the preimage is the new side. Because that side is emitted
/// complete, the hunk's own start on it is still correct, and the counts are
/// recomputed from what was actually emitted.
fn single_line_hunk(
    lines: &[PatchLine],
    line_index: usize,
    hunk_header: &str,
    reverse: bool,
) -> Result<Vec<u8>, String> {
    if lines[line_index].kind == "ctx" {
        return Err("Context lines cannot be staged on their own".to_string());
    }
    let (old_start, new_start) = parse_hunk_starts(hunk_header)?;
    let mut body: Vec<u8> = Vec::new();
    let (mut old_count, mut new_count) = (0usize, 0usize);

    for (index, line) in lines.iter().enumerate() {
        let emitted = if index == line_index {
            line.kind
        } else if survives_in_preimage(line.kind, reverse) {
            "ctx"
        } else {
            continue;
        };

        match emitted {
            "add" => new_count += 1,
            "del" => old_count += 1,
            _ => {
                old_count += 1;
                new_count += 1;
            }
        }

        if emitted == line.kind {
            body.extend_from_slice(&line.raw);
        } else {
            // Same content, context marker: the change is kept out of the patch
            // without removing the line git needs in order to anchor.
            body.push(b' ');
            body.extend_from_slice(&line.raw[1..]);
        }
        if !body.ends_with(b"\n") {
            body.push(b'\n');
        }
        if let Some(marker) = &line.marker_after {
            body.extend_from_slice(marker);
        }
    }

    let mut hunk =
        format!("@@ -{old_start},{old_count} +{new_start},{new_count} @@\n").into_bytes();
    hunk.extend_from_slice(&body);
    Ok(hunk)
}

/// Whether a line of `kind` is present in the image `git apply` matches
/// against: the old side when applying forward, the new side under `--reverse`.
fn survives_in_preimage(kind: &str, reverse: bool) -> bool {
    match kind {
        "del" => !reverse,
        "add" => reverse,
        _ => true,
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
