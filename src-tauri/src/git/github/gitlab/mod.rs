//! GitLab merge-request provider (GL-140).
//!
//! A [`GithubProvider`] implementation for GitLab, selected by [`super::service`]
//! when the repo's remote is a GitLab host. It reuses the provider-neutral
//! `PullRequest*` DTOs and the existing PR list/detail UI unchanged — only the
//! transport and JSON mapping are GitLab-specific.
//!
//! Transport is chosen per operation ([`GitLabProvider::select`]):
//! - a GitLane-owned keychain token for the bound account (OAuth from GL-139 or a
//!   PAT from GL-132) authenticates the direct REST v4 client — the explicit,
//!   user-provided credential wins when present (mirroring how
//!   `transport_auth::credential_for_url` prefers an owned provider token);
//! - otherwise `glab`, when installed, provides zero-config transport (it owns its
//!   own token and host config).
//!
//! The five in-scope actions (list, show + diff, create, merge, approve) live in
//! [`ops`]; out-of-scope PR paths (comments, review threads, close/reopen) return
//! an explicit "not supported yet".

mod dto;
mod ops;
mod transport;

use crate::git::forge;
use crate::git::oauth::http::UreqTransport;
use crate::git::types::{
    FileDiff, GithubAccountRef, PrCommitList, PrCreateInput, PullRequestDetail,
    PullRequestMergeOutcome, PullRequestSummary,
};
use crate::secrets::{KeyringStore, SecretKey, SecretStore};

use super::domain::{GithubContext, GithubError, GithubRepository};
use super::service::{ForgeIdentity, GithubProvider};

use self::ops::project_id;
use self::transport::{GitlabApi, GlabCli, RestClient};

/// Provider family key for the OS keychain: GitLab tokens (OAuth or PAT) are
/// stored under this provider by GL-132/GL-139, regardless of how the crossing
/// account ref labels its own `provider` field.
const GITLAB_PROVIDER: &str = "gitlab";

pub struct GitLabProvider;

/// The chosen transport for one operation. `Rest` carries the resolved keychain
/// token (held only for the duration of the call).
enum Selected {
    Glab,
    Rest(String),
}

impl GitLabProvider {
    /// Pick the transport for `ctx`: a keychain token for the bound account (→
    /// REST), else `glab` when installed (→ zero-config). Errors with an
    /// actionable message when neither is available.
    fn select(&self, ctx: &GithubContext) -> Result<Selected, GithubError> {
        if let Some(account) = ctx.account.as_ref() {
            let key = SecretKey::new(GITLAB_PROVIDER, &account.host, &account.account_id);
            match KeyringStore::new().get(&key) {
                Ok(Some(token)) => return Ok(Selected::Rest(token)),
                // The account was named but its token is gone (deleted outside
                // GitLane) — fall through to glab rather than hard-failing.
                Ok(None) => {}
                Err(e) => return Err(GithubError::CommandFailed(e.into())),
            }
        }
        if transport::glab_available() {
            return Ok(Selected::Glab);
        }
        // GitLab-specific guidance — never the gh-worded NotAuthenticated string.
        Err(no_gitlab_auth(&ctx.repository.host))
    }

    /// Resolve the transport and run `f` against it with the project id, so every
    /// operation shares transport selection. The REST client's `UreqTransport`
    /// and token live only for the call.
    fn with_api<T>(
        &self,
        ctx: &GithubContext,
        f: impl FnOnce(&dyn GitlabApi, &str) -> Result<T, GithubError>,
    ) -> Result<T, GithubError> {
        let id = project_id(&ctx.repository.owner, &ctx.repository.name);
        match self.select(ctx)? {
            Selected::Glab => {
                let api = GlabCli::new(&ctx.workdir);
                f(&api, &id)
            }
            Selected::Rest(token) => {
                let http = UreqTransport::new();
                let api = RestClient::new(&http, &ctx.repository.host, &token);
                f(&api, &id)
            }
        }
    }
}

