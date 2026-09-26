//! Reading the working tree's status for the lease: the porcelain-v1 parse the
//! capture builds its tracked view from, and the NUL-delimited untracked
//! enumeration the cleanup set comes from.

use std::collections::BTreeSet;
use std::ffi::OsString;

use super::super::state_lease::{read_porcelain_z, RepositoryScope, StatusRecord};
use super::{
    describe_lease_error, git_path, run_scoped_git_stdout_raw, ParsedStatus, StatusDisplay,
};

pub(super) fn read_status(scope: &RepositoryScope) -> Result<ParsedStatus, String> {
    let records = read_porcelain_z(scope).map_err(describe_lease_error)?;
    let mut semantic_records = Vec::with_capacity(records.len());
    let mut tracked_paths = BTreeSet::new();
    let mut display = Vec::with_capacity(records.len());
    for record in records {
        semantic_records.push(record.semantic());
        let StatusRecord { code, path, orig } = record;
        if &code != b"??" && &code != b"!!" {
            tracked_paths.insert(path.clone());
            if let Some(other) = &orig {
                tracked_paths.insert(other.clone());
            }
        }
        let code_label = String::from_utf8_lossy(&code);
        let path_label = String::from_utf8_lossy(&path);
        let label = match &orig {
            Some(other) => format!(
                "{code_label} {} -> {path_label}",
                String::from_utf8_lossy(other)
            ),
            None => format!("{code_label} {path_label}"),
        };
        let mut paths = vec![path];
        paths.extend(orig);
        display.push(StatusDisplay { label, paths });
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
