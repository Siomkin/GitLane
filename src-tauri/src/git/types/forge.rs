//! Pull requests and their review surface, shared by the GitHub, GitLab, and
//! Bitbucket providers.

use serde::{Deserialize, Serialize};

// ---- GitHub (gh CLI) ----

/// Everything a new pull request is opened with.
///
/// One struct rather than positional arguments because the create path runs
/// command -> service -> trait -> three providers, and every added field would
/// otherwise widen six signatures.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrCreateInput {
    pub base: String,
    pub head: String,
    pub title: String,
    pub body: String,
    pub draft: bool,
    /// Provider logins to request review from. Empty when the provider has no
    /// reviewer support, or the user picked none.
    #[serde(default)]
    pub reviewers: Vec<String>,
}

/// Someone who can be asked to review in this repository.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrReviewerCandidate {
    pub login: String,
    /// Display name when the provider gives one, else the login.
    pub name: String,
    pub avatar_url: Option<String>,
}

/// PR author (GitHub login + display name).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrAuthor {
    pub login: String,
    pub name: String,
}

/// One discussion comment on a PR (issue-level, not a file review comment).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrComment {
    pub author: PrAuthor,
    pub body: String,
    /// ISO-8601 timestamp; the frontend renders a relative age.
    pub created_at: String,
}

/// A label on a PR (`color` is a 6-hex RGB string without the leading `#`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrLabel {
    pub name: String,
    pub color: String,
}

/// A submitted review's verdict. `state` is the raw gh value
/// (`APPROVED` | `CHANGES_REQUESTED` | `COMMENTED` | `DISMISSED` | …).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrReview {
    pub author: PrAuthor,
    pub state: String,
}

/// One inline review thread on a PR — a file/line-anchored discussion plus its
/// resolve state. Sourced from the GraphQL API (gh's `pr` verbs don't expose
/// threads); `id` is the GraphQL node id used to resolve/unresolve the thread.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewThread {
    pub id: String,
    pub path: String,
    /// Line on the new side; None when the thread is outdated / unanchored.
    pub line: Option<u32>,
    pub is_resolved: bool,
    pub is_outdated: bool,
    /// True when the thread holds more comments than the per-thread query cap
    /// fetched — the UI should say so instead of presenting the list as complete.
    pub comments_truncated: bool,
    pub comments: Vec<PrComment>,
}

/// Bounded review-thread pagination result. `truncated` distinguishes the
/// runaway safety cap from a complete thread list at the IPC boundary.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewThreadList {
    pub threads: Vec<ReviewThread>,
    pub truncated: bool,
}

/// One status check on a PR (CI job or commit status), as a display result.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrCheck {
    pub name: String,
    /// "pass" | "fail" | "pending" | "skipped". In-flight checks are reported
    /// as "pending" rather than collapsed into "fail"; skipped/neutral checks
    /// stay distinct so the frontend does not call them passed.
    pub state: String,
}

/// One commit included in a PR, sourced from GitHub (the authoritative PR commit
/// set) rather than local history. `oid` is the full SHA; the frontend slices a
/// short form for display and copies the full value. Author fields fall back to
/// empty strings when GitHub returns no author metadata.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrCommit {
    pub oid: String,
    /// First line of the commit message.
    pub headline: String,
    /// ISO-8601 authored timestamp; the frontend renders a relative age.
    pub authored_date: String,
    /// Author display name (falls back to the login, then empty when unknown).
    pub author_name: String,
    /// Author GitHub login; empty when GitHub returns no author.
    pub author_login: String,
    /// GitHub's own `signature.isValid` — reliable structured data, never
    /// inferred locally. `false` for unsigned commits, and for the fast-path
    /// commits from `gh pr view` (which carries no signature data) until the
    /// paginated GraphQL commit read replaces them.
    pub verified: bool,
}

/// Bounded PR-commit pagination result. `truncated` is true when the provider
/// reported another page after GitLane reached its safety cap.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrCommitList {
    pub commits: Vec<PrCommit>,
    pub truncated: bool,
}

/// One layer of a stacked pull request. `position` is GitHub's own 1-based
/// index counted **from the trunk**, so position 1 is the bottom layer that
/// targets the stack's base branch.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrStackEntry {
    pub position: u64,
    pub number: u64,
    pub title: String,
    /// Raw gh value (`OPEN` | `MERGED` | `CLOSED`), like [`PullRequestSummary`].
    pub state: String,
    pub is_draft: bool,
    pub head_ref: String,
    /// `MERGEABLE` | `CONFLICTING` | `UNKNOWN`, or `""` when GitHub reported no
    /// value — same contract as [`PullRequestSummary`]'s field. This covers
    /// **conflicts only**; it is not whether the layer can merge.
    pub mergeable: String,
    /// The head commit's `statusCheckRollup`: `SUCCESS` | `PENDING` |
    /// `FAILURE` | `ERROR` | `EXPECTED`, or `""` when the repo runs no checks.
    ///
    /// This — not `mergeStateStatus` — is what GitHub's own stack card renders
    /// Ready/Not-ready from. `mergeStateStatus` reports BLOCKED for anything the
    /// base's ruleset still wants (an approving review, say), which GitHub's
    /// stack UI deliberately does not gate on: rules are enforced when the merge
    /// runs and the failure is reported back.
    pub checks: String,
}

