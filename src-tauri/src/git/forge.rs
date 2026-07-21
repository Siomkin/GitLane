//! Remote forge detection shared by provider-specific integrations.
//!
//! This facade keeps the stable `git::forge` API while parsing and libgit2
//! remote resolution live in focused sibling modules. It identifies the forge
//! family from configured remote URLs so unsupported providers can fail with a
//! precise message instead of a generic GitHub/`gh` error. It does not perform
//! authentication or API calls for those forges.

mod parsing;
mod resolution;

pub use parsing::credential_host_for_url;
pub(crate) use parsing::{authority_hostname, unbracketed_hostname};
pub use resolution::{
    bitbucket_repo, default_remote, detect, github_project, gitlab_project,
    remote_credential_host_for, summary,
};
pub(crate) use resolution::{default_remote_name, remote_api_authority_for_project};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteForge {
    pub kind: ForgeKind,
    pub host: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ForgeKind {
    GitHub,
    GitLab,
    Bitbucket,
    AzureDevOps,
    Gitea,
    Forgejo,
}

/// Authority information carried by a repository remote. HTTP(S) URLs name the
/// exact API authority, including an explicit port. SSH/scp/git URLs name only a
/// transport host; their port (when present) is not an HTTPS API port.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RemoteApiAuthority {
    Http(String),
    TransportHost(String),
}

impl ForgeKind {
    pub fn label(&self) -> &'static str {
        match self {
            Self::GitHub => "GitHub",
            Self::GitLab => "GitLab",
            Self::Bitbucket => "Bitbucket",
            Self::AzureDevOps => "Azure DevOps",
            Self::Gitea => "Gitea",
            Self::Forgejo => "Forgejo",
        }
    }

    /// Stable lowercase key for the frontend to switch on.
    pub fn key(&self) -> &'static str {
        match self {
            Self::GitHub => "github",
            Self::GitLab => "gitlab",
            Self::Bitbucket => "bitbucket",
            Self::AzureDevOps => "azure-devops",
            Self::Gitea => "gitea",
            Self::Forgejo => "forgejo",
        }
    }
}

/// Which configured URL a git transport operation contacts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoteTransportDirection {
    Fetch,
    Push,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exposes_stable_lowercase_keys() {
        assert_eq!(ForgeKind::GitHub.key(), "github");
        assert_eq!(ForgeKind::GitLab.key(), "gitlab");
        assert_eq!(ForgeKind::Bitbucket.key(), "bitbucket");
        assert_eq!(ForgeKind::AzureDevOps.key(), "azure-devops");
        assert_eq!(ForgeKind::Gitea.key(), "gitea");
        assert_eq!(ForgeKind::Forgejo.key(), "forgejo");
    }
}
