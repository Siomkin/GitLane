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
    FileDiff, GithubAccountRef, PrCommitList, PrCreateInput, PullRequestDetail,
    PullRequestMergeOutcome, PullRequestSummary,
};
use crate::secrets::{KeyringStore, SecretKey, SecretStore};

use super::domain::{GithubContext, GithubError, GithubRepository};
use super::service::{ForgeIdentity, GithubProvider};

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
    fn identity(&self) -> ForgeIdentity {
        ForgeIdentity {
            key: BITBUCKET_PROVIDER,
            pr_noun: "Bitbucket pull request",
        }
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
            host: host.into(),
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

    fn pr_commits(&self, ctx: &GithubContext, number: u64) -> Result<PrCommitList, GithubError> {
        self.with_api(ctx, |api, repo| ops::pr_commits(api, repo, number))
    }

    fn pr_diff(&self, ctx: &GithubContext, number: u64) -> Result<Vec<FileDiff>, GithubError> {
        self.with_api(ctx, |api, repo| ops::pr_diff(api, repo, number))
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

    fn review_pr(
        &self,
        ctx: &GithubContext,
        number: u64,
        action: &str,
        _body: &str,
    ) -> Result<String, GithubError> {
        self.with_api(ctx, |api, repo| ops::review_pr(api, repo, number, action))
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
