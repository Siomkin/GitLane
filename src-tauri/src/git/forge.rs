//! Remote forge detection shared by provider-specific integrations.
//!
//! This is intentionally narrow: it identifies the forge family from configured
//! remote URLs so unsupported providers can fail with a precise message instead
//! of a generic GitHub/`gh` error. It does not perform authentication or API
//! calls for those forges.

use git2::Repository;

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
}

pub fn detect(path: &str) -> Option<RemoteForge> {
    let repo = Repository::discover(path).ok()?;
    let remotes = repo.remotes().ok()?;
    for name in remotes.iter().flatten() {
        let Ok(remote) = repo.find_remote(name) else {
            continue;
        };
        for url in [remote.url(), remote.pushurl()].into_iter().flatten() {
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
}
