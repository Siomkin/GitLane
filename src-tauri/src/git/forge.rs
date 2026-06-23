//! Remote forge detection shared by provider-specific integrations.
//!
//! This is intentionally narrow: it identifies the forge family from configured
//! remote URLs so unsupported providers can fail with a precise message instead
//! of a generic GitHub/`gh` error. It does not perform authentication or API
//! calls for those forges.

use git2::Repository;

use crate::git::types::RepoForge;

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

/// Forge summary for the toolbar provider indicator: whether the repo has a
/// remote at all and, if its host is recognised, which forge family it belongs
/// to. Pure libgit2 read — no network or auth probing. `has_remote: false`
/// means no remote URL is configured (the "missing" state); a remote with an
/// unrecognised host yields `has_remote: true` with `kind: None`.
pub fn summary(path: &str) -> RepoForge {
    let mut has_remote = false;
    let mut first_host: Option<String> = None;
    let mut first_web: Option<String> = None;
    if let Ok(repo) = Repository::discover(path) {
        if let Ok(remotes) = repo.remotes() {
            for name in remotes.iter().filter_map(|entry| entry.ok().flatten()) {
                let Ok(remote) = repo.find_remote(name) else {
                    continue;
                };
                for url in [remote.url().ok(), remote.pushurl().ok().flatten()]
                    .into_iter()
                    .flatten()
                {
                    if url.trim().is_empty() {
                        continue;
                    }
                    has_remote = true;
                    let Some(host) = remote_host(url) else {
                        continue;
                    };
                    let web = remote_path(url).map(|p| format!("https://{host}/{p}"));
                    if first_host.is_none() {
                        first_host = Some(host.clone());
                        first_web = web.clone();
                    }
                    if let Some(kind) = classify_host(&host) {
                        return RepoForge {
                            has_remote: true,
                            kind: Some(kind.key().to_string()),
                            forge: Some(kind.label().to_string()),
                            host: Some(host),
                            web_url: web,
                        };
                    }
                }
            }
        }
    }
    RepoForge {
        has_remote,
        kind: None,
        forge: None,
        host: first_host,
        web_url: first_web,
    }
}

/// Extract the `owner/repo` path from a remote URL (scheme/host stripped,
/// trailing `.git` removed). Returns None when no path component is present.
fn remote_path(url: &str) -> Option<String> {
    let trimmed = url.trim();
    let rest = if let Some(after) = trimmed
        .strip_prefix("https://")
        .or_else(|| trimmed.strip_prefix("http://"))
        .or_else(|| trimmed.strip_prefix("ssh://"))
        .or_else(|| trimmed.strip_prefix("git://"))
    {
        // authority/path — drop the authority up to the first slash.
        let slash = after.find('/')?;
        &after[slash + 1..]
    } else {
        // scp-like form: git@host:owner/repo.git
        trimmed.split_once(':')?.1
    };
    let path = rest.trim_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    if path.is_empty() {
        None
    } else {
        Some(path.to_string())
    }
}

pub fn detect(path: &str) -> Option<RemoteForge> {
    let repo = Repository::discover(path).ok()?;
    let remotes = repo.remotes().ok()?;
    for name in remotes.iter().filter_map(|entry| entry.ok().flatten()) {
        let Ok(remote) = repo.find_remote(name) else {
            continue;
        };
        for url in [remote.url().ok(), remote.pushurl().ok().flatten()]
            .into_iter()
            .flatten()
        {
            let Some(host) = remote_host(url) else {
                continue;
            };
            if let Some(kind) = classify_host(&host) {
                return Some(RemoteForge { kind, host });
            }
        }
    }
    None
}

fn classify_host(host: &str) -> Option<ForgeKind> {
    let host = normalize_host(host);
    if host == "github.com" || host.ends_with(".github.com") {
        Some(ForgeKind::GitHub)
    } else if host == "gitlab.com" || host.contains("gitlab") {
        Some(ForgeKind::GitLab)
    } else if host == "bitbucket.org" || host.contains("bitbucket") {
        Some(ForgeKind::Bitbucket)
    } else if host == "dev.azure.com" || host.ends_with(".visualstudio.com") {
        Some(ForgeKind::AzureDevOps)
    } else if host == "codeberg.org" || host.contains("forgejo") {
        Some(ForgeKind::Forgejo)
    } else if host.contains("gitea") {
        Some(ForgeKind::Gitea)
    } else {
        None
    }
}

fn remote_host(url: &str) -> Option<String> {
    let trimmed = url.trim();
    if let Some(rest) = trimmed
        .strip_prefix("https://")
        .or_else(|| trimmed.strip_prefix("http://"))
        .or_else(|| trimmed.strip_prefix("ssh://"))
        .or_else(|| trimmed.strip_prefix("git://"))
    {
        let authority = rest.split('/').next()?.split('@').next_back()?;
        return Some(normalize_host(
            authority.split(':').next().unwrap_or(authority),
        ));
    }

    if let Some((user_host, _path)) = trimmed.split_once(':') {
        if user_host.contains('@') {
            let host = user_host.split('@').next_back()?;
            return Some(normalize_host(host));
        }
    }

    None
}

fn normalize_host(host: &str) -> String {
    host.trim().trim_end_matches('/').to_ascii_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_common_remote_url_forms() {
        assert_eq!(
            remote_host("https://github.com/owner/repo.git"),
            Some("github.com".into())
        );
        assert_eq!(
            remote_host("git@bitbucket.org:team/repo.git"),
            Some("bitbucket.org".into())
        );
        assert_eq!(
            remote_host("ssh://git@gitlab.example.com/group/repo.git"),
            Some("gitlab.example.com".into())
        );
    }

    #[test]
    fn classifies_known_forge_hosts() {
        assert_eq!(classify_host("github.com"), Some(ForgeKind::GitHub));
        assert_eq!(classify_host("gitlab.example.com"), Some(ForgeKind::GitLab));
        assert_eq!(classify_host("bitbucket.org"), Some(ForgeKind::Bitbucket));
        assert_eq!(classify_host("dev.azure.com"), Some(ForgeKind::AzureDevOps));
        assert_eq!(classify_host("codeberg.org"), Some(ForgeKind::Forgejo));
        assert_eq!(classify_host("gitea.company.test"), Some(ForgeKind::Gitea));
    }

    #[test]
    fn parses_owner_repo_path_from_remote_urls() {
        assert_eq!(
            remote_path("https://github.com/owner/repo.git").as_deref(),
            Some("owner/repo")
        );
        assert_eq!(
            remote_path("git@bitbucket.org:team/repo.git").as_deref(),
            Some("team/repo")
        );
        assert_eq!(
            remote_path("ssh://git@gitlab.example.com/group/sub/repo.git").as_deref(),
            Some("group/sub/repo")
        );
    }

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
