//! Account and collaborator user shapes (`GhUser` is shared with the
//! `cli` module for authenticated-user lookup).

use serde::Deserialize;

#[derive(Deserialize)]
pub(in crate::git::forge) struct GhUser {
    pub(in crate::git::forge) login: String,
    #[serde(default)]
    pub(in crate::git::forge) name: Option<String>,
    #[serde(default)]
    pub(in crate::git::forge) email: Option<String>,
    pub(in crate::git::forge) id: u64,
}

/// A `repos/{owner}/{repo}/collaborators` entry — the reviewer-picker source.
#[derive(Deserialize, Default)]
pub(in crate::git::forge) struct GhCollaborator {
    #[serde(default)]
    pub(in crate::git::forge) login: String,
    #[serde(default)]
    pub(in crate::git::forge) name: Option<String>,
    #[serde(default)]
    pub(in crate::git::forge) avatar_url: Option<String>,
}
