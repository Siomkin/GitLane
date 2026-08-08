//! Private `gh` / GraphQL response shapes and their conversions into the public
//! [`crate::git::types`] domain types.
//!
//! Everything here is `pub(super)` — visible only within the `github` module
//! tree — so raw transport JSON never leaks through the [`super`] facade. This
//! module never invokes `gh`; it only deserializes and maps. `GhUser` is shared
//! with [`super::cli`] for authenticated-user lookup during account discovery.
//!
//! The declarations live in focused modules under `dto/`, one per response
//! family, and are re-exported flat from here (GL-341) — so callers keep
//! writing `super::dto::Foo` regardless of which module owns `Foo`.

use serde::Deserialize;

mod commits;
mod head_ref;
mod pr;
mod stacks;
mod threads;
mod user;

pub(super) use commits::*;
pub(super) use head_ref::*;
pub(super) use pr::*;
pub(super) use stacks::*;
pub(super) use threads::*;
pub(super) use user::*;

// ---- shared GraphQL shapes (used by more than one response family) ----

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GqlNodes<T> {
    pub(super) nodes: Vec<T>,
    /// Present only when the query requests `pageInfo` (paginated connections).
    #[serde(default)]
    pub(super) page_info: Option<GqlPageInfo>,
    /// Present only when the query requests `totalCount` (capped connections
    /// that surface a truncation flag instead of paginating).
    #[serde(default)]
    pub(super) total_count: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GqlPageInfo {
    #[serde(default)]
    pub(super) has_next_page: bool,
    #[serde(default)]
    pub(super) end_cursor: Option<String>,
}
#[derive(Deserialize)]
pub(super) struct GqlAuthor {
    #[serde(default)]
    pub(super) login: String,
}
