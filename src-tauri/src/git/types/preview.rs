//! Confirmation previews and the state leases they carry. Every destructive
//! write is previewed first, and the preview's lease is what the backend checks
//! before mutating, so the user can only confirm the state they were shown.

use serde::{Deserialize, Serialize};

/// Read-only impact summary shown before a destructive operation runs.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DestructivePreview {
    pub summary: String,
    pub details: Vec<String>,
    pub warnings: Vec<String>,
}

/// Reset impact plus the exact target/source tips the write must still observe.
/// Hard mode also carries an opaque worktree/index lease so confirm→execute
/// cannot discard a different repository state than the dialog previewed (GL-302).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetPreview {
    pub summary: String,
    pub details: Vec<String>,
    pub warnings: Vec<String>,
    /// Exact commit the reset will move to — never a symbolic name that can move.
    pub target_oid: String,
    /// Tip of the source branch/HEAD observed by the preview.
    pub expected_source_oid: Option<String>,
    /// Opaque repository/HEAD/index/worktree fingerprint. Present only for hard.
    pub expected_state: Option<String>,
    /// Symbolic branch observed with the hard-reset lease, or null when detached.
    pub expected_head_branch: Option<String>,
    /// HEAD commit observed with the hard-reset lease, or null when unborn.
    pub expected_head_oid: Option<String>,
}

/// Force-push impact plus the complete compare-and-swap contract shown by the
/// confirmation. The local source object, resolved push route, and destination
/// expectation all cross IPC again so the write cannot widen or silently adopt
/// newer tracking state after the dialog opened.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForcePushPreview {
    pub summary: String,
    pub details: Vec<String>,
    pub warnings: Vec<String>,
    pub expected_oid: String,
    pub remote: String,
    pub destination_ref: String,
    pub destination_oid: Option<String>,
    /// SHA-256 fingerprint of the single effective push endpoint. The endpoint
    /// itself stays backend-only because a user-managed URL may be sensitive.
    pub push_endpoint_token: String,
}

/// The previewed push route that must remain exact through force-push. Grouping
/// these fields keeps the route one IPC value instead of a set of independent
/// arguments that callers could accidentally mix between previews.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForcePushRouteLease {
    pub remote: String,
    pub destination_ref: String,
    pub destination_oid: Option<String>,
    pub push_endpoint_token: String,
}

impl From<&ForcePushPreview> for ForcePushRouteLease {
    fn from(preview: &ForcePushPreview) -> Self {
        Self {
            remote: preview.remote.clone(),
            destination_ref: preview.destination_ref.clone(),
            destination_oid: preview.destination_oid.clone(),
            push_endpoint_token: preview.push_endpoint_token.clone(),
        }
    }
}

/// Branch-deletion impact plus the exact local-ref object the confirmation
/// described. The write accepts this oid again as a compare-and-swap lease, so
/// a branch advanced or rewritten after the dialog opened is never deleted.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteBranchPreview {
    pub summary: String,
    pub details: Vec<String>,
    pub warnings: Vec<String>,
    pub expected_oid: String,
}

/// Read-only impact plus the exact per-path state a later file-discard command
/// must still observe. The token is opaque to the frontend and contains no file
/// contents; Rust recomputes it immediately before the destructive write.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscardFilePreview {
    pub summary: String,
    pub details: Vec<String>,
    pub warnings: Vec<String>,
    pub expected_state: String,
}

/// Whether `.git/index.lock` is present and safe to remove (GL-335 recovery).
/// `stale` is true only when the lock looks orphaned (old mtime, no openers).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexLockStatus {
    pub present: bool,
    pub stale: bool,
    /// Short human reason — shown when recovery is refused or as toast detail.
    pub detail: String,
}

/// Whole-worktree discard impact plus the exact repository, HEAD, index, and
/// affected-leaf snapshot the later write must still observe. The opaque state
/// commits to raw path bytes and file fingerprints; the explicit HEAD fields
/// make the user-visible subject inspectable across IPC as well.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscardAllPreview {
    pub summary: String,
    pub details: Vec<String>,
    pub warnings: Vec<String>,
    pub expected_state: String,
    pub expected_head_branch: Option<String>,
    pub expected_head_oid: Option<String>,
}
