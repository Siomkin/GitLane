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
        // The default push remote comes first, so it drives the reported provider
        // — matching the Remotes panel and the "default push remote drives
        // pull-request availability" copy. The remaining remotes stay in config
        // order as a fallback (e.g. an unrecognised default + a recognised peer).
        let default = default_remote_name(&repo);
        for name in ordered_remote_names(&repo, default.as_deref()) {
            let Ok(remote) = repo.find_remote(&name) else {
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
    RepoForge {
        has_remote,
        kind: None,
        forge: None,
        host: first_host,
        web_url: first_web,
    }
}

/// Remote names with the default push remote first, then the rest in config
/// order.
fn ordered_remote_names(repo: &Repository, default: Option<&str>) -> Vec<String> {
    let Ok(names) = repo.remotes() else {
        return Vec::new();
    };
    let mut all: Vec<String> = (0..names.len())
        .filter_map(|i| names.get(i).ok().flatten().map(|s| s.to_string()))
        .collect();
    if let Some(d) = default {
        if let Some(pos) = all.iter().position(|n| n == d) {
            let item = all.remove(pos);
            all.insert(0, item);
        }
    }
    all
}

/// The repo's default push remote name: the current branch's upstream remote,
/// else "origin" if configured, else the first remote. Shared by the toolbar
/// provider detection and the Remotes panel's `list_remotes`, so both agree on
/// which remote is "default".
pub(crate) fn default_remote_name(repo: &Repository) -> Option<String> {
    if let Ok(head) = repo.head() {
        if let Ok(branch) = head.shorthand() {
            if let Ok(buf) = repo.branch_upstream_remote(&format!("refs/heads/{branch}")) {
                if let Ok(name) = std::str::from_utf8(&buf) {
                    if !name.is_empty() {
                        return Some(name.to_string());
                    }
                }
            }
        }
    }
    let names = repo.remotes().ok()?;
    for i in 0..names.len() {
        if matches!(names.get(i), Ok(Some("origin"))) {
            return Some("origin".to_string());
        }
    }
    for i in 0..names.len() {
        if let Ok(Some(name)) = names.get(i) {
            return Some(name.to_string());
        }
    }
    None
}

/// The repo's default push remote name resolved from a path (see
/// [`default_remote_name`]). For commands that need a concrete remote when the
/// frontend doesn't pass one (e.g. tag push).
pub fn default_remote(path: &str) -> Option<String> {
    let repo = Repository::discover(path).ok()?;
    default_remote_name(&repo)
}

/// Which configured URL a git transport operation contacts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoteTransportDirection {
    Fetch,
    Push,
}

/// The exact credential authority (`host[:port]`) for the URL a named remote
/// uses in `direction`. Fetch never consults a separate push URL; push prefers
/// it and falls back to the fetch URL, matching git's own remote semantics.
/// Ports are preserved because credential helpers scope by protocol +
/// host/port + username; display/provider matching must normalize separately
/// when it wants a portless host.
pub fn remote_credential_host_for(
    path: &str,
    remote: &str,
    direction: RemoteTransportDirection,
) -> Option<String> {
    let repo = Repository::discover(path).ok()?;
    let remote = repo.find_remote(remote).ok()?;
    let urls = match direction {
        RemoteTransportDirection::Fetch => [remote.url().ok().map(str::to_string), None],
        RemoteTransportDirection::Push => [
            remote.pushurl().ok().flatten().map(str::to_string),
            remote.url().ok().map(str::to_string),
        ],
    };
    urls.into_iter()
        .flatten()
        .find_map(|url| credential_host_for_url(&url))
}

