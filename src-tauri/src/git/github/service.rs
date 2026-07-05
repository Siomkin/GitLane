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
    normalize_account_ref, GithubContext, GithubError, GithubGitAuth, GithubRepository, GH_PROVIDER,
};
use super::gh_provider::GhProvider;

pub trait GithubProvider {
    fn kind(&self) -> &'static str;
    fn accounts(&self) -> Result<Vec<GithubAccount>, GithubError>;
    fn token_for_git(
        &self,
        account: Option<&GithubAccountRef>,
    ) -> Result<Option<GithubGitAuth>, GithubError>;
    fn resolve_repository(
        &self,
        workdir: &str,
        account: Option<&GithubAccountRef>,
    ) -> Result<GithubRepository, GithubError>;
    fn list_prs(&self, ctx: &GithubContext) -> Result<Vec<PullRequestSummary>, GithubError>;
    fn pr_detail(&self, ctx: &GithubContext, number: u64)
        -> Result<PullRequestDetail, GithubError>;
    fn pr_checks(&self, ctx: &GithubContext, number: u64) -> Result<Vec<PrCheck>, GithubError>;
    fn pr_commits(&self, ctx: &GithubContext, number: u64)
        -> Result<Vec<PrCommit>, GithubError>;
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
}

impl Default for GithubService {
    fn default() -> Self {
        Self { gh: GhProvider }
    }
}

impl GithubService {
    pub fn accounts(&self) -> Result<Vec<GithubAccount>, GithubError> {
        self.gh.accounts()
    }

    /// Resolve git auth for a push/fetch that targets one named `remote`,
    /// validating the account against **that remote's host** instead of the
    /// repo's default remote (GL-129). Plain host equality — no forge
    /// classification (so GitHub Enterprise hosts pass) and no
    /// `resolve_repository` network round-trip: a push needs only a token whose
    /// host matches the remote being touched.
    pub fn git_auth_for_remote(
        &self,
        workdir: &str,
        remote: &str,
        account: Option<&GithubAccountRef>,
    ) -> Result<Option<GithubGitAuth>, GithubError> {
        let Some(account) = account.map(normalize_account_ref) else {
            return Ok(None);
        };
        let provider = self.provider_for(Some(&account))?;
        validate_remote_account(workdir, remote, &account)?;
        provider.token_for_git(Some(&account))
    }

    /// Resolve auth for several `(remote, account)` pairs in one pass (the
    /// multi-remote fetch). Every pair is host-validated individually, but the
    /// token lookup (a `gh` subprocess) is deduplicated per account, so two
    /// remotes bound to the same account cost one resolution. Remotes whose
    /// account yields no token are omitted — the fetch falls back to system
    /// credentials for them.
    pub fn git_auth_for_remotes(
        &self,
        workdir: &str,
        entries: &[(String, GithubAccountRef)],
    ) -> Result<Vec<(String, GithubGitAuth)>, GithubError> {
        let mut tokens: std::collections::HashMap<String, Option<GithubGitAuth>> =
            std::collections::HashMap::new();
        let mut out = Vec::new();
        for (remote, account) in entries {
            let account = normalize_account_ref(account);
            let provider = self.provider_for(Some(&account))?;
            validate_remote_account(workdir, remote, &account)?;
            let key = format!("{}:{}:{}", account.provider, account.host, account.account_id);
            let auth = match tokens.get(&key) {
                Some(cached) => cached.clone(),
                None => {
                    let resolved = provider.token_for_git(Some(&account))?;
                    tokens.insert(key, resolved.clone());
                    resolved
                }
            };
            if let Some(auth) = auth {
                out.push((remote.clone(), auth));
            }
        }
        Ok(out)
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
        let provider = self.provider_for(account.as_ref())?;
        // Pre-check the repo's remote host from local git config (no token, no
        // network) before `resolve_repository` runs with the account's token —
        // otherwise a wrong-host binding sends that token to the mismatched
        // endpoint first and the clear HostMismatch/UnsupportedForge message is
        // buried under the resulting auth failure.
        if let (Some(account), Some(remote)) = (account.as_ref(), forge::detect(workdir)) {
            if remote.kind != ForgeKind::GitHub {
                return Err(GithubError::UnsupportedForge {
                    forge: remote.kind.label().to_string(),
                    host: remote.host,
                });
            }
            if remote.host != account.host {
                return Err(GithubError::HostMismatch {
                    repo_host: remote.host,
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

    fn provider_for(
        &self,
        account: Option<&GithubAccountRef>,
    ) -> Result<&dyn GithubProvider, GithubError> {
        let provider = account.map(|a| a.provider.as_str()).unwrap_or(GH_PROVIDER);
        if provider == self.gh.kind() {
            Ok(&self.gh)
        } else {
            Err(GithubError::ProviderUnavailable {
                provider: provider.to_string(),
            })
        }
    }
}

/// An account may only authenticate a remote whose URL host equals the
/// account's host — the credential-helper injection is host-scoped, so a
/// mismatched pair would silently push with the wrong (or no) token. Host
/// equality alone, no forge classification: a GitHub Enterprise remote's host
/// isn't recognisable by pattern but must still validate.
fn validate_remote_account(
    workdir: &str,
    remote: &str,
    account: &GithubAccountRef,
) -> Result<(), GithubError> {
    let Some(host) = forge::remote_host_for(workdir, remote) else {
        return Err(GithubError::CommandFailed(format!(
            "Remote '{remote}' was not found or has no URL configured."
        )));
    };
    if host != account.host {
        return Err(GithubError::RemoteHostMismatch {
            remote: remote.to_string(),
            remote_host: host,
            account_host: account.host.clone(),
        });
    }
    Ok(())
}
