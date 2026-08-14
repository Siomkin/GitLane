//! Guarded soft, mixed, and hard reset writes.

use super::cli::run_git;
use super::hard_reset_lease;
use super::head::{
    checkout_expected_branch, ensure_commit_exists, ensure_expected_branch_tip,
    ensure_expected_head,
};
use super::operands::ensure_exact_oid;
use serde::{Deserialize, Serialize};

/// The mode of a reset, parsed once at the command boundary. An unrecognised
/// mode string is rejected there: degrading it to `mixed` would run a weaker
/// reset than the one the UI confirmed — and one that skips the hard-reset
/// lease entirely.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ResetMode {
    /// Keep the reset-off changes staged.
    Soft,
    /// Keep the reset-off changes in the worktree, unstaged.
    Mixed,
    /// Discard the changes; requires the preview's worktree lease.
    Hard,
}

impl ResetMode {
    pub fn parse(mode: &str) -> Result<Self, String> {
        match mode {
            "soft" => Ok(Self::Soft),
            "mixed" => Ok(Self::Mixed),
            "hard" => Ok(Self::Hard),
            other => Err(format!(
                "Unknown reset mode \"{other}\". Refresh and try again."
            )),
        }
    }
}

/// What the reset acts on: a named branch pinned to its previewed tip, or HEAD
/// pinned to a commit (or to having none, in an unborn repository). A branch
/// without its expected oid — the pairing every caller had to reject by hand —
/// is not representable.
#[derive(Debug, PartialEq)]
pub enum ResetSubject {
    Branch {
        name: String,
        expected_oid: String,
    },
    /// HEAD at a known commit; the branch, if any, is not pinned.
    Head {
        expected_oid: String,
    },
    /// An unborn repository: HEAD must still have no commit.
    UnbornHead,
}

impl ResetSubject {
    pub fn parse(source: Option<&str>, expected_source_oid: Option<&str>) -> Result<Self, String> {
        match (source, expected_source_oid) {
            (Some(name), Some(expected_oid)) => Ok(Self::Branch {
                name: name.to_owned(),
                expected_oid: expected_oid.to_owned(),
            }),
            (None, Some(expected_oid)) => Ok(Self::Head {
                expected_oid: expected_oid.to_owned(),
            }),
            (None, None) => Ok(Self::UnbornHead),
            (Some(_), None) => {
                Err("The branch has no expected commit. Refresh and try again.".to_string())
            }
        }
    }
}

/// The hard-reset worktree lease from the preview. The three fields travel as
/// sibling keys on the wire (`ResetPreview`); the renames keep those exact
/// camelCase names, so grouping them changes no bytes.
#[derive(Debug, PartialEq, Serialize, Deserialize)]
pub struct HeadLease {
    /// Opaque repository/HEAD/index/worktree fingerprint.
    #[serde(rename = "expectedState")]
    pub expected_state: String,
    /// Symbolic branch observed with the lease, or `None` when detached.
    #[serde(rename = "expectedHeadBranch")]
    pub expected_head_branch: Option<String>,
    /// HEAD commit observed with the lease, or `None` when unborn.
    #[serde(rename = "expectedHeadOid")]
    pub expected_head_oid: Option<String>,
}

/// A parsed `reset_to` request. The invalid pairings the old argument list
/// allowed — an unknown mode, a branch without its expected oid, a hard reset
/// without its lease, a lease on a soft/mixed reset — fail in
/// [`ResetRequest::parse`], before any lock is taken, so [`reset_branch`]
/// cannot be reached with them.
#[derive(Debug)]
pub enum ResetRequest {
    Hard {
        subject: ResetSubject,
        lease: HeadLease,
    },
    Soft {
        subject: ResetSubject,
    },
    Mixed {
        subject: ResetSubject,
    },
}

