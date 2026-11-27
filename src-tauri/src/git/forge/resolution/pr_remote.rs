//! Match the active PR provider's resolved target repository back to the
//! configured git remote whose effective push URLs all land there.
//!
//! Pure libgit2 read — no network, no tokens. `CreatePrDialog` uses this to
//! ensure auto-publishing a branch lands only in the repository that
//! `create_pr` submits a bare `--head <branch>` against.

use std::fmt::Write as _;

use git2::Repository;
use sha2::{Digest, Sha256};

use super::super::ForgeKind;
use super::super::parsing::{
    api_host_for, authority_port, remote_host, remote_path, unbracketed_hostname,
};
use super::{
    bitbucket_repo_in, default_remote_name, github_project_in, ordered_remote_names, project_for_in,
};

/// The configured remote name whose effective push URLs (`pushurl` entries,
/// else `url` entries, after applying Git's `url.<base>.pushInsteadOf` and
/// `url.<base>.insteadOf` rewrites) all match the repository resolved by the
/// active PR provider, or `None` when no configured remote pushes
/// exclusively to that repository.
pub(super) fn pr_remote_for(
    repo: &Repository,
    target_authority: &str,
    target_project: &str,
) -> Option<String> {
    let cfg = repo.config().ok()?;
    for name in ordered_remote_names(repo, default_remote_name(repo).as_deref()) {
        let Some((urls, is_explicit_pushurl)) = effective_push_urls(repo, &cfg, &name) else {
            continue;
        };
        if !urls.is_empty()
            && urls.iter().all(|url| {
                // Anonymous remotes apply libgit2's URL rewrites without touching config.
                let Ok(remote) = repo.remote_anonymous(url) else {
                    return false;
                };
                let effective = if is_explicit_pushurl {
                    remote.url().ok()
                } else {
                    remote
                        .pushurl()
                        .ok()
                        .flatten()
                        .or_else(|| remote.url().ok())
                };
                effective
                    .is_some_and(|url| url_matches_target(url, target_authority, target_project))
            })
        {
            return Some(name);
        }
    }
    None
}

fn effective_push_urls(
    repo: &Repository,
    cfg: &git2::Config,
    name: &str,
) -> Option<(Vec<String>, bool)> {
    let push_urls = configured_multivar(cfg, &format!("remote.{name}.pushurl"))?;
    if !push_urls.is_empty() {
        return Some((push_urls, true));
    }
    let fetch_urls = configured_multivar(cfg, &format!("remote.{name}.url"))?;
    if !fetch_urls.is_empty() {
        return Some((fetch_urls, false));
    }
    let fallback = repo
        .find_remote(name)
        .ok()
        .and_then(|remote| remote.url().ok().map(str::to_string))
        .into_iter()
        .collect();
    Some((fallback, false))
}

fn configured_multivar(cfg: &git2::Config, key: &str) -> Option<Vec<String>> {
    let mut entries = match cfg.multivar(key, None) {
        Ok(entries) => entries,
        Err(err) if err.code() == git2::ErrorCode::NotFound => return Some(Vec::new()),
        Err(_) => return None,
    };
    let mut urls = Vec::new();
    while let Some(entry) = entries.next() {
        let entry = entry.ok()?;
        let value = entry.value().ok()?;
        if !value.trim().is_empty() {
            urls.push(value.to_string());
        }
    }
    Some(urls)
}

pub(in crate::git::forge) fn url_matches_target(
    url: &str,
    target_authority: &str,
    target_project: &str,
) -> bool {
    let Some(bare_host) = remote_host(url) else {
        return false;
    };
    let Some(project) = remote_path(url) else {
        return false;
    };
    if !project.eq_ignore_ascii_case(target_project) {
        return false;
    }
    if !unbracketed_hostname(&bare_host)
        .eq_ignore_ascii_case(unbracketed_hostname(target_authority))
    {
        return false;
    }
    let Some(push_authority) = api_host_for(url) else {
        // SSH and git transport ports do not identify the forge's HTTP API.
        return true;
    };
    if url.trim_start().starts_with("http://") {
        return false;
    }
    let push_port = authority_port(&push_authority).unwrap_or("443");
    let target_port = authority_port(target_authority).unwrap_or("443");
    push_port
        .parse::<u16>()
        .is_ok_and(|port| target_port.parse::<u16>() == Ok(port))
}

pub(in crate::git::forge) fn repository_fingerprint(authority: &str, project: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(authority.to_ascii_lowercase());
    digest.update([0]);
    digest.update(project);
    let bytes = digest.finalize();
    let mut hex = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(&mut hex, "{byte:02x}");
    }
    hex
}