/// The exact credential authority (`host[:port]`) from an HTTPS/SSH/scp remote
/// URL. Userinfo is stripped; ports are preserved.
pub fn credential_host_for_url(url: &str) -> Option<String> {
    let trimmed = url.trim();
    if let Some(rest) = trimmed
        .strip_prefix("https://")
        .or_else(|| trimmed.strip_prefix("http://"))
        .or_else(|| trimmed.strip_prefix("ssh://"))
        .or_else(|| trimmed.strip_prefix("git://"))
    {
        let authority = rest.split('/').next()?.split('@').next_back()?;
        return Some(authority.trim().trim_end_matches('/').to_ascii_lowercase());
    }

    if let Some((user_host, _path)) = trimmed.split_once(':') {
        if user_host.contains('@') {
            let host = user_host.split('@').next_back()?;
            return Some(host.trim().trim_end_matches('/').to_ascii_lowercase());
        }
    }

    None
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
    // Default push remote first (same ordering as `summary`), so error
    // classification reflects the remote that actually drives the operation
    // rather than whichever remote happens to be listed first in config.
    let default = default_remote_name(&repo);
    for name in ordered_remote_names(&repo, default.as_deref()) {
        let Ok(remote) = repo.find_remote(&name) else {
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

/// Resolve the GitHub remote's `(api_authority, owner/repo)` for `path` without
/// invoking `gh`, reading credentials, or making a network request. Known
/// GitHub remotes win; when no configured remote has a recognised forge host,
/// the first parseable remote is retained as a potential GitHub Enterprise
/// Server repository for the gh provider to validate against a bound account.
///
/// HTTP(S) authorities preserve an explicit port. SSH/scp/git remotes return a
/// bare transport hostname because an SSH port is not an HTTPS API port.
pub fn github_project(path: &str) -> Option<(String, String)> {
    let repo = Repository::discover(path).ok()?;
    // `gh repo set-default` is the user's explicit answer to "which repository
    // do this checkout's pull requests belong to". It matters most in a fork
    // clone, where `origin` is the fork but PRs live on the parent: picking the
    // first GitHub remote would silently retarget every PR read *and write* to
    // the fork. gh records the choice in git config, so honour it without
    // spawning gh.
    if let Some(resolved) = gh_resolved_project(&repo) {
        return Some(resolved);
    }
    let default = default_remote_name(&repo);
    let mut unknown = None;
    for name in ordered_remote_names(&repo, default.as_deref()) {
        let Ok(remote) = repo.find_remote(&name) else {
            continue;
        };
        for url in [remote.url().ok(), remote.pushurl().ok().flatten()]
            .into_iter()
            .flatten()
        {
            let Some(host) = remote_host(url) else {
                continue;
            };
            let Some(project) = remote_path(url) else {
                continue;
            };
            let authority = api_host_for(url).unwrap_or_else(|| host.clone());
            match classify_host(&host) {
                Some(ForgeKind::GitHub) => return Some((authority, project)),
                None if unknown.is_none() => unknown = Some((authority, project)),
                _ => {}
            }
        }
    }
    unknown
}

/// The repository `gh repo set-default` bound this checkout to, if any.
///
/// gh writes `remote.<name>.gh-resolved` into the repo's git config with either
/// `base` (that remote *is* the base repository) or an explicit `OWNER/REPO`
/// (the base lives elsewhere — the fork-clone case). The API authority always
/// comes from the annotated remote's own URL, so a self-hosted host and port
/// survive either form.
fn gh_resolved_project(repo: &Repository) -> Option<(String, String)> {
    let config = repo.config().ok()?;
    for name in ordered_remote_names(repo, default_remote_name(repo).as_deref()) {
        let Ok(resolved) = config.get_string(&format!("remote.{name}.gh-resolved")) else {
            continue;
        };
        let resolved = resolved.trim();
        if resolved.is_empty() {
            continue;
        }
        let Ok(remote) = repo.find_remote(&name) else {
            continue;
        };
        let Ok(url) = remote.url() else {
            continue;
        };
        let host = remote_host(url)?;
        let authority = api_host_for(url).unwrap_or(host);
        // `base` means this remote's own project; anything else is an explicit
        // `OWNER/REPO` pointing at a different repository on the same host.
        let project = if resolved.eq_ignore_ascii_case("base") {
            remote_path(url)?
        } else if resolved.contains('/') {
            resolved.to_string()
        } else {
            continue;
        };
        return Some((authority, project));
    }
    None
}

/// Find the remote authority that produced a provider-resolved repository.
/// This lets the PR service distinguish an exact HTTP(S) API authority from an
/// SSH/scp transport hostname before it resolves any selected-account secret.
pub(crate) fn remote_api_authority_for_project(
    path: &str,
    repository_host: &str,
    project: &str,
) -> Option<RemoteApiAuthority> {
    let repo = Repository::discover(path).ok()?;
    let default = default_remote_name(&repo);
    let repository_hostname = authority_hostname(repository_host);
    for name in ordered_remote_names(&repo, default.as_deref()) {
        let Ok(remote) = repo.find_remote(&name) else {
            continue;
        };
        for url in [remote.url().ok(), remote.pushurl().ok().flatten()]
            .into_iter()
            .flatten()
        {
            if remote_path(url).as_deref() != Some(project) {
                continue;
            }
            let Some(host) = remote_host(url) else {
                continue;
            };
            if !host.eq_ignore_ascii_case(repository_hostname) {
                continue;
            }
            if let Some(authority) = api_host_for(url) {
                if authority.eq_ignore_ascii_case(repository_host) {
                    return Some(RemoteApiAuthority::Http(authority));
                }
            } else {
                return Some(RemoteApiAuthority::TransportHost(host));
            }
        }
    }
    None
}

/// Resolve the GitLab remote's `(host, project_path)` for `path`, or `None` when
/// no GitLab remote is configured. `host` is the API authority — a custom HTTPS
/// port is preserved (`gitlab.example.com:8443`) so the REST base URL targets the
/// right endpoint on a self-hosted instance; SSH/scp remotes fall back to the
/// bare host, since their port is the SSH port, not the API port. `project_path`
/// is the full namespace path (`group[/subgroup]/repo`, `.git` stripped), which
/// URL-encoded is GitLab's project id. Pure libgit2 read of the remote URLs; no
/// network. Follows the same default-push-remote-first ordering as [`detect`] so
/// it names the remote that drives the operation.
pub fn gitlab_project(path: &str) -> Option<(String, String)> {
    let repo = Repository::discover(path).ok()?;
    let default = default_remote_name(&repo);
    for name in ordered_remote_names(&repo, default.as_deref()) {
        let Ok(remote) = repo.find_remote(&name) else {
            continue;
        };
        for url in [remote.url().ok(), remote.pushurl().ok().flatten()]
            .into_iter()
            .flatten()
        {
            // Classify on the bare host; return the API host (with HTTPS port).
            let Some(bare_host) = remote_host(url) else {
                continue;
            };
            if classify_host(&bare_host) != Some(ForgeKind::GitLab) {
                continue;
            }
            if let Some(project) = remote_path(url) {
                let host = api_host_for(url).unwrap_or(bare_host);
                return Some((host, project));
            }
        }
    }
    None
}

/// Resolve the Bitbucket Cloud remote's `(host, workspace, repo_slug)` for
/// `path`, or `None` when no Bitbucket remote is configured (GL-141). Bitbucket
/// Cloud repos are always `bitbucket.org/{workspace}/{repo_slug}` — a flat
/// two-segment path with no nested namespaces — so the first path segment is the
/// workspace and the remainder is the slug. `host` is the bare host (the REST API
/// authority is the fixed `api.bitbucket.org`, resolved in the provider, not
/// here). Pure libgit2 read of the remote URLs; no network. Follows the same
/// default-push-remote-first ordering as [`detect`].
pub fn bitbucket_repo(path: &str) -> Option<(String, String, String)> {
    let repo = Repository::discover(path).ok()?;
    let default = default_remote_name(&repo);
    for name in ordered_remote_names(&repo, default.as_deref()) {
        let Ok(remote) = repo.find_remote(&name) else {
            continue;
        };
        for url in [remote.url().ok(), remote.pushurl().ok().flatten()]
            .into_iter()
            .flatten()
        {
            let Some(host) = remote_host(url) else {
                continue;
            };
            if classify_host(&host) != Some(ForgeKind::Bitbucket) {
                continue;
            }
            // A Bitbucket Cloud repo is always `workspace/repo_slug`; a
            // single-segment path is not a valid repo, so skip it (the provider
            // then reports a clear "couldn't resolve a Bitbucket repository"
            // rather than building an invalid API path that 404s).
            if let Some((workspace, slug)) = remote_path(url).and_then(|p| {
                p.split_once('/')
                    .filter(|(w, s)| !w.is_empty() && !s.is_empty())
                    .map(|(w, s)| (w.to_string(), s.to_string()))
            }) {
                return Some((host, workspace, slug));
            }
        }
    }
    None
}

/// The API host for a remote URL, preserving a custom port only for HTTP(S) URLs
/// (whose port is the API port). Returns `None` for SSH/scp/git URLs, whose port
/// is the transport port, not the REST endpoint.
fn api_host_for(url: &str) -> Option<String> {
    let trimmed = url.trim();
    if trimmed.starts_with("https://") || trimmed.starts_with("http://") {
        credential_host_for_url(trimmed)
    } else {
        None
    }
}

fn authority_hostname(authority: &str) -> &str {
    match authority.rsplit_once(':') {
        Some((host, port))
            if !host.is_empty()
                && !port.is_empty()
                && port.bytes().all(|byte| byte.is_ascii_digit()) =>
        {
            host
        }
        _ => authority,
    }
}

fn classify_host(host: &str) -> Option<ForgeKind> {
    let host = normalize_host(host);
    if host == "github.com" || host.ends_with(".github.com") {
        Some(ForgeKind::GitHub)
    } else if host == "gitlab.com" || host.contains("gitlab") {
        Some(ForgeKind::GitLab)
    } else if host == "bitbucket.org" || host.contains("bitbucket") {
        Some(ForgeKind::Bitbucket)
    } else if host == "dev.azure.com"
        || host == "ssh.dev.azure.com"
        || host.ends_with(".visualstudio.com")
    {
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
        assert_eq!(
            remote_host("git@ssh.dev.azure.com:v3/org/project/repo"),
            Some("ssh.dev.azure.com".into())
        );
    }

    #[test]
    fn credential_host_preserves_ports_and_strips_userinfo() {
        assert_eq!(
            credential_host_for_url("https://octo@ghe.example.test:8443/owner/repo.git"),
            Some("ghe.example.test:8443".into())
        );
        assert_eq!(
            credential_host_for_url("ssh://git@gitlab.example.com:2222/group/repo.git"),
            Some("gitlab.example.com:2222".into())
        );
    }

    #[test]
    fn classifies_known_forge_hosts() {
        assert_eq!(classify_host("github.com"), Some(ForgeKind::GitHub));
        assert_eq!(classify_host("gitlab.example.com"), Some(ForgeKind::GitLab));
        assert_eq!(classify_host("bitbucket.org"), Some(ForgeKind::Bitbucket));
        assert_eq!(classify_host("dev.azure.com"), Some(ForgeKind::AzureDevOps));
        // Azure DevOps' own "Clone → SSH" URL uses a dedicated SSH host.
        assert_eq!(
            classify_host("ssh.dev.azure.com"),
            Some(ForgeKind::AzureDevOps)
        );
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

    // --- gitlab_project: parse (host, project_path) from the configured remote ---

    struct TempRepo(std::path::PathBuf);
    impl TempRepo {
        fn init(tag: &str, remote_url: &str) -> Self {
            use std::sync::atomic::{AtomicU32, Ordering};
            static SEQ: AtomicU32 = AtomicU32::new(0);
            let n = SEQ.fetch_add(1, Ordering::Relaxed);
            let dir = std::env::temp_dir()
                .join(format!("gitlane-forge-{tag}-{}-{n}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            let repo = Repository::init(&dir).unwrap();
            repo.remote("origin", remote_url).unwrap();
            TempRepo(dir)
        }
    }
    impl Drop for TempRepo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn gitlab_project_parses_https_ssh_and_preserves_https_port() {
        let https = TempRepo::init("https", "https://gitlab.com/group/repo.git");
        assert_eq!(
            gitlab_project(https.0.to_str().unwrap()),
            Some(("gitlab.com".into(), "group/repo".into()))
        );

        // Nested subgroups keep the full namespace path (the REST project id).
        let ssh = TempRepo::init("ssh", "git@gitlab.com:group/sub/repo.git");
        assert_eq!(
            gitlab_project(ssh.0.to_str().unwrap()),
            Some(("gitlab.com".into(), "group/sub/repo".into()))
        );

        // A custom HTTPS port is preserved so the REST base URL is correct.
        let ported = TempRepo::init("port", "https://gitlab.example.com:8443/team/app.git");
        assert_eq!(
            gitlab_project(ported.0.to_str().unwrap()),
            Some(("gitlab.example.com:8443".into(), "team/app".into()))
        );

        // An SSH custom port is the transport port, not the API port — dropped.
        let ssh_port = TempRepo::init("sshport", "ssh://git@gitlab.example.com:2222/team/app.git");
        assert_eq!(
            gitlab_project(ssh_port.0.to_str().unwrap()),
            Some(("gitlab.example.com".into(), "team/app".into()))
        );

        // A non-GitLab remote yields nothing.
        let gh = TempRepo::init("gh", "https://github.com/o/r.git");
        assert_eq!(gitlab_project(gh.0.to_str().unwrap()), None);
    }

    #[test]
    fn bitbucket_repo_parses_workspace_and_slug_from_https_and_ssh() {
        let https = TempRepo::init("bb-https", "https://bitbucket.org/team/app.git");
        assert_eq!(
            bitbucket_repo(https.0.to_str().unwrap()),
            Some(("bitbucket.org".into(), "team".into(), "app".into()))
        );

        // scp-form SSH remote resolves the same workspace/slug.
        let ssh = TempRepo::init("bb-ssh", "git@bitbucket.org:team/app.git");
        assert_eq!(
            bitbucket_repo(ssh.0.to_str().unwrap()),
            Some(("bitbucket.org".into(), "team".into(), "app".into()))
        );

        // A non-Bitbucket remote yields nothing.
        let gh = TempRepo::init("bb-gh", "https://github.com/o/r.git");
        assert_eq!(bitbucket_repo(gh.0.to_str().unwrap()), None);

        // A malformed single-segment path is not a valid workspace/slug → None,
        // so the provider reports a clear resolution error rather than a bad path.
        let bare = TempRepo::init("bb-bare", "https://bitbucket.org/loneslug.git");
        assert_eq!(bitbucket_repo(bare.0.to_str().unwrap()), None);
    }

    /// Add a second remote and record a `gh repo set-default` choice on it.
    fn set_default_remote(dir: &std::path::Path, name: &str, url: &str, resolved: &str) {
        let repo = Repository::open(dir).unwrap();
        repo.remote(name, url).unwrap();
        repo.config()
            .unwrap()
            .set_str(&format!("remote.{name}.gh-resolved"), resolved)
            .unwrap();
    }

    #[test]
    fn fork_clone_targets_the_gh_set_default_base_repository() {
        // The classic fork layout: `origin` is your fork, `upstream` is the
        // parent where the pull requests actually live.
        let fork = TempRepo::init("gh-fork", "https://github.com/me/app.git");
        set_default_remote(
            &fork.0,
            "upstream",
            "https://github.com/other/app.git",
            "base",
        );
        assert_eq!(
            github_project(fork.0.to_str().unwrap()),
            Some(("github.com".into(), "other/app".into())),
            "PRs must target the set-default base repo, not the fork",
        );
    }

    #[test]
    fn gh_resolved_owner_repo_overrides_the_annotated_remote_path() {
        // gh also records an explicit OWNER/REPO on the remote it resolved
        // through; the authority still comes from that remote's own URL.
        let repo = TempRepo::init(
            "gh-resolved-explicit",
            "https://ghe.example.test:8443/me/app.git",
        );
        {
            let opened = Repository::open(&repo.0).unwrap();
            opened
                .config()
                .unwrap()
                .set_str("remote.origin.gh-resolved", "other/app")
                .unwrap();
        }
        assert_eq!(
            github_project(repo.0.to_str().unwrap()),
            Some(("ghe.example.test:8443".into(), "other/app".into())),
        );
    }

    #[test]
    fn without_gh_resolved_the_default_remote_still_wins() {
        // No set-default recorded → unchanged behaviour.
        let repo = TempRepo::init("gh-no-resolved", "https://github.com/me/app.git");
        set_default_remote(&repo.0, "upstream", "https://github.com/other/app.git", "");
        assert_eq!(
            github_project(repo.0.to_str().unwrap()),
            Some(("github.com".into(), "me/app".into())),
        );
    }
}
