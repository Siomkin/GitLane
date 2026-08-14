//! Extract a single-hunk or single-line patch from a unified diff.

pub(super) fn extract_single_hunk_patch(
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

pub(super) fn extract_single_line_patch(
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