impl GithubProvider for GitLabProvider {
    fn identity(&self) -> ForgeIdentity {
        ForgeIdentity {
            key: GITLAB_PROVIDER,
            label: "GitLab",
            pr_noun: "merge request",
        }
    }

    fn resolve_repository(
        &self,
        workdir: &str,
        _account: Option<&GithubAccountRef>,
    ) -> Result<GithubRepository, GithubError> {
        // Pure libgit2 read of the remote URL — no token, no network. The full
        // namespace path becomes the REST project id; keep the last segment as
        // `name` and the namespace as `owner` so the shared repository shape holds.
        let (host, project) = forge::gitlab_project(workdir).ok_or_else(|| {
            GithubError::CommandFailed(format!(
                "Could not resolve a GitLab project for {workdir}. Check that the repo has a GitLab remote."
            ))
        })?;
        let (owner, name) = project
            .rsplit_once('/')
            .map(|(o, n)| (o.to_string(), n.to_string()))
            .unwrap_or_else(|| (String::new(), project.clone()));
        Ok(GithubRepository { host, owner, name })
    }

    fn list_prs(&self, ctx: &GithubContext) -> Result<Vec<PullRequestSummary>, GithubError> {
        self.with_api(ctx, |api, id| ops::list_prs(api, id))
    }

    fn pr_detail(
        &self,
        ctx: &GithubContext,
        number: u64,
    ) -> Result<PullRequestDetail, GithubError> {
        self.with_api(ctx, |api, id| ops::pr_detail(api, id, number))
    }

    fn pr_commits(&self, ctx: &GithubContext, number: u64) -> Result<PrCommitList, GithubError> {
        self.with_api(ctx, |api, id| ops::pr_commits(api, id, number))
    }

    fn pr_diff(&self, ctx: &GithubContext, number: u64) -> Result<Vec<FileDiff>, GithubError> {
        self.with_api(ctx, |api, id| ops::pr_diff(api, id, number))
    }

    fn merge_pr(
        &self,
        ctx: &GithubContext,
        number: u64,
        method: &str,
        delete_branch: bool,
    ) -> Result<PullRequestMergeOutcome, GithubError> {
        // GitLab's merge API applies `should_remove_source_branch` server-side
        // and reports no partial outcome, so there is nothing to warn about.
        self.with_api(ctx, |api, id| {
            ops::merge_pr(api, id, number, method, delete_branch)
        })
        .map(|_| PullRequestMergeOutcome::default())
    }

    fn review_pr(
        &self,
        ctx: &GithubContext,
        number: u64,
        action: &str,
        _body: &str,
    ) -> Result<String, GithubError> {
        self.with_api(ctx, |api, id| ops::review_pr(api, id, number, action))
    }

    fn create_pr(&self, ctx: &GithubContext, input: &PrCreateInput) -> Result<String, GithubError> {
        self.with_api(ctx, |api, id| {
            ops::create_pr(
                api,
                id,
                &input.base,
                &input.head,
                &input.title,
                &input.body,
                input.draft,
            )
        })
    }
}

/// GitLab-specific "no authentication available" guidance — used instead of the
/// gh-worded `NotAuthenticated` so GitLab users get the right recovery steps.
pub(super) fn no_gitlab_auth(host: &str) -> GithubError {
    GithubError::CommandFailed(format!(
        "No GitLab sign-in found for {host}. Run `glab auth login` to use merge requests. GCM/helper or SSH can still handle git transport."
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_gitlab_auth_names_glab_and_git_transport_fallbacks_not_gh() {
        let msg = no_gitlab_auth("gitlab.example.com").to_ipc_string();
        assert!(msg.contains("glab auth login"), "{msg}");
        assert!(msg.contains("GCM/helper or SSH"), "{msg}");
        assert!(
            !msg.contains("token"),
            "hidden token path should not be advertised: {msg}"
        );
        assert!(!msg.contains("gh auth"), "must not suggest gh: {msg}");
        assert!(msg.contains("gitlab.example.com"), "{msg}");
    }
}
