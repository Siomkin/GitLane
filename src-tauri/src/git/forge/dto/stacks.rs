use serde::Deserialize;

use super::GqlNodes;
use crate::git::types::{PrStack, PrStackEntry, PrStackMembership};

// Stacked pull requests (public preview, 2026-07-30). `gh pr view --json` has
// no `stack` field — the projection rejects it outright — so the stack a PR
// belongs to is read over GraphQL like the commit list above. `stackEntry` is
// null for the overwhelmingly common case of a PR that is not stacked, which is
// a successful response, not an error.

#[derive(Deserialize)]
pub(in crate::git::forge) struct GqlStackResp {
    pub(in crate::git::forge) data: GqlStackData,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::git::forge) struct GqlStackData {
    pub(in crate::git::forge) repository: GqlStackRepo,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::git::forge) struct GqlStackRepo {
    pub(in crate::git::forge) pull_request: GqlStackPr,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::git::forge) struct GqlStackPr {
    #[serde(default)]
    pub(in crate::git::forge) stack_entry: Option<GqlStackEntry>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::git::forge) struct GqlStackEntry {
    #[serde(default)]
    pub(in crate::git::forge) position: u64,
    pub(in crate::git::forge) stack: GqlStack,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::git::forge) struct GqlStack {
    #[serde(default)]
    pub(in crate::git::forge) number: u64,
    #[serde(default)]
    pub(in crate::git::forge) size: u64,
    #[serde(default)]
    pub(in crate::git::forge) base_ref_name: String,
    pub(in crate::git::forge) entries: GqlNodes<GqlStackNode>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::git::forge) struct GqlStackNode {
    #[serde(default)]
    pub(in crate::git::forge) position: u64,
    #[serde(default)]
    pub(in crate::git::forge) pull_request: Option<GqlStackPrRef>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::git::forge) struct GqlStackPrRef {
    pub(in crate::git::forge) number: u64,
    #[serde(default)]
    pub(in crate::git::forge) title: String,
    #[serde(default)]
    pub(in crate::git::forge) state: String,
    #[serde(default)]
    pub(in crate::git::forge) is_draft: bool,
    #[serde(default)]
    pub(in crate::git::forge) head_ref_name: String,
    #[serde(default)]
    pub(in crate::git::forge) mergeable: Option<String>,
    /// Head commit, carried only for its `statusCheckRollup`.
    #[serde(default)]
    pub(in crate::git::forge) commits: Option<GqlNodes<GqlStackCommit>>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::git::forge) struct GqlStackCommit {
    pub(in crate::git::forge) commit: GqlStackCommitChecks,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::git::forge) struct GqlStackCommitChecks {
    /// Null when the repo runs no checks at all — which is "nothing failing",
    /// not "not ready".
    #[serde(default)]
    pub(in crate::git::forge) status_check_rollup: Option<GqlStatusRollup>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::git::forge) struct GqlStatusRollup {
    #[serde(default)]
    pub(in crate::git::forge) state: String,
}

// `GET /repos/{o}/{r}/stacks` — every stack in the repo, each with its pull
// requests already ordered bottom-to-top. REST v3, so snake_case. The list
// projection is slimmer than the single-stack GET (no title/user), which is
// exactly enough for the PR-list badge.
#[derive(Deserialize)]
pub(in crate::git::forge) struct GhStackListItem {
    #[serde(default)]
    pub(in crate::git::forge) number: u64,
    #[serde(default)]
    pub(in crate::git::forge) pull_requests: Vec<GhStackListPr>,
}
#[derive(Deserialize)]
pub(in crate::git::forge) struct GhStackListPr {
    pub(in crate::git::forge) number: u64,
}

impl GhStackListItem {
    /// Flatten to one membership per pull request. Position is the index in
    /// `pull_requests`, which GitHub returns bottom-to-top — the same 1-based
    /// scheme `PullRequest.stackEntry.position` uses.
    pub(in crate::git::forge) fn into_memberships(self) -> Vec<PrStackMembership> {
        let size = self.pull_requests.len() as u64;
        self.pull_requests
            .into_iter()
            .enumerate()
            .map(|(index, pr)| PrStackMembership {
                pr_number: pr.number,
                stack_number: self.number,
                position: index as u64 + 1,
                size,
            })
            .collect()
    }
}

// `PUT /repos/{o}/{r}/pulls/{n}/merge-async` and its polling GET share one
// response schema. REST v3 is already snake_case, so the field names map
// directly. `details` carries the uuid while pending, and the human-readable
// message on a terminal status.
#[derive(Deserialize)]
pub(in crate::git::forge) struct GhMergeAsync {
    #[serde(default)]
    pub(in crate::git::forge) status: String,
    #[serde(default)]
    pub(in crate::git::forge) details: Option<GhMergeAsyncDetails>,
}
#[derive(Deserialize)]
pub(in crate::git::forge) struct GhMergeAsyncDetails {
    #[serde(default)]
    pub(in crate::git::forge) uuid: Option<String>,
    #[serde(default)]
    pub(in crate::git::forge) message: Option<String>,
}