impl ResetRequest {
    pub fn parse(
        source: Option<&str>,
        expected_source_oid: Option<&str>,
        mode: &str,
        expected_state: Option<&str>,
        expected_head_branch: Option<&str>,
        expected_head_oid: Option<&str>,
    ) -> Result<Self, String> {
        let subject = ResetSubject::parse(source, expected_source_oid)?;
        let mode = ResetMode::parse(mode)?;
        if expected_state.is_some() && mode != ResetMode::Hard {
            return Err(
                "Soft/mixed reset does not accept a hard-reset worktree lease. Preview again."
                    .to_string(),
            );
        }
        match mode {
            ResetMode::Hard => {
                let Some(expected_state) = expected_state else {
                    return Err("Hard reset requires the exact-state lease from its confirmation. Preview again."
                        .to_string());
                };
                Ok(Self::Hard {
                    subject,
                    lease: HeadLease {
                        expected_state: expected_state.to_owned(),
                        expected_head_branch: expected_head_branch.map(str::to_owned),
                        expected_head_oid: expected_head_oid.map(str::to_owned),
                    },
                })
            }
            ResetMode::Soft => Ok(Self::Soft { subject }),
            ResetMode::Mixed => Ok(Self::Mixed { subject }),
        }
    }
}

/// Reset onto an exact captured oid, with **no** ref-name qualification
/// (GL-302).
///
/// Every reset caller now resolves its target up front — `preview_reset`
/// qualifies and resolves the user's ref, and squash carries the parent oid it
/// already verified — so nothing here takes a name. That matters: a bare full
/// oid resolves to the object itself, but `refs/heads/<oid>` — what
/// `qualify_branch_if_ambiguous` would produce if a branch *and* a tag are both
/// named after the 40-hex string, which git permits — resolves to that branch's
/// tip, which can move out from under the caller after it resolved the target.
///
/// [`ensure_exact_oid`] makes that a checked precondition rather than a caller
/// convention: a ref name reaching here would sidestep the preview's
/// qualification and reintroduce exactly the bug the unqualified operand avoids.
///
/// Soft and mixed only — hard reset mutates through its validated scope in
/// [`reset_branch`], not through a repo path git would re-resolve.
pub(super) fn reset_to_oid(
    repo: &str,
    target_oid: &str,
    mode: ResetMode,
) -> Result<String, String> {
    // Callers that mutate the index must already hold `lock_index_writes`
    // (`reset_branch`, `squash_commits`) — this helper must not take it again.
    ensure_exact_oid(target_oid)?;
    let flag = match mode {
        ResetMode::Soft => "--soft",
        ResetMode::Mixed => "--mixed",
        // Enforced, not just documented: a hard reset here would discard the
        // worktree without the lease `reset_branch` validates first.
        ResetMode::Hard => {
            return Err("A hard reset must go through reset_branch's leased scope.".into())
        }
    };
    run_git(repo, &["reset", flag, target_oid])
}

/// Tip/HEAD compare-and-swap for hard reset without switching branches.
///
/// The hard-reset lease fingerprints the already-checked-out worktree. A
/// `git switch` here would mutate that worktree before the lease is
/// revalidated, leaving the repo on the wrong branch if validation then fails.
fn prepare_hard_reset_subject(repo: &str, subject: &ResetSubject) -> Result<(), String> {
    match subject {
        ResetSubject::Branch { name, expected_oid } => {
            ensure_expected_branch_tip(repo, name, expected_oid)?;
            hard_reset_lease::ensure_source_is_checked_out(repo, name)?;
            ensure_expected_head(repo, Some(name), Some(expected_oid))
        }
        ResetSubject::Head { expected_oid } => ensure_expected_head(repo, None, Some(expected_oid)),
        ResetSubject::UnbornHead => ensure_expected_head(repo, None, None),
    }
}

