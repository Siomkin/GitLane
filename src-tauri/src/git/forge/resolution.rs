//! libgit2-backed configured-remote enumeration and provider resolution.

mod gh_resolved;

use git2::Repository;

use gh_resolved::gh_resolved_project;

use super::parsing::{
    api_host_for, classify_host, credential_host_for_url, remote_host, remote_path,
};
use super::{ApiAuthority, ForgeKind, RemoteApiAuthority, RemoteForge, RemoteTransportDirection};
use crate::git::types::RepoForge;

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
                let web = remote_path(url).map(|p| {
                    if classify_host(&host) == Some(ForgeKind::CursorOrigin) {
                        format!("{}/{p}", ForgeKind::CURSOR_ORIGIN_WEB_ROOT)
                    } else {
                        format!("https://{host}/{p}")
                    }
                });
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
    configured_remote_name(repo)
}

/// "origin" if the repo has it, else whichever remote is listed first. Split
/// out of [`default_remote_name`] so callers that must reject the current
/// branch's upstream can still finish the same walk.
fn configured_remote_name(repo: &Repository) -> Option<String> {
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

/// The default remote for a push that cannot target git's "." pseudo-remote.
///
/// A branch tracking another *local* branch makes the upstream ".", which is a
/// real operand for a branch push but destructive for a tag: `push --delete .
/// refs/tags/v1` deletes the local tag and leaves the remote copy for the next
/// fetch to resurrect. Falling through to the same origin/first-remote walk
/// keeps the answer the one git would pick — a repo whose only remote is
/// "upstream" must not be told "origin".
pub fn default_push_remote(path: &str) -> Option<String> {
    let repo = Repository::discover(path).ok()?;
    match default_remote_name(&repo) {
        Some(name) if name != "." => Some(name),
        _ => configured_remote_name(&repo),
    }
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

/// Find the remote authority that produced a provider-resolved repository.
/// This lets the PR service distinguish an exact HTTP(S) API authority from an
/// SSH/scp transport hostname before it resolves any selected-account secret.
pub(crate) fn remote_api_authority_for_project(
    path: &str,
    repository_host: &ApiAuthority,
    project: &str,
) -> Option<RemoteApiAuthority> {
    let repo = Repository::discover(path).ok()?;
    let default = default_remote_name(&repo);
    let repository_hostname = repository_host.hostname();
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

/// Resolve the Cursor Origin remote's `(host, owner/name)` for `path`.
pub fn origin_project(path: &str) -> Option<(String, String)> {
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
            let Some(bare_host) = remote_host(url) else {
                continue;
            };
            if classify_host(&bare_host) != Some(ForgeKind::CursorOrigin) {
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

#[cfg(test)]
mod tests {
    use super::*;

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
    fn origin_project_parses_https_and_ssh() {
        let host = ForgeKind::CURSOR_ORIGIN_HOST;
        let https = TempRepo::init("origin-https", &format!("https://{host}/acme/app.git"));
        assert_eq!(
            origin_project(https.0.to_str().unwrap()),
            Some((host.into(), "acme/app".into()))
        );

        let ssh = TempRepo::init("origin-ssh", &format!("git@{host}:acme/app.git"));
        assert_eq!(
            origin_project(ssh.0.to_str().unwrap()),
            Some((host.into(), "acme/app".into()))
        );

        let gh = TempRepo::init("origin-gh", "https://github.com/o/r.git");
        assert_eq!(origin_project(gh.0.to_str().unwrap()), None);
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
    fn gh_resolved_is_ignored_on_a_non_github_remote() {
        // A `gh-resolved` key planted on a GitLab remote (tampered .git/config)
        // must not redirect PR targeting away from the real GitHub remote.
        let repo = TempRepo::init("gh-resolved-gitlab", "https://github.com/me/app.git");
        set_default_remote(
            &repo.0,
            "gl",
            "https://gitlab.com/attacker/evil.git",
            "attacker/evil",
        );
        assert_eq!(
            github_project(repo.0.to_str().unwrap()),
            Some(("github.com".into(), "me/app".into())),
        );
    }

    #[test]
    fn gh_resolved_rejects_malformed_owner_repo_shapes() {
        for bad in ["a/b/c", "/repo", "owner/", "../evil", "owner/.."] {
            let repo = TempRepo::init("gh-resolved-bad", "https://github.com/me/app.git");
            {
                let opened = Repository::open(&repo.0).unwrap();
                opened
                    .config()
                    .unwrap()
                    .set_str("remote.origin.gh-resolved", bad)
                    .unwrap();
            }
            assert_eq!(
                github_project(repo.0.to_str().unwrap()),
                Some(("github.com".into(), "me/app".into())),
                "{bad:?} must be ignored, falling back to the remote's own path",
            );
        }
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
