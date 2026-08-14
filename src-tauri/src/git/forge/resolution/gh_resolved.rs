//! `gh repo set-default` resolution: the repository a checkout's pull requests
//! belong to, read from git config without spawning `gh`.

use git2::Repository;

use super::super::parsing::{api_host_for, classify_host, remote_host, remote_path};
use super::super::ForgeKind;
use super::{default_remote_name, ordered_remote_names};

/// Whether `value` is exactly `OWNER/REPO` — two non-empty, non-dot-segment
/// components. `gh_provider` later splits on the first `/`, so an unvalidated
/// `a/b/c` would silently become the repo name `b/c`.
fn is_owner_repo(value: &str) -> bool {
    let mut parts = value.split('/');
    let (Some(owner), Some(repo), None) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    [owner, repo]
        .iter()
        .all(|part| !part.is_empty() && *part != "." && *part != "..")
}

/// The repository `gh repo set-default` bound this checkout to, if any.
///
/// gh writes `remote.<name>.gh-resolved` into the repo's git config with either
/// `base` (that remote *is* the base repository) or an explicit `OWNER/REPO`
/// (the base lives elsewhere — the fork-clone case). The API authority always
/// comes from the annotated remote's own URL, so a self-hosted host and port
/// survive either form.
pub(super) fn gh_resolved_project(repo: &Repository) -> Option<(String, String)> {
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
        // `continue`, not `?`: one unparseable annotated remote must not hide a
        // valid `gh-resolved` on a later one.
        let Some(host) = remote_host(url) else {
            continue;
        };
        // Only honour the annotation on a remote gh could plausibly own —
        // GitHub, or an unrecognised host that may be GitHub Enterprise (the
        // same fallback `github_project` itself uses). A `gh-resolved` key
        // planted on a GitLab/Bitbucket remote must not redirect PR targeting.
        if !matches!(classify_host(&host), Some(ForgeKind::GitHub) | None) {
            continue;
        }
        let authority = api_host_for(url).unwrap_or(host);
        // `base` means this remote's own project; anything else is an explicit
        // `OWNER/REPO` pointing at a different repository on the same host.
        let project = if resolved.eq_ignore_ascii_case("base") {
            match remote_path(url) {
                Some(path) => path,
                None => continue,
            }
        } else if is_owner_repo(resolved) {
            resolved.to_string()
        } else {
            continue;
        };
        return Some((authority, project));
    }
    None
}