/// Reset the explicit source branch/HEAD snapshot to a captured target oid.
/// Soft/mixed mode checks out a named source branch when needed. Hard mode
/// never switches — it only resets the already-checked-out worktree the lease
/// covered.
///
/// Hard mode re-validates [`HeadLease::expected_state`] — the opaque lease from
/// `preview_reset` — immediately before `git reset --hard` so tip/HEAD probes
/// cannot open a window for unleased worktree edits (GL-302).
pub fn reset_branch(repo: &str, target_oid: &str, request: ResetRequest) -> Result<String, String> {
    let _index_guard = super::index_lock::lock_index_writes(repo)?;
    let (subject, mode) = match request {
        ResetRequest::Hard { subject, lease } => {
            ensure_exact_oid(target_oid)?;
            // Tip/HEAD CAS first (no switch), then lease — never mutate the worktree
            // before the lease re-capture that sits next to `git reset --hard`.
            prepare_hard_reset_subject(repo, &subject)?;
            ensure_commit_exists(repo, target_oid)?;
            hard_reset_lease::run_before_mutation_test_hook();
            let validated = hard_reset_lease::validate_at_mutation_boundary(
                repo,
                target_oid,
                &lease.expected_state,
                lease.expected_head_branch.as_deref(),
                lease.expected_head_oid.as_deref(),
            )?;
            hard_reset_lease::run_after_validation_test_hook();
            // Mutate through the scope the lease just proved current — passing `repo`
            // would let git re-resolve it, and a `.git`-file retarget in this window
            // would redirect the reset out of the leased worktree (GL-302 review).
            // `--no-replace-objects` keeps a mid-flight refs/replace entry from
            // landing the leased oid on a different tree. The re-capture ends with
            // the cheap observation sweep, so the residual TOCTOU here is the same
            // accepted class as discard-all — a window no worktree lock closes
            // without a larger design change.
            return validated.run(&["--no-replace-objects", "reset", "--hard", target_oid]);
        }
        ResetRequest::Soft { subject } => (subject, ResetMode::Soft),
        ResetRequest::Mixed { subject } => (subject, ResetMode::Mixed),
    };
    match &subject {
        ResetSubject::Branch { name, expected_oid } => {
            checkout_expected_branch(repo, name, expected_oid)?
        }
        ResetSubject::Head { expected_oid } => {
            ensure_expected_head(repo, None, Some(expected_oid))?
        }
        ResetSubject::UnbornHead => ensure_expected_head(repo, None, None)?,
    }
    ensure_commit_exists(repo, target_oid)?;
    reset_to_oid(repo, target_oid, mode)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn head_lease_serialises_to_the_exact_wire_keys() {
        let lease = HeadLease {
            expected_state: "opaque".to_owned(),
            expected_head_branch: Some("main".to_owned()),
            expected_head_oid: None,
        };
        let wire = serde_json::to_value(&lease).expect("serialise lease");
        assert_eq!(
            wire,
            json!({
                "expectedState": "opaque",
                "expectedHeadBranch": "main",
                "expectedHeadOid": null,
            })
        );
        let round_tripped: HeadLease = serde_json::from_value(wire).expect("round-trip lease");
        assert_eq!(round_tripped, lease);
    }

    #[test]
    fn the_raw_reset_path_refuses_a_hard_reset() {
        // The hole this guards was a match arm, so it can come back the same
        // way. No git needed: the mode is rejected before the repo is touched.
        let error = reset_to_oid("/nonexistent", &"a".repeat(40), ResetMode::Hard)
            .expect_err("a hard reset must not run outside reset_branch's lease");
        assert!(error.contains("reset_branch"), "unexpected error: {error}");
    }

    #[test]
    fn parse_rejects_an_unknown_mode_instead_of_degrading_it() {
        let error = ResetRequest::parse(Some("main"), Some("oid"), "fold", None, None, None)
            .expect_err("an unknown mode must not become mixed");
        assert!(error.contains("\"fold\""), "unexpected error: {error}");
    }

    #[test]
    fn parse_rejects_a_branch_without_its_expected_oid_exactly_once() {
        let error = ResetRequest::parse(Some("main"), None, "hard", Some("lease"), None, None)
            .expect_err("a branch needs its expected oid");
        assert_eq!(
            error,
            "The branch has no expected commit. Refresh and try again."
        );
    }
}
