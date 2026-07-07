//! Internal service boundary for GitHub operations.
//!
//! Tauri commands call this service; the service builds a provider-neutral
//! context, validates host/account compatibility, then calls exactly one
//! provider. The public IPC names stay stable while transport details remain
//! below this boundary.

use crate::git::types::{
    FileDiff, GithubAccount, GithubAccountRef, PrCheck, PrCommit, PullRequestDetail,
    PullRequestSummary, ReviewThread,
};
use crate::git::{forge, forge::ForgeKind};

use super::domain::{
    normalize_account_ref, GithubContext, GithubError, GithubRepository,
};
use super::gh_provider::GhProvider;
use super::gitlab::GitLabProvider;

pub trait GithubProvider {
    fn accounts(&self) -> Result<Vec<GithubAccount>, GithubError>;
    fn resolve_repository(
        &self,
        workdir: &str,
        account: Option<&GithubAccountRef>,
    ) -> Result<GithubRepository, GithubError>;
    fn list_prs(&self, ctx: &GithubContext) -> Result<Vec<PullRequestSummary>, GithubError>;
    fn pr_detail(&self, ctx: &GithubContext, number: u64)
        -> Result<PullRequestDetail, GithubError>;
    fn pr_checks(&self, ctx: &GithubContext, number: u64) -> Result<Vec<PrCheck>, GithubError>;
    fn pr_commits(&self, ctx: &GithubContext, number: u64) -> Result<Vec<PrCommit>, GithubError>;
    fn pr_diff(&self, ctx: &GithubContext, number: u64) -> Result<Vec<FileDiff>, GithubError>;
    fn review_threads(
        &self,
        ctx: &GithubContext,
        number: u64,
    ) -> Result<Vec<ReviewThread>, GithubError>;
    fn set_thread_resolved(
        &self,
        ctx: &GithubContext,
        thread_id: &str,
        resolved: bool,
    ) -> Result<String, GithubError>;
    fn reply_thread(
        &self,
        ctx: &GithubContext,
        thread_id: &str,
        body: &str,
    ) -> Result<String, GithubError>;
    fn merge_pr(
        &self,
        ctx: &GithubContext,
        number: u64,
        method: &str,
        delete_branch: bool,
    ) -> Result<String, GithubError>;
    fn comment_pr(
        &self,
        ctx: &GithubContext,
        number: u64,
        body: &str,
    ) -> Result<String, GithubError>;
    fn review_pr(
        &self,
        ctx: &GithubContext,
        number: u64,
        action: &str,
        body: &str,
    ) -> Result<String, GithubError>;
    fn set_pr_state(
        &self,
        ctx: &GithubContext,
        number: u64,
        action: &str,
    ) -> Result<String, GithubError>;
    fn create_pr(
        &self,
        ctx: &GithubContext,
        base: &str,
        head: &str,
        title: &str,
        body: &str,
        draft: bool,
    ) -> Result<String, GithubError>;
}

pub struct GithubService {
    gh: GhProvider,
    gitlab: GitLabProvider,
}

impl Default for GithubService {
    fn default() -> Self {
        Self {
            gh: GhProvider,
            gitlab: GitLabProvider,
        }
    }
}

impl GithubService {
    pub fn accounts(&self) -> Result<Vec<GithubAccount>, GithubError> {
        self.gh.accounts()
    }

    pub fn list_prs(
        &self,
        workdir: &str,
        account: Option<&GithubAccountRef>,
    ) -> Result<Vec<PullRequestSummary>, GithubError> {
        let (provider, ctx) = self.context(workdir, account)?;
        provider.list_prs(&ctx)
    }

    pub fn pr_detail(
        &self,
        workdir: &str,
        number: u64,
        account: Option<&GithubAccountRef>,
    ) -> Result<PullRequestDetail, GithubError> {
        let (provider, ctx) = self.context(workdir, account)?;
        provider.pr_detail(&ctx, number)
    }

    pub fn pr_checks(
        &self,
        workdir: &str,
        number: u64,
        account: Option<&GithubAccountRef>,
    ) -> Result<Vec<PrCheck>, GithubError> {
        let (provider, ctx) = self.context(workdir, account)?;
        provider.pr_checks(&ctx, number)
    }

    pub fn pr_commits(
        &self,
        workdir: &str,
        number: u64,
        account: Option<&GithubAccountRef>,
    ) -> Result<Vec<PrCommit>, GithubError> {
        let (provider, ctx) = self.context(workdir, account)?;
        provider.pr_commits(&ctx, number)
    }

    pub fn pr_diff(
        &self,
        workdir: &str,
        number: u64,
        account: Option<&GithubAccountRef>,
    ) -> Result<Vec<FileDiff>, GithubError> {
        let (provider, ctx) = self.context(workdir, account)?;
        provider.pr_diff(&ctx, number)
    }

