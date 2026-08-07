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
//! access token from GL-139, or an API token / app password stored via GL-132).
//! The auth scheme follows the account's git HTTPS username — Bearer for an OAuth
//! token (the `x-token-auth` sentinel), Basic for an API token / app password
//! (see [`transport`]). The token is resolved from the keychain immediately
//! before the operation and lives only for the call — it never crosses IPC.
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
    FileDiff, GithubAccount, GithubAccountRef, PrCheck, PrCommitList, PrCreateInput, PrStack,
    PrStackMembership, PullRequestDetail, PullRequestMergeOutcome, PullRequestSummary,
    ReviewThreadList,
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
    /// Returns the token and the account's git HTTPS username (which selects the
    /// auth scheme — see [`transport::RestClient`]).
    fn credential<'a>(&self, ctx: &'a GithubContext) -> Result<(String, &'a str), GithubError> {
        let account = ctx
            .account
            .as_ref()
            .ok_or_else(|| no_bitbucket_auth(&ctx.repository.host))?;
        let key = SecretKey::new(BITBUCKET_PROVIDER, &account.host, &account.account_id);
        let token = match KeyringStore::new().get(&key) {
            Ok(Some(token)) => token,
            Ok(None) => return Err(no_bitbucket_auth(&ctx.repository.host)),
            Err(e) => return Err(GithubError::CommandFailed(e.into())),
        };
        Ok((token, account.login.as_str()))
    }

    /// Resolve the credential and run `f` against a REST client with the repo base
    /// path (`repositories/{workspace}/{slug}`). The `UreqTransport` and token
    /// live only for the call.
    fn with_api<T>(
        &self,
        ctx: &GithubContext,
        f: impl FnOnce(&dyn transport::BitbucketApi, &str) -> Result<T, GithubError>,
    ) -> Result<T, GithubError> {
        let (token, username) = self.credential(ctx)?;
        let repo = ops::repo_path(&ctx.repository.owner, &ctx.repository.name);
        let http = UreqTransport::new();
        let api = RestClient::new(&http, &ctx.repository.host, username, &token);
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

    fn pr_commits(&self, ctx: &GithubContext, number: u64) -> Result<PrCommitList, GithubError> {
        self.with_api(ctx, |api, repo| ops::pr_commits(api, repo, number))
    }

    /// Bitbucket has no stacked-pull-request concept — see the trait doc for
    /// why this answers `None` rather than an unsupported error.
    fn pr_stack(&self, _ctx: &GithubContext, _number: u64) -> Result<Option<PrStack>, GithubError> {
        Ok(None)
    }

    /// Bitbucket has no stacks, so no pull request is ever in one.
    fn list_stacks(&self, _ctx: &GithubContext) -> Result<Vec<PrStackMembership>, GithubError> {
        Ok(Vec::new())
    }

    fn merge_stack(
        &self,
        _ctx: &GithubContext,
        _number: u64,
        _method: &str,
    ) -> Result<String, GithubError> {
        Err(ops::unsupported(
            "Stacked pull requests are a GitHub feature; Bitbucket pull requests have no stack to merge.",
        ))
    }

    fn pr_diff(&self, ctx: &GithubContext, number: u64) -> Result<Vec<FileDiff>, GithubError> {
        self.with_api(ctx, |api, repo| ops::pr_diff(api, repo, number))
    }

    fn review_threads(
        &self,
        _ctx: &GithubContext,
        _number: u64,
    ) -> Result<ReviewThreadList, GithubError> {
        // Inline review threads are out of scope for GL-141; report none so the
        // detail view simply omits the threads section.
        Ok(ReviewThreadList {
            threads: Vec::new(),
            truncated: false,
        })
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
    ) -> Result<PullRequestMergeOutcome, GithubError> {
        // Bitbucket's merge endpoint takes `close_source_branch` and reports no
        // partial outcome, so there is nothing to warn about.
        self.with_api(ctx, |api, repo| {
            ops::merge_pr(api, repo, number, method, delete_branch)
        })
        .map(|_| PullRequestMergeOutcome::default())
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

    fn create_pr(&self, ctx: &GithubContext, input: &PrCreateInput) -> Result<String, GithubError> {
        self.with_api(ctx, |api, repo| {
            ops::create_pr(
                api,
                repo,
                &input.base,
                &input.head,
                &input.title,
                &input.body,
                input.draft,
            )
        })
    }
}

/// Bitbucket-specific "no authentication available" guidance — used instead of
/// the gh-worded `NotAuthenticated` so Bitbucket users get the right recovery
/// steps. Bitbucket has no CLI; GCM/helper and SSH cover git transport, while PR
/// calls still require a GitLane-owned token from the hidden compatibility path.
pub(super) fn no_bitbucket_auth(host: &str) -> GithubError {
    GithubError::CommandFailed(format!(
        "No Bitbucket PR sign-in found for {host}. Bitbucket has no CLI; GCM/helper or SSH can still handle git transport, but pull requests need an existing GitLane keychain token."
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_bitbucket_auth_names_git_transport_fallbacks_not_gh() {
        let msg = no_bitbucket_auth("bitbucket.org").to_ipc_string();
        assert!(msg.contains("no CLI"), "{msg}");
        assert!(msg.contains("GCM/helper or SSH"), "{msg}");
        assert!(msg.contains("keychain token"), "{msg}");
        assert!(
            !msg.contains("API token"),
            "hidden token setup should not be advertised: {msg}"
        );
        assert!(!msg.contains("gh auth"), "must not suggest gh: {msg}");
        assert!(msg.contains("bitbucket.org"), "{msg}");
    }
}