pub(super) fn resolved_pr_project(repo: &Repository, kind: ForgeKind) -> Option<(String, String)> {
    match kind {
        ForgeKind::GitHub => github_project_in(repo),
        ForgeKind::GitLab | ForgeKind::CursorOrigin => project_for_in(repo, kind),
        ForgeKind::Bitbucket => {
            let (host, workspace, slug) = bitbucket_repo_in(repo)?;
            if !host.eq_ignore_ascii_case("bitbucket.org") {
                return None;
            }
            Some((host, format!("{workspace}/{slug}")))
        }
        ForgeKind::AzureDevOps | ForgeKind::Gitea | ForgeKind::Forgejo | ForgeKind::Other => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::forge::resolution::tests::TempRepo;
    use crate::git::forge::{github_project, summary};

    fn block_on<T>(future: impl std::future::Future<Output = T>) -> T {
        tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap()
            .block_on(future)
    }

    #[test]
    fn pr_push_matches_effective_http_ports_and_ignores_ssh_transport_port() {
        for (url, target, matches) in [
            ("https://gitlab.com/group/app.git", "gitlab.com:443", true),
            ("https://gitlab.com:443/group/app.git", "gitlab.com", true),
            ("https://gitlab.com:8443/group/app.git", "gitlab.com", false),
            ("https://gitlab.com/group/app.git", "gitlab.com:8443", false),
            (
                "https://gitlab.com:8443/group/app.git",
                "gitlab.com:8443",
                true,
            ),
            ("http://gitlab.com/group/app.git", "gitlab.com", false),
            ("http://gitlab.com:443/group/app.git", "gitlab.com", false),
            (
                "http://gitlab.com:8443/group/app.git",
                "gitlab.com:8443",
                false,
            ),
            (
                "ssh://git@gitlab.com:2222/group/app.git",
                "gitlab.com:8443",
                true,
            ),
        ] {
            assert_eq!(
                url_matches_target(url, target, "group/app"),
                matches,
                "{url} vs {target}"
            );
        }
    }

    #[test]
    fn pr_remote_fails_closed_when_a_push_url_is_not_valid_utf8() {
        use std::io::Write as _;

        let repo = TempRepo::init("pr-remote-non-utf8", "https://github.com/me/app.git");
        let mut config = std::fs::OpenOptions::new()
            .append(true)
            .open(repo.0.join(".git/config"))
            .unwrap();
        config
            .write_all(b"\n[remote \"origin\"]\n\tpushurl = https://github.com/me/app.git\n\tpushurl = /tmp/\xff\n")
            .unwrap();
        assert_eq!(summary(repo.0.to_str().unwrap()).pr_remote, None);
    }

    #[test]
    fn pr_publish_rechecks_git_push_urls_after_the_dialog_resolves() {
        let repo = TempRepo::init("pr-publish-recheck", "https://github.com/team/app.git");
        let path = repo.0.to_str().unwrap();
        let original = summary(path);
        assert_eq!(original.pr_remote.as_deref(), Some("origin"));

        let opened = Repository::open(&repo.0).unwrap();
        let mut cfg = opened.config().unwrap();
        for owner in ["fork", "team"] {
            cfg.set_str(
                &format!("url.https://github.com/{owner}/.pushInsteadOf"),
                "https://github.com/team/",
            )
            .unwrap();
        }
        assert_eq!(summary(path).pr_remote, None);

        let error = block_on(crate::commands::remotes::publish_branch(
            path.into(),
            "feature".into(),
            String::new(),
            "origin/feature".into(),
            Some("origin".into()),
            original.pr_repository_id,
            None,
        ))
        .unwrap_err();
        assert_eq!(error.kind, crate::git::types::CommandErrorKind::Forge);
        assert!(
            error
                .message
                .contains("pushes outside the pull request repository")
        );
    }

    #[test]
    fn pr_create_rejects_repository_changed_by_published_tracking() {
        let repo = TempRepo::init("pr-create-after-publish", "https://github.com/team/app.git");
        let path = repo.0.to_str().unwrap();
        let opened = Repository::open(&repo.0).unwrap();
        opened
            .remote_set_pushurl("origin", Some("https://github.com/fork/app.git"))
            .unwrap();
        opened
            .remote("publish", "https://github.com/fork/app.git")
            .unwrap();
        opened
            .remote_set_pushurl("publish", Some("https://github.com/team/app.git"))
            .unwrap();
        let sig = git2::Signature::now("GitLane", "tests@example.invalid").unwrap();
        let tree_id = opened.treebuilder(None).unwrap().write().unwrap();
        let tree = opened.find_tree(tree_id).unwrap();
        opened
            .commit(Some("HEAD"), &sig, &sig, "Initial commit", &tree, &[])
            .unwrap();
        let original = summary(path);
        assert_eq!(original.pr_remote.as_deref(), Some("publish"));

        let branch = opened.head().unwrap().shorthand().unwrap().to_string();
        let mut cfg = opened.config().unwrap();
        cfg.set_str(&format!("branch.{branch}.remote"), "publish")
            .unwrap();
        cfg.set_str(
            &format!("branch.{branch}.merge"),
            &format!("refs/heads/{branch}"),
        )
        .unwrap();
        assert_eq!(github_project(path).unwrap().1, "fork/app");

        let error = block_on(crate::commands::pulls::create_pull_request(
            path.into(),
            crate::git::types::PrCreateInput {
                pr_repository_id: original.pr_repository_id,
                base: "develop".into(),
                head: branch,
                title: String::new(),
                body: String::new(),
                draft: false,
                reviewers: Vec::new(),
            },
            None,
        ))
        .unwrap_err();
        assert_eq!(error.kind, crate::git::types::CommandErrorKind::Forge);
        assert!(error.message.contains("pull request repository changed"));
    }
}
