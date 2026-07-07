//! Bitbucket Cloud pull-request provider (GL-141).
//!
//! A [`GithubProvider`] implementation for Bitbucket Cloud, selected by
//! [`super::service`] when the repo's remote is a Bitbucket host. It reuses the
//! provider-neutral `PullRequest*` DTOs and the existing PR list/detail UI
//! unchanged — only the transport and JSON mapping are Bitbucket-specific.
//!
//! Unlike GitLab (which can fall back to the `glab` CLI), Bitbucket ships no
//! first-party CLI, so there is a single transport: the direct REST v2 client in
//! [`transport`], authenticating with a GitLane-owned keychain token (an OAuth
//! access token from GL-139 or a Bitbucket Access Token from GL-132). The token
//! is resolved from the keychain immediately before the operation and lives only
//! for the call — it never crosses IPC.
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
    FileDiff, GithubAccount, GithubAccountRef, PrCheck, PrCommit, PullRequestDetail,
    PullRequestSummary, ReviewThread,
};
use crate::secrets::{KeyringStore, SecretKey, SecretStore};

use super::domain::{GithubContext, GithubError, GithubRepository};
use super::service::GithubProvider;

use self::transport::RestClient;

/// Provider family key for the OS keychain: Bitbucket tokens (OAuth or an access
/// token) are stored under this provider by GL-132/GL-139, regardless of how the
/// crossing account ref labels its own `provider` field.
const BITBUCKET_PROVIDER: &str = "bitbucket";

pub struct BitbucketProvider;

impl BitbucketProvider {
    /// Resolve the keychain token for the bound account, or an actionable error
    /// when no account is bound or its token is missing. Bitbucket has no CLI
    /// fallback, so a GitLane-owned token is required for any PR operation.
    fn token(&self, ctx: &GithubContext) -> Result<String, GithubError> {
        let account = ctx
            .account
            .as_ref()
            .ok_or_else(|| no_bitbucket_auth(&ctx.repository.host))?;
        let key = SecretKey::new(BITBUCKET_PROVIDER, &account.host, &account.account_id);
        match KeyringStore::new().get(&key) {
            Ok(Some(token)) => Ok(token),
            Ok(None) => Err(no_bitbucket_auth(&ctx.repository.host)),
            Err(e) => Err(GithubError::CommandFailed(e.into())),
        }
    }

    /// Resolve the token and run `f` against a REST client with the repo base
    /// path (`repositories/{workspace}/{slug}`). The `UreqTransport` and token
    /// live only for the call.
    fn with_api<T>(
        &self,
        ctx: &GithubContext,
        f: impl FnOnce(&dyn transport::BitbucketApi, &str) -> Result<T, GithubError>,
    ) -> Result<T, GithubError> {
        let token = self.token(ctx)?;
        let repo = ops::repo_path(&ctx.repository.owner, &ctx.repository.name);
        let http = UreqTransport::new();
        let api = RestClient::new(&http, &ctx.repository.host, &token);
        f(&api, &repo)
    }
}

