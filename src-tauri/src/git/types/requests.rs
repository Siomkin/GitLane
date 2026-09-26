//! Request objects for multi-field write commands.
//!
//! These IPC writes used to cross the boundary as long positional lists. Each
//! now takes `(path, request)` so the wire shape is self-describing, optional
//! expectations can be absent, and clippy no longer needs an argument-count
//! allow at the command or write layer. `deny_unknown_fields` turns a
//! misspelled optional into an immediate failure instead of a silently dropped
//! guard. `squash_branch` is included because it landed the same positional
//! shape after this change was proposed.

use serde::{Deserialize, Serialize};

use super::CapturedIdentity;

/// `commit` — summary, amend, optional expected HEAD, optional author pin.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommitRequest {
    #[serde(default)]
    pub expected_branch: Option<String>,
    #[serde(default)]
    pub expected_oid: Option<String>,
    pub summary: String,
    pub description: String,
    pub amend: bool,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
    pub identity: CapturedIdentity,
}

/// `squash_commits` — replace the tip range behind one guarded contract.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SquashCommitsRequest {
    #[serde(default)]
    pub expected_branch: Option<String>,
    pub expected_oid: String,
    pub parent_oid: String,
    pub summary: String,
    pub description: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
    pub identity: CapturedIdentity,
}

/// `squash_range` — squash below the tip and replay the commits above.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SquashRangeRequest {
    #[serde(default)]
    pub expected_branch: Option<String>,
    pub expected_oid: String,
    pub newest_oid: String,
    pub parent_oid: String,
    pub summary: String,
    pub description: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
    pub identity: CapturedIdentity,
}

/// `squash_branch` — rewrite a leased sibling branch without checking it out.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SquashBranchRequest {
    pub expected_branch: String,
    pub expected_oid: String,
    pub newest_oid: String,
    pub parent_oid: String,
    pub summary: String,
    pub description: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
    pub identity: CapturedIdentity,
}

/// `apply_line` — stage or unstage one displayed line, guarded by its fields.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyLineRequest {
    pub file: String,
    pub staged: bool,
    pub hunk_index: usize,
    pub line_index: usize,
    pub expected_kind: String,
    pub expected_content: String,
    #[serde(default)]
    pub expected_old_no: Option<u32>,
    #[serde(default)]
    pub expected_new_no: Option<u32>,
}

// ---- Closed-set command arguments ----
//
// Parsed once at the command boundary, so an unknown word is a deserialize
// error there and every consumer matches exhaustively — no provider can fall
// back to a default merge or, worse, close a pull request on a typo, and no
// reset can preview as a different mode than the one it runs.

/// How a pull request is merged (`"merge"` | `"squash"` | `"rebase"`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MergeMethod {
    Merge,
    Squash,
    Rebase,
}

/// A pull request lifecycle change (`"close"` | `"reopen"` | `"ready"`, the
/// last marking a draft ready for review).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PrStateAction {
    Close,
    Reopen,
    Ready,
}

/// The mode of a reset, parsed once at the command boundary. An unrecognised
/// mode is a deserialize error there: degrading it to `mixed` would preview and
/// run a weaker reset than the one the UI confirmed — and one that skips the
/// hard-reset lease entirely.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ResetMode {
    /// Keep the reset-off changes staged.
    Soft,
    /// Keep the reset-off changes in the worktree, unstaged.
    Mixed,
    /// Discard the changes; requires the preview's worktree lease.
    Hard,
}

impl ResetMode {
    /// The wire word, also git's flag name without the `--`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Soft => "soft",
            Self::Mixed => "mixed",
            Self::Hard => "hard",
        }
    }
}

/// `reset_to` — mode, target, optional source pin, optional hard-reset lease.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResetToRequest {
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub expected_source_oid: Option<String>,
    pub target_oid: String,
    pub mode: ResetMode,
    #[serde(default)]
    pub expected_state: Option<String>,
    #[serde(default)]
    pub expected_head_branch: Option<String>,
    #[serde(default)]
    pub expected_head_oid: Option<String>,
}

#[cfg(test)]
impl CommitRequest {
    pub(crate) fn test(summary: &str) -> Self {
        Self {
            expected_branch: None,
            expected_oid: None,
            summary: summary.to_string(),
            description: String::new(),
            amend: false,
            name: None,
            email: None,
            identity: CapturedIdentity::NotCaptured,
        }
    }
}