impl GqlStackEntry {
    pub(in crate::git::forge) fn into_stack(self) -> PrStack {
        let stack = self.stack;
        let mut entries: Vec<PrStackEntry> = stack
            .entries
            .nodes
            .into_iter()
            // A layer whose pull request the viewer cannot see comes back as a
            // null `pullRequest` on a non-null entry; drop it rather than
            // inventing a placeholder row. `size` still counts it, which is how
            // the card knows the list is partial.
            .filter_map(|node| {
                let pr = node.pull_request?;
                Some(PrStackEntry {
                    position: node.position,
                    number: pr.number,
                    title: pr.title,
                    state: pr.state,
                    is_draft: pr.is_draft,
                    head_ref: pr.head_ref_name,
                    mergeable: pr.mergeable.unwrap_or_default(),
                    checks: pr
                        .commits
                        .and_then(|c| c.nodes.into_iter().next())
                        .and_then(|node| node.commit.status_check_rollup)
                        .map(|rollup| rollup.state)
                        .unwrap_or_default(),
                })
            })
            .collect();
        // GitHub returns them in order today; sorting makes the bottom-to-top
        // contract the frontend renders from a property of the data, not a
        // property of the response.
        entries.sort_by_key(|entry| entry.position);
        PrStack {
            number: stack.number,
            size: stack.size,
            base_ref: stack.base_ref_name,
            position: self.position,
            entries,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- stacked pull requests (GqlStackEntry::into_stack) ----

    // Captured verbatim from a real two-layer stack on GitHub (stack #307 over
    // PRs #305/#306). The nesting here — data → repository → pullRequest →
    // stackEntry → stack → entries → nodes → pullRequest — is the part that
    // fails silently if a field name drifts, so it is pinned to ground truth
    // rather than a hand-written shape. It also deliberately omits `isDraft`,
    // `headRefName`, and `mergeable`, proving the `serde(default)`s tolerate a
    // response that doesn't carry them.
    const REAL_STACK_RESPONSE: &str = r#"{"data":{"repository":{"pullRequest":{"number":306,"stackEntry":{"position":2,"stack":{"number":307,"size":2,"baseRefName":"latest","entries":{"nodes":[{"position":1,"pullRequest":{"number":305,"title":"probe layer 1","state":"OPEN"}},{"position":2,"pullRequest":{"number":306,"title":"probe layer 2","state":"OPEN"}}]}}}}}}}"#;

    #[test]
    fn parses_a_real_stack_response() {
        let parsed: GqlStackResp = serde_json::from_str(REAL_STACK_RESPONSE).unwrap();
        let stack = parsed
            .data
            .repository
            .pull_request
            .stack_entry
            .expect("stackEntry present")
            .into_stack();
        assert_eq!(stack.number, 307);
        assert_eq!(stack.size, 2);
        assert_eq!(stack.base_ref, "latest");
        // The requested PR (#306) sits on top of the two-layer stack.
        assert_eq!(stack.position, 2);
        // Bottom-to-top, so position 1 (targeting `latest`) comes first.
        assert_eq!(
            stack.entries.iter().map(|e| e.number).collect::<Vec<_>>(),
            vec![305, 306]
        );
        assert_eq!(stack.entries[0].title, "probe layer 1");
        assert_eq!(stack.entries[0].state, "OPEN");
        // Absent optional fields degrade, they don't fail the read.
        assert!(!stack.entries[0].is_draft);
        assert_eq!(stack.entries[0].head_ref, "");
        assert_eq!(stack.entries[0].mergeable, "");
        assert_eq!(stack.entries[0].checks, "");
    }

    // Also captured verbatim, from the stack GitLane's own PRs formed. Readiness
    // rides the head commit's rollup, so the nesting the mapping has to walk
    // (commits -> nodes -> commit -> statusCheckRollup -> state) is pinned to a
    // real payload rather than a hand-written shape.
    const REAL_STACK_WITH_CHECKS: &str = r#"{"data":{"repository":{"pullRequest":{"stackEntry":{"position":2,"stack":{"number":310,"size":2,"baseRefName":"latest","entries":{"nodes":[{"position":1,"pullRequest":{"number":308,"title":"Match the PR detail panel to the other center workspaces","state":"OPEN","isDraft":false,"headRefName":"fix/pr-detail-panel-surface","mergeable":"MERGEABLE","commits":{"nodes":[{"commit":{"statusCheckRollup":{"state":"SUCCESS"}}}]}}},{"position":2,"pullRequest":{"number":309,"title":"Show and merge stacked pull requests","state":"OPEN","isDraft":false,"headRefName":"feat/stacked-pull-requests","mergeable":"MERGEABLE","commits":{"nodes":[{"commit":{"statusCheckRollup":{"state":"PENDING"}}}]}}}]}}}}}}}"#;

    #[test]
    fn reads_readiness_from_the_head_commit_rollup() {
        let parsed: GqlStackResp = serde_json::from_str(REAL_STACK_WITH_CHECKS).unwrap();
        let stack = parsed
            .data
            .repository
            .pull_request
            .stack_entry
            .expect("stackEntry present")
            .into_stack();
        assert_eq!(stack.number, 310);
        // `mergeable` says nothing about readiness — both layers are MERGEABLE …
        assert!(stack.entries.iter().all(|e| e.mergeable == "MERGEABLE"));
        // … and the rollup is what separates them.
        assert_eq!(stack.entries[0].checks, "SUCCESS");
        assert_eq!(stack.entries[1].checks, "PENDING");
    }

    #[test]
    fn a_layer_without_checks_reports_no_rollup_rather_than_failing() {
        // A repo that runs no checks answers `statusCheckRollup: null`, and a
        // truncated/absent `commits` connection must degrade the same way — the
        // mapping walks four levels, any of which can be null.
        let raw = r#"{"data":{"repository":{"pullRequest":{"stackEntry":{"position":1,"stack":{"number":7,"size":2,"baseRefName":"main","entries":{"nodes":[
            {"position":1,"pullRequest":{"number":1,"title":"no checks","state":"OPEN","commits":{"nodes":[{"commit":{"statusCheckRollup":null}}]}}},
            {"position":2,"pullRequest":{"number":2,"title":"no commits","state":"OPEN"}}
        ]}}}}}}}"#;
        let parsed: GqlStackResp = serde_json::from_str(raw).unwrap();
        let stack = parsed
            .data
            .repository
            .pull_request
            .stack_entry
            .unwrap()
            .into_stack();
        assert_eq!(stack.entries[0].checks, "");
        assert_eq!(stack.entries[1].checks, "");
    }

    #[test]
    fn flattens_repository_stacks_into_per_pr_memberships() {
        // Captured from `GET /repos/{o}/{r}/stacks`: the list projection is
        // slimmer than the single-stack GET, and its `pull_requests` are already
        // ordered bottom-to-top, which is what makes index+1 the position.
        let raw = r#"[{"id":81391,"number":307,"base":{"ref":"latest"},"open":true,"pull_requests":[
            {"number":305,"state":"open","draft":true,"merged_at":null,"head":{"ref":"a","sha":"s1"}},
            {"number":306,"state":"open","draft":true,"merged_at":null,"head":{"ref":"b","sha":"s2"}}
        ]}]"#;
        let stacks: Vec<GhStackListItem> = serde_json::from_str(raw).unwrap();
        let memberships: Vec<_> = stacks
            .into_iter()
            .flat_map(GhStackListItem::into_memberships)
            .collect();
        assert_eq!(memberships.len(), 2);
        assert_eq!(memberships[0].pr_number, 305);
        assert_eq!(memberships[0].position, 1);
        assert_eq!(memberships[1].pr_number, 306);
        assert_eq!(memberships[1].position, 2);
        // Every member reports the same stack number and total.
        assert!(memberships
            .iter()
            .all(|m| m.stack_number == 307 && m.size == 2));
    }

    #[test]
    fn a_repository_with_no_stacks_flattens_to_nothing() {
        let stacks: Vec<GhStackListItem> = serde_json::from_str("[]").unwrap();
        assert!(stacks
            .into_iter()
            .flat_map(GhStackListItem::into_memberships)
            .next()
            .is_none());
    }

    #[test]
    fn an_unstacked_pull_request_is_a_successful_none() {
        // By far the common case: `stackEntry` is null and must not read as an
        // error, or every non-stacked PR would surface a failure.
        let raw = r#"{"data":{"repository":{"pullRequest":{"number":300,"stackEntry":null}}}}"#;
        let parsed: GqlStackResp = serde_json::from_str(raw).unwrap();
        assert!(parsed.data.repository.pull_request.stack_entry.is_none());
    }

    #[test]
    fn orders_entries_by_position_and_drops_invisible_layers() {
        // Out of order on the wire, with a layer whose PR the viewer can't see.
        let raw = r#"{"data":{"repository":{"pullRequest":{"number":9,"stackEntry":{"position":1,"stack":{"number":50,"size":3,"baseRefName":"main","entries":{"nodes":[
            {"position":2,"pullRequest":{"number":9,"title":"top","state":"OPEN","isDraft":true,"headRefName":"b","mergeable":"CONFLICTING"}},
            {"position":3,"pullRequest":null},
            {"position":1,"pullRequest":{"number":7,"title":"bottom","state":"MERGED","isDraft":false,"headRefName":"a","mergeable":"MERGEABLE"}}
        ]}}}}}}}"#;
        let stack: GqlStackResp = serde_json::from_str(raw).unwrap();
        let stack = stack
            .data
            .repository
            .pull_request
            .stack_entry
            .unwrap()
            .into_stack();
        assert_eq!(
            stack.entries.iter().map(|e| e.number).collect::<Vec<_>>(),
            vec![7, 9]
        );
        // The hidden layer is dropped, but `size` still counts it — that gap is
        // how the frontend knows the list it received is partial.
        assert_eq!(stack.size, 3);
        assert_eq!(stack.entries.len(), 2);
        assert!(stack.entries[1].is_draft);
        assert_eq!(stack.entries[1].mergeable, "CONFLICTING");
    }
}
