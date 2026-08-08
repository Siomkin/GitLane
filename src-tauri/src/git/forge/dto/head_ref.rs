use serde::Deserialize;

/// Response to the post-merge head-ref probe. `head_ref` resolves to the branch
/// object and is **null exactly when the branch no longer exists** — that null
/// is the whole signal, which is why the probe reads it rather than parsing
/// gh's narration. Every level is optional so a partial/errored payload
/// deserializes into "cannot tell" instead of failing the merge.
#[derive(Deserialize)]
pub(in crate::git::forge) struct GqlHeadRefResp {
    #[serde(default)]
    pub(in crate::git::forge) data: Option<GqlHeadRefData>,
    /// GraphQL returns 200 with *both* `data` and `errors` for a partially
    /// resolved query. Any error at all means the probe cannot tell, so this is
    /// read rather than ignored.
    #[serde(default)]
    pub(in crate::git::forge) errors: Option<Vec<serde_json::Value>>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::git::forge) struct GqlHeadRefData {
    #[serde(default)]
    pub(in crate::git::forge) repository: Option<GqlHeadRefRepo>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::git::forge) struct GqlHeadRefRepo {
    #[serde(default)]
    pub(in crate::git::forge) pull_request: Option<GqlHeadRefPr>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::git::forge) struct GqlHeadRefPr {
    /// `gh pr merge` also exits 0 when it merely *enables auto-merge* or
    /// enqueues the PR — in which case the head branch legitimately still
    /// exists. Only a confirmed merge makes a surviving branch a failed delete.
    #[serde(default)]
    pub(in crate::git::forge) merged: Option<bool>,
    #[serde(default)]
    pub(in crate::git::forge) head_ref_name: Option<String>,
    /// Null once the branch is gone; present (any shape) while it survives.
    #[serde(default)]
    pub(in crate::git::forge) head_ref: Option<GqlHeadRef>,
}
#[derive(Deserialize)]
pub(in crate::git::forge) struct GqlHeadRef {
    #[serde(default)]
    #[allow(dead_code)]
    pub(in crate::git::forge) name: Option<String>,
}