/// One pull request's place in a stack, for the PR **list** badge.
///
/// The list needs this for every row at once, which the per-PR
/// [`PrStack`] read cannot provide — it is only fetched when a detail opens.
/// The repo-wide `/stacks` endpoint answers all of them in a single call, so
/// this is deliberately the flattened, badge-sized projection rather than a
/// second copy of the full stack.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrStackMembership {
    pub pr_number: u64,
    /// The stack's own number — from the same sequence as issues and PRs.
    pub stack_number: u64,
    /// 1-based from the trunk, matching [`PrStackEntry::position`].
    pub position: u64,
    pub size: u64,
}

/// The stack one pull request belongs to, as rendered by the stack card.
///
/// `number` is the stack's own number, which GitHub draws from the **same
/// sequence as issues and pull requests** — stack 307 and PR 307 are different
/// objects, so this is never rendered as a bare `#307`.
///
/// `size` is GitHub's reported total. It can exceed `entries.len()` if a stack
/// ever outgrows the query's page size, so the frontend compares the two rather
/// than assuming the list is complete.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrStack {
    pub number: u64,
    pub size: u64,
    pub base_ref: String,
    /// The requested PR's own position within `entries`.
    pub position: u64,
    /// Bottom-to-top: `entries[0]` is position 1, the layer targeting `base_ref`.
    pub entries: Vec<PrStackEntry>,
}

/// A pull request as shown in the PRs list. `state` is the raw gh value
/// (`OPEN` | `MERGED` | `CLOSED`); the frontend lowercases it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestSummary {
    pub number: u64,
    pub title: String,
    pub state: String,
    pub head_ref: String,
    pub base_ref: String,
    pub author: PrAuthor,
    /// ISO-8601 creation timestamp; the frontend renders a relative age.
    pub created_at: String,
    pub additions: u64,
    pub deletions: u64,
    pub changed_files: u64,
    pub is_draft: bool,
    pub url: String,
    /// gh mergeability verdict: "MERGEABLE" | "CONFLICTING" | "UNKNOWN"
    /// ("UNKNOWN" until GitHub finishes computing it), or "" when gh reports no
    /// value. Lets the frontend invalidate a cached detail when it flips to a
    /// definitive value.
    pub mergeable: String,
}

/// Outcome of a merge that succeeded. The merge itself is reported by the
/// command resolving; this carries what the provider could not finish, so a
/// half-done request never lands silently.
///
/// `undeleted_branch` is the head branch's name when `delete_branch` was asked
/// for and the branch still exists afterwards (protected branch, insufficient
/// permission). `None` covers both "not asked for" and "done" — the check is
/// deliberately quiet when it cannot tell, so it never raises a false alarm.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestMergeOutcome {
    pub undeleted_branch: Option<String>,
}

/// Full pull-request detail for the center pane (body, files, checks).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestDetail {
    pub number: u64,
    pub title: String,
    pub state: String,
    pub head_ref: String,
    pub base_ref: String,
    pub author: PrAuthor,
    pub created_at: String,
    pub additions: u64,
    pub deletions: u64,
    pub changed_files: u64,
    pub is_draft: bool,
    pub url: String,
    /// Markdown body of the PR.
    pub body: String,
    pub comments: u64,
    pub files: Vec<String>,
    /// Discussion comments in order (the `comments` field above is just the count).
    pub comment_list: Vec<PrComment>,
    /// gh mergeability verdict — same value set as [`PullRequestSummary`]'s:
    /// "MERGEABLE" | "CONFLICTING" | "UNKNOWN" | "" (the last two while GitHub
    /// is still computing it or gh reports no value). Drives whether the merge
    /// button is offered.
    pub mergeable: String,
    /// Requested reviewers still pending (users + teams, by login/slug).
    pub reviewers: Vec<PrAuthor>,
    /// Submitted reviews (one per submission; the frontend dedupes to latest).
    pub reviews: Vec<PrReview>,
    pub assignees: Vec<PrAuthor>,
    pub labels: Vec<PrLabel>,
    /// Milestone title, when one is set.
    pub milestone: Option<String>,
    /// Commits included in the PR, in GitHub's order (oldest → newest).
    pub commits: Vec<PrCommit>,
}