#[cfg(test)]
impl ApplyLineRequest {
    pub(crate) fn test(
        file: &str,
        staged: bool,
        line_index: usize,
        kind: &str,
        content: &str,
    ) -> Self {
        Self {
            file: file.into(),
            staged,
            hunk_index: 0,
            line_index,
            expected_kind: kind.into(),
            expected_content: content.into(),
            expected_old_no: None,
            expected_new_no: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn identity() -> serde_json::Value {
        json!({ "mode": "notCaptured" })
    }

    fn round_trip<T>(value: &T) -> T
    where
        T: Serialize + for<'de> Deserialize<'de> + PartialEq + std::fmt::Debug,
    {
        let encoded = serde_json::to_value(value).expect("serialize");
        serde_json::from_value(encoded).expect("deserialize")
    }

    #[test]
    fn commit_request_round_trips_and_rejects_unknown_fields() {
        let parsed: CommitRequest = serde_json::from_value(json!({
            "summary": "Add hello",
            "description": "",
            "amend": false,
            "identity": identity(),
        }))
        .unwrap();
        assert_eq!(parsed.summary, "Add hello");
        assert!(parsed.expected_oid.is_none());
        assert_eq!(round_trip(&parsed), parsed);
        assert!(serde_json::from_value::<CommitRequest>(json!({
            "summary": "x",
            "description": "",
            "amend": false,
            "identity": identity(),
            "typo": true,
        }))
        .is_err());
    }

    #[test]
    fn squash_commits_request_round_trips() {
        let parsed: SquashCommitsRequest = serde_json::from_value(json!({
            "expectedOid": "abc",
            "parentOid": "def",
            "summary": "folded",
            "description": "",
            "identity": identity(),
        }))
        .unwrap();
        assert_eq!(parsed.parent_oid, "def");
        assert_eq!(round_trip(&parsed), parsed);
    }

    #[test]
    fn squash_range_request_round_trips() {
        let parsed: SquashRangeRequest = serde_json::from_value(json!({
            "expectedOid": "tip",
            "newestOid": "new",
            "parentOid": "old",
            "summary": "folded",
            "description": "",
            "identity": identity(),
        }))
        .unwrap();
        assert_eq!(parsed.newest_oid, "new");
        assert_eq!(round_trip(&parsed), parsed);
    }

    #[test]
    fn squash_branch_request_round_trips() {
        let parsed: SquashBranchRequest = serde_json::from_value(json!({
            "expectedBranch": "feature",
            "expectedOid": "tip",
            "newestOid": "new",
            "parentOid": "old",
            "summary": "folded",
            "description": "",
            "identity": identity(),
        }))
        .unwrap();
        assert_eq!(parsed.expected_branch, "feature");
        assert_eq!(round_trip(&parsed), parsed);
    }

    #[test]
    fn apply_line_request_round_trips() {
        let parsed: ApplyLineRequest = serde_json::from_value(json!({
            "file": "a.ts",
            "staged": false,
            "hunkIndex": 0,
            "lineIndex": 2,
            "expectedKind": "add",
            "expectedContent": "inserted",
            "expectedNewNo": 3,
        }))
        .unwrap();
        assert_eq!(parsed.expected_new_no, Some(3));
        assert!(parsed.expected_old_no.is_none());
        assert_eq!(round_trip(&parsed), parsed);
    }

    #[test]
    fn reset_to_request_round_trips_without_expectations() {
        let parsed: ResetToRequest = serde_json::from_value(json!({
            "targetOid": "abc",
            "mode": "mixed",
        }))
        .unwrap();
        assert!(parsed.expected_head_oid.is_none());
        assert_eq!(round_trip(&parsed), parsed);
    }

    #[test]
    fn reset_mode_rejects_an_unknown_mode_instead_of_degrading_it() {
        for (word, mode) in [
            ("soft", ResetMode::Soft),
            ("mixed", ResetMode::Mixed),
            ("hard", ResetMode::Hard),
        ] {
            assert_eq!(
                serde_json::from_value::<ResetMode>(json!(word)).unwrap(),
                mode
            );
            assert_eq!(mode.as_str(), word);
        }
        // `preview_reset` and `reset_to` both take `ResetMode`, so "keep" is
        // refused before either runs rather than previewed as "Reset mixed".
        assert!(serde_json::from_value::<ResetMode>(json!("keep")).is_err());
        assert!(serde_json::from_value::<ResetToRequest>(json!({
            "targetOid": "abc",
            "mode": "keep",
        }))
        .is_err());
    }

    #[test]
    fn closed_set_arguments_accept_only_their_wire_words() {
        let parse = |word: &str| json!(word);
        for (word, method) in [
            ("merge", MergeMethod::Merge),
            ("squash", MergeMethod::Squash),
            ("rebase", MergeMethod::Rebase),
        ] {
            assert_eq!(
                serde_json::from_value::<MergeMethod>(parse(word)).unwrap(),
                method
            );
        }
        for (word, action) in [
            ("close", PrStateAction::Close),
            ("reopen", PrStateAction::Reopen),
            ("ready", PrStateAction::Ready),
        ] {
            assert_eq!(
                serde_json::from_value::<PrStateAction>(parse(word)).unwrap(),
                action
            );
        }
        for bogus in ["bogus", "fast", "", "Close"] {
            assert!(serde_json::from_value::<MergeMethod>(parse(bogus)).is_err());
            assert!(serde_json::from_value::<PrStateAction>(parse(bogus)).is_err());
        }
    }
}
