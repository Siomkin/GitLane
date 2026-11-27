//! Match the active PR provider's resolved target repository back to the
//! configured git remote whose effective push URLs all land there.
//!
//! Pure libgit2 read — no network, no tokens. `CreatePrDialog` uses this to
//! ensure auto-publishing a branch lands only in the repository that
//! `create_pr` submits a bare `--head <branch>` against.

use git2::Repository;

use super::super::ForgeKind;
use super::super::parsing::{api_host_for, authorities_match, remote_host, remote_path};
use super::{
    bitbucket_repo_in, default_remote_name, github_project_in, ordered_remote_names, project_for_in,
};

/// The configured remote name whose effective push URLs (`pushurl` entries,
/// else `url` entries, after applying Git's `url.<base>.pushInsteadOf` and
/// `url.<base>.insteadOf` rewrites) all match the repository resolved by the
/// active PR provider for `kind`, or `None` when no configured remote pushes
/// exclusively to that repository.
pub(super) fn pr_remote_for(repo: &Repository, kind: ForgeKind) -> Option<String> {
    let (target_authority, target_project) = resolved_pr_project(repo, kind)?;
    let rewrites = url_rewrites(repo);

    for name in ordered_remote_names(repo, default_remote_name(repo).as_deref()) {
        let (urls, is_explicit_pushurl) = effective_push_urls(repo, &name);
        if !urls.is_empty()
            && urls.iter().all(|url| {
                let effective = apply_push_rewrites(url, is_explicit_pushurl, &rewrites);
                url_matches_target(&effective, &target_authority, &target_project)
            })
        {
            return Some(name);
        }
    }
    None
}

struct UrlRewrites {
    instead_of: Vec<(String, String)>,
    push_instead_of: Vec<(String, String)>,
}

fn url_rewrites(repo: &Repository) -> UrlRewrites {
    let mut out = UrlRewrites {
        instead_of: Vec::new(),
        push_instead_of: Vec::new(),
    };
    let Ok(cfg) = repo.config() else {
        return out;
    };
    let Ok(mut entries) = cfg.entries(Some("url.*")) else {
        return out;
    };
    while let Some(entry) = entries.next() {
        let Ok(entry) = entry else { continue };
        let Ok(name) = entry.name() else { continue };
        let Ok(value) = entry.value() else { continue };
        if value.is_empty() {
            continue;
        }
        let Some(rest) = name.strip_prefix("url.") else {
            continue;
        };
        if let Some(base) = rest.strip_suffix(".pushinsteadof") {
            out.push_instead_of
                .push((value.to_string(), base.to_string()));
        } else if let Some(base) = rest.strip_suffix(".insteadof") {
            out.instead_of.push((value.to_string(), base.to_string()));
        }
    }
    out
}

/// Apply Git's `url.<base>.pushInsteadOf` (for `remote.<name>.url` only) and
/// `url.<base>.insteadOf` (for both `url` and `pushurl`), longest prefix first.
fn apply_push_rewrites(url: &str, is_explicit_pushurl: bool, rewrites: &UrlRewrites) -> String {
    if !is_explicit_pushurl
        && let Some(rewritten) = longest_prefix_rewrite(url, &rewrites.push_instead_of)
    {
        return rewritten;
    }
    longest_prefix_rewrite(url, &rewrites.instead_of).unwrap_or_else(|| url.to_string())
}

fn longest_prefix_rewrite(url: &str, rules: &[(String, String)]) -> Option<String> {
    rules
        .iter()
        .filter(|(prefix, _)| url.starts_with(prefix.as_str()))
        .max_by_key(|(prefix, _)| prefix.len())
        .map(|(prefix, base)| format!("{base}{}", &url[prefix.len()..]))
}

fn effective_push_urls(repo: &Repository, name: &str) -> (Vec<String>, bool) {
    let push_urls = configured_multivar(repo, &format!("remote.{name}.pushurl"));
    if !push_urls.is_empty() {
        return (push_urls, true);
    }
    let fetch_urls = configured_multivar(repo, &format!("remote.{name}.url"));
    if !fetch_urls.is_empty() {
        return (fetch_urls, false);
    }
    let fallback = repo
        .find_remote(name)
        .ok()
        .and_then(|remote| remote.url().ok().map(str::to_string))
        .into_iter()
        .collect();
    (fallback, false)
}

fn configured_multivar(repo: &Repository, key: &str) -> Vec<String> {
    let Ok(cfg) = repo.config() else {
        return Vec::new();
    };
    let Ok(mut entries) = cfg.multivar(key, None) else {
        return Vec::new();
    };
    let mut urls = Vec::new();
    while let Some(entry) = entries.next() {
        if let Ok(entry) = entry
            && let Ok(value) = entry.value()
            && !value.trim().is_empty()
        {
            urls.push(value.to_string());
        }
    }
    urls
}

fn url_matches_target(url: &str, target_authority: &str, target_project: &str) -> bool {
    let Some(bare_host) = remote_host(url) else {
        return false;
    };
    let Some(project) = remote_path(url) else {
        return false;
    };
    if !project.eq_ignore_ascii_case(target_project) {
        return false;
    }
    let host_or_authority = api_host_for(url).unwrap_or(bare_host);
    authorities_match(&host_or_authority, target_authority)
}

fn resolved_pr_project(repo: &Repository, kind: ForgeKind) -> Option<(String, String)> {
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
