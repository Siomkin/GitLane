//! Reading the working tree's status for the lease: the porcelain-v1 parse the
//! capture builds its tracked view from, and the NUL-delimited untracked
//! enumeration the cleanup set comes from.

use std::collections::BTreeSet;
use std::ffi::OsString;

use super::super::state_lease::RepositoryScope;
use super::{git_path, run_scoped_git_stdout_raw, ParsedStatus, StatusDisplay};

pub(super) fn read_status(scope: &RepositoryScope) -> Result<ParsedStatus, String> {
    let raw = run_scoped_git_stdout_raw(
        scope,
        &[
            "-c",
            "core.fsmonitor=false",
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--ignore-submodules=none",
        ],
    )?;
    let mut semantic_records = Vec::new();
    let mut tracked_paths = BTreeSet::new();
    let mut display = Vec::new();
    let mut cursor = 0usize;
    while cursor < raw.len() {
        let end = raw[cursor..]
            .iter()
            .position(|byte| *byte == 0)
            .map(|offset| cursor + offset)
            .ok_or_else(|| "Git returned a malformed status record.".to_string())?;
        let record = &raw[cursor..end];
        cursor = end + 1;
        if record.is_empty() {
            continue;
        }
        if record.len() < 4 || record[2] != b' ' {
            return Err("Git returned a malformed status record.".to_string());
        }
        let code = &record[..2];
        let path = record[3..].to_vec();
        let rename = code.iter().any(|byte| matches!(*byte, b'R' | b'C'));
        let second = if rename {
            let second_end = raw[cursor..]
                .iter()
                .position(|byte| *byte == 0)
                .map(|offset| cursor + offset)
                .ok_or_else(|| "Git returned a malformed rename status record.".to_string())?;
            let value = raw[cursor..second_end].to_vec();
            cursor = second_end + 1;
            Some(value)
        } else {
            None
        };
        let mut semantic = record.to_vec();
        if let Some(other) = &second {
            semantic.push(0);
            semantic.extend_from_slice(other);
        }
        semantic_records.push(semantic);
        if code != b"??" && code != b"!!" {
            tracked_paths.insert(path.clone());
            if let Some(other) = &second {
                tracked_paths.insert(other.clone());
            }
        }
        let code_label = String::from_utf8_lossy(code);
        let path_label = String::from_utf8_lossy(&path);
        let mut display_paths = vec![path.clone()];
        if let Some(other) = &second {
            display_paths.push(other.clone());
        }
        let label = match second {
            Some(other) => format!(
                "{code_label} {} -> {path_label}",
                String::from_utf8_lossy(&other)
            ),
            None => format!("{code_label} {path_label}"),
        };
        display.push(StatusDisplay {
            label,
            paths: display_paths,
        });
    }
    Ok(ParsedStatus {
        semantic_records,
        tracked_paths,
        display,
    })
}

pub(super) fn parse_nul_paths(raw: &[u8]) -> Result<Vec<OsString>, String> {
    raw.split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
        .map(git_path)
        .collect()
}

pub(super) fn untracked_paths(scope: &RepositoryScope) -> Result<Vec<OsString>, String> {
    parse_nul_paths(&run_scoped_git_stdout_raw(
        scope,
        &[
            "-c",
            "core.fsmonitor=false",
            "ls-files",
            "--others",
            "--exclude-standard",
            "-z",
        ],
    )?)
}
