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
use super::bitbucket::BitbucketProvider;
use super::gh_provider::GhProvider;
use super::gitlab::GitLabProvider;

pub trait GithubProvider {
    /// Provider family key (`gh` / `gitlab`). Consumed by the dispatch tests; the
    /// allow keeps non-test builds quiet without dropping the contract.
    #[cfg_attr(not(test), allow(dead_code))]
    fn kind(&self) -> &'static str;
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
    bitbucket: BitbucketProvider,
}

impl Default for GithubService {
    fn default() -> Self {
        Self {
            gh: GhProvider,
            gitlab: GitLabProvider,
            bitbucket: BitbucketProvider,
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
            if !hosts_match(&remote.host, &account.host) {
                return Err(GithubError::HostMismatch {
                    repo_host: remote.host.clone(),
                    account_host: account.host.clone(),
                });
            }
        }
        let repository = provider.resolve_repository(workdir, account.as_ref())?;
        if let Some(account) = account.as_ref() {
            if !hosts_match(&repository.host, &account.host) {
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
    /// default); GitLab to the GitLab provider; Bitbucket to the Bitbucket
    /// provider; any other known forge is an explicit unsupported error.
    fn provider_for(
        &self,
        remote: Option<&forge::RemoteForge>,
    ) -> Result<&dyn GithubProvider, GithubError> {
        match remote.map(|r| &r.kind) {
            Some(ForgeKind::GitLab) => Ok(&self.gitlab),
            Some(ForgeKind::Bitbucket) => Ok(&self.bitbucket),
            Some(ForgeKind::GitHub) | None => Ok(&self.gh),
            Some(other) => Err(GithubError::UnsupportedForge {
                forge: other.label().to_string(),
                host: remote.map(|r| r.host.clone()).unwrap_or_default(),
            }),
        }
    }
}

/// Compare two hosts ignoring a trailing numeric port. Forge detection reports a
/// portless host, while a self-hosted GitLab account ref can carry a custom HTTPS
/// port (`gitlab.example.com:8443`); matching by name keeps the REST base URL's
/// port without failing the host check. GitHub hosts never carry a port, so this
/// is a no-op there.
fn hosts_match(a: &str, b: &str) -> bool {
    fn strip_port(host: &str) -> &str {
        match host.rsplit_once(':') {
            Some((name, port)) if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) => {
                name
            }
            _ => host,
        }
    }
    strip_port(a).eq_ignore_ascii_case(strip_port(b))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::forge::{ForgeKind, RemoteForge};

    fn remote(kind: ForgeKind, host: &str) -> RemoteForge {
        RemoteForge {
            kind,
            host: host.to_string(),
        }
    }

    /// A throwaway git repo with a single `origin` remote, so a service call runs
    /// the real forge-detection + dispatch path against a concrete workdir.
    struct TempRepo(std::path::PathBuf);
    impl TempRepo {
        fn init(tag: &str, remote_url: &str) -> Self {
            use std::sync::atomic::{AtomicU32, Ordering};
            static SEQ: AtomicU32 = AtomicU32::new(0);
            let n = SEQ.fetch_add(1, Ordering::Relaxed);
            let dir = std::env::temp_dir()
                .join(format!("gitlane-svc-{tag}-{}-{n}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            let repo = git2::Repository::init(&dir).unwrap();
            repo.remote("origin", remote_url).unwrap();
            TempRepo(dir)
        }
        fn path(&self) -> &str {
            self.0.to_str().unwrap()
        }
    }
    impl Drop for TempRepo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn list_prs_on_a_bitbucket_repo_dispatches_and_requires_a_token() {
        // A Bitbucket remote with no bound account: dispatch resolves the
        // Bitbucket provider and its repository, then fails at token resolution
        // with Bitbucket-specific guidance — no network or keychain token needed.
        let repo = TempRepo::init("bb", "https://bitbucket.org/team/app.git");
        let err = GithubService::default()
            .list_prs(repo.path(), None)
            .expect_err("no token → error");
        let msg = err.to_ipc_string();
        assert!(msg.contains("Bitbucket"), "{msg}");
        assert!(msg.contains("Settings"), "{msg}");
        assert!(!msg.contains("gh auth"), "must not use gh wording: {msg}");
    }

    #[test]
    fn list_prs_rejects_a_bitbucket_server_host() {
        // A self-hosted Bitbucket (Server/Data Center) remote is detected as
        // Bitbucket but must be refused with a clear message rather than
        // misrouted to the cloud API (GL-141).
        let repo = TempRepo::init("bbserver", "https://bitbucket.example.com/team/app.git");
        let err = GithubService::default()
            .list_prs(repo.path(), None)
            .expect_err("server host → error");
        let msg = err.to_ipc_string();
        assert!(msg.contains("Bitbucket Cloud"), "{msg}");
        assert!(msg.contains("bitbucket.example.com"), "{msg}");
    }

    #[test]
    fn provider_for_selects_by_forge() {
        let service = GithubService::default();
        // GitHub and an unrecognised/absent remote → gh; GitLab → gitlab;
        // Bitbucket → bitbucket.
        assert_eq!(
            service
                .provider_for(Some(&remote(ForgeKind::GitHub, "github.com")))
                .unwrap()
                .kind(),
            "gh"
        );
        assert_eq!(service.provider_for(None).unwrap().kind(), "gh");
        assert_eq!(
            service
                .provider_for(Some(&remote(ForgeKind::GitLab, "gitlab.com")))
                .unwrap()
                .kind(),
            "gitlab"
        );
        assert_eq!(
            service
                .provider_for(Some(&remote(ForgeKind::Bitbucket, "bitbucket.org")))
                .unwrap()
                .kind(),
            "bitbucket"
        );
    }

    #[test]
    fn provider_for_rejects_other_forges() {
        let service = GithubService::default();
        for kind in [ForgeKind::AzureDevOps, ForgeKind::Gitea, ForgeKind::Forgejo] {
            // `&dyn GithubProvider` isn't Debug, so match rather than unwrap_err.
            let result = service.provider_for(Some(&remote(kind.clone(), "example.test")));
            assert!(
                matches!(result, Err(GithubError::UnsupportedForge { .. })),
                "{kind:?} should be unsupported"
            );
        }
    }

    #[test]
    fn hosts_match_ignores_a_numeric_port() {
        assert!(hosts_match("gitlab.example.com", "gitlab.example.com:8443"));
        assert!(hosts_match("gitlab.example.com:8443", "gitlab.example.com"));
        assert!(hosts_match("github.com", "github.com"));
        // Different hosts never match, port or not.
        assert!(!hosts_match("gitlab.com", "gitlab.example.com"));
        assert!(!hosts_match("gitlab.com:443", "gitlab.example.com:443"));
    }
}