    pub fn review_threads(
        &self,
        workdir: &str,
        number: u64,
        account: Option<&GithubAccountRef>,
    ) -> Result<Vec<ReviewThread>, GithubError> {
        let (provider, ctx) = self.context(workdir, account)?;
        provider.review_threads(&ctx, number)
    }

    pub fn set_thread_resolved(
        &self,
        workdir: &str,
        thread_id: &str,
        resolved: bool,
        account: Option<&GithubAccountRef>,
    ) -> Result<String, GithubError> {
        let (provider, ctx) = self.context(workdir, account)?;
        provider.set_thread_resolved(&ctx, thread_id, resolved)
    }

    pub fn reply_thread(
        &self,
        workdir: &str,
        thread_id: &str,
        body: &str,
        account: Option<&GithubAccountRef>,
    ) -> Result<String, GithubError> {
        let (provider, ctx) = self.context(workdir, account)?;
        provider.reply_thread(&ctx, thread_id, body)
    }

    pub fn merge_pr(
        &self,
        workdir: &str,
        number: u64,
        method: &str,
        delete_branch: bool,
        account: Option<&GithubAccountRef>,
    ) -> Result<String, GithubError> {
        let (provider, ctx) = self.context(workdir, account)?;
        provider.merge_pr(&ctx, number, method, delete_branch)
    }

    pub fn comment_pr(
        &self,
        workdir: &str,
        number: u64,
        body: &str,
        account: Option<&GithubAccountRef>,
    ) -> Result<String, GithubError> {
        let (provider, ctx) = self.context(workdir, account)?;
        provider.comment_pr(&ctx, number, body)
    }

    pub fn review_pr(
        &self,
        workdir: &str,
        number: u64,
        action: &str,
        body: &str,
        account: Option<&GithubAccountRef>,
    ) -> Result<String, GithubError> {
        let (provider, ctx) = self.context(workdir, account)?;
        provider.review_pr(&ctx, number, action, body)
    }

    pub fn set_pr_state(
        &self,
        workdir: &str,
        number: u64,
        action: &str,
        account: Option<&GithubAccountRef>,
    ) -> Result<String, GithubError> {
        let (provider, ctx) = self.context(workdir, account)?;
        provider.set_pr_state(&ctx, number, action)
    }

    pub fn create_pr(
        &self,
        workdir: &str,
        base: &str,
        head: &str,
        title: &str,
        body: &str,
        draft: bool,
        account: Option<&GithubAccountRef>,
    ) -> Result<String, GithubError> {
        let (provider, ctx) = self.context(workdir, account)?;
        provider.create_pr(&ctx, base, head, title, body, draft)
    }

    fn context<'a>(
        &'a self,
        workdir: &str,
        account: Option<&GithubAccountRef>,
    ) -> Result<(&'a dyn GithubProvider, GithubContext), GithubError> {
        let account = account.map(normalize_account_ref);
        // Select the provider by the repo's detected forge (GL-140): GitHub
        // (and an unrecognised host, which `gh` may still resolve as github.com)
        // dispatch to the gh provider; a GitLab remote to the GitLab provider;
        // any other recognised forge is unsupported. The account ref no longer
        // drives selection — its token/keychain locator is used by the chosen
        // provider, not to pick one.
        let remote = forge::detect(workdir);
        let provider = self.provider_for(remote.as_ref())?;
        // Pre-check the account's host against the remote (no token, no network)
        // before `resolve_repository` runs — otherwise a wrong-host binding sends
        // that token to the mismatched endpoint first and the clear HostMismatch
        // message is buried under the resulting auth failure.
        if let (Some(account), Some(remote)) = (account.as_ref(), remote.as_ref()) {
            if remote.host != account.host {
                return Err(GithubError::HostMismatch {
                    repo_host: remote.host.clone(),
                    account_host: account.host.clone(),
                });
            }
        }
        let repository = provider.resolve_repository(workdir, account.as_ref())?;
        if let Some(account) = account.as_ref() {
            if repository.host != account.host {
                return Err(GithubError::HostMismatch {
                    repo_host: repository.host,
                    account_host: account.host.clone(),
                });
            }
        }
        Ok((
            provider,
            GithubContext {
                workdir: workdir.to_string(),
                repository,
                account,
            },
        ))
    }

    /// Choose the provider for the repo's detected remote forge. GitHub and an
    /// unrecognised/absent remote resolve to the gh provider (github.com is gh's
    /// default); GitLab to the GitLab provider; any other known forge is an
    /// explicit unsupported error.
    fn provider_for(
        &self,
        remote: Option<&forge::RemoteForge>,
    ) -> Result<&dyn GithubProvider, GithubError> {
        match remote.map(|r| &r.kind) {
            Some(ForgeKind::GitLab) => Ok(&self.gitlab),
            Some(ForgeKind::GitHub) | None => Ok(&self.gh),
            Some(other) => Err(GithubError::UnsupportedForge {
                forge: other.label().to_string(),
                host: remote.map(|r| r.host.clone()).unwrap_or_default(),
            }),
        }
    }
}