impl GithubProvider for BitbucketProvider {
    fn kind(&self) -> &'static str {
        BITBUCKET_PROVIDER
    }

    fn accounts(&self) -> Result<Vec<GithubAccount>, GithubError> {
        // Bitbucket accounts are surfaced through the forge-auth / OAuth flows,
        // not this gh-shaped account list — the service only calls the gh
        // provider's `accounts()` directly, never this one via dispatch.
        Ok(Vec::new())
    }

    fn resolve_repository(
        &self,
        workdir: &str,
        _account: Option<&GithubAccountRef>,
    ) -> Result<GithubRepository, GithubError> {
        // Pure libgit2 read of the remote URL — no token, no network. Bitbucket
        // Cloud repos are `workspace/repo_slug`, mapped to owner/name.
        let (host, workspace, slug) = forge::bitbucket_repo(workdir).ok_or_else(|| {
            GithubError::CommandFailed(format!(
                "Could not resolve a Bitbucket repository for {workdir}. Check that the repo has a Bitbucket remote."
            ))
        })?;
        // Only Bitbucket Cloud (bitbucket.org) is supported — Server/Data Center
        // has a different REST API and auth. Reject a self-hosted host with a
        // clear message instead of misrouting it to the cloud API (GL-141).
        if !host.eq_ignore_ascii_case("bitbucket.org") {
            return Err(GithubError::CommandFailed(format!(
                "GitLane supports Bitbucket Cloud (bitbucket.org); the Bitbucket Server/Data Center host {host} isn't supported yet."
            )));
        }
        Ok(GithubRepository {
            host,
            owner: workspace,
            name: slug,
        })
    }

    fn list_prs(&self, ctx: &GithubContext) -> Result<Vec<PullRequestSummary>, GithubError> {
        self.with_api(ctx, |api, repo| ops::list_prs(api, repo))
    }

    fn pr_detail(
        &self,
        ctx: &GithubContext,
        number: u64,
    ) -> Result<PullRequestDetail, GithubError> {
        self.with_api(ctx, |api, repo| ops::pr_detail(api, repo, number))
    }

    fn pr_checks(&self, _ctx: &GithubContext, _number: u64) -> Result<Vec<PrCheck>, GithubError> {
        // Build-status checks are a follow-up (not one of the five basic
        // actions); return an empty set so the Checks tab shows "no checks".
        Ok(Vec::new())
    }

    fn pr_commits(&self, ctx: &GithubContext, number: u64) -> Result<Vec<PrCommit>, GithubError> {
        self.with_api(ctx, |api, repo| ops::pr_commits(api, repo, number))
    }

    fn pr_diff(&self, ctx: &GithubContext, number: u64) -> Result<Vec<FileDiff>, GithubError> {
        self.with_api(ctx, |api, repo| ops::pr_diff(api, repo, number))
    }

    fn review_threads(
        &self,
        _ctx: &GithubContext,
        _number: u64,
    ) -> Result<Vec<ReviewThread>, GithubError> {
        // Inline review threads are out of scope for GL-141; report none so the
        // detail view simply omits the threads section.
        Ok(Vec::new())
    }

    fn set_thread_resolved(
        &self,
        _ctx: &GithubContext,
        _thread_id: &str,
        _resolved: bool,
    ) -> Result<String, GithubError> {
        Err(ops::unsupported(
            "Resolving Bitbucket pull-request threads isn't supported in GitLane yet.",
        ))
    }

    fn reply_thread(
        &self,
        _ctx: &GithubContext,
        _thread_id: &str,
        _body: &str,
    ) -> Result<String, GithubError> {
        Err(ops::unsupported(
            "Replying to Bitbucket pull-request threads isn't supported in GitLane yet.",
        ))
    }

    fn merge_pr(
        &self,
        ctx: &GithubContext,
        number: u64,
        method: &str,
        delete_branch: bool,
    ) -> Result<String, GithubError> {
        self.with_api(ctx, |api, repo| {
            ops::merge_pr(api, repo, number, method, delete_branch)
        })
    }

    fn comment_pr(
        &self,
        _ctx: &GithubContext,
        _number: u64,
        _body: &str,
    ) -> Result<String, GithubError> {
        Err(ops::unsupported(
            "Commenting on Bitbucket pull requests isn't supported in GitLane yet.",
        ))
    }

    fn review_pr(
        &self,
        ctx: &GithubContext,
        number: u64,
        action: &str,
        _body: &str,
    ) -> Result<String, GithubError> {
        self.with_api(ctx, |api, repo| ops::review_pr(api, repo, number, action))
    }

    fn set_pr_state(
        &self,
        _ctx: &GithubContext,
        _number: u64,
        _action: &str,
    ) -> Result<String, GithubError> {
        Err(ops::unsupported(
            "Closing or reopening Bitbucket pull requests isn't supported in GitLane yet.",
        ))
    }

    fn create_pr(
        &self,
        ctx: &GithubContext,
        base: &str,
        head: &str,
        title: &str,
        body: &str,
        draft: bool,
    ) -> Result<String, GithubError> {
        self.with_api(ctx, |api, repo| {
            ops::create_pr(api, repo, base, head, title, body, draft)
        })
    }
}

/// Bitbucket-specific "no authentication available" guidance — used instead of
/// the gh-worded `NotAuthenticated` so Bitbucket users get the right recovery
/// steps. Bitbucket has no CLI, so the fix is signing in or adding a token.
pub(super) fn no_bitbucket_auth(host: &str) -> GithubError {
    GithubError::CommandFailed(format!(
        "No Bitbucket sign-in found for {host}. Sign in to Bitbucket, or add a Bitbucket API token, in Settings to use pull requests."
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_bitbucket_auth_names_settings_not_gh() {
        let msg = no_bitbucket_auth("bitbucket.org").to_ipc_string();
        assert!(msg.contains("Settings"), "{msg}");
        assert!(!msg.contains("gh auth"), "must not suggest gh: {msg}");
        assert!(msg.contains("bitbucket.org"), "{msg}");
    }
}
