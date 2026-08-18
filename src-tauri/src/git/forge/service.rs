//! Provider selection and the authorised context every forge operation runs in.
//!
//! This is the deep part of the GitHub/GitLab/Bitbucket seam: [`context`] picks
//! the provider from the repository's detected forge, derives the repository's
//! own API authority, and refuses a host/authority mismatch *before* the bound
//! account's token locator reaches any provider. A command holds the resulting
//! `(provider, context)` pair and calls the provider directly — there is no
//! per-operation wrapper here, because a wrapper could only restate the trait
//! (GL-352).

use crate::git::types::{
    FileDiff, GithubAccount, GithubAccountRef, PrCheck, PrCommitList, PrCreateInput,
    PrReviewerCandidate, PrStack, PrStackMembership, PullRequestDetail, PullRequestMergeOutcome,
    PullRequestSummary, ReviewThreadList,
};
use crate::git::{forge, forge::ForgeKind};

use super::bitbucket::BitbucketProvider;
use super::domain::{normalize_account_ref, GithubContext, GithubError, GithubRepository};
use super::gh_provider::GhProvider;
use super::gitlab::GitLabProvider;
use super::origin::OriginProvider;

/// How a forge names itself, for the dispatch tests and for the refusals its
/// adapter declines with. One method rather than three: every fact here is a
/// constant per adapter, and they are only ever needed together.
pub struct ForgeIdentity {
    /// Provider family key (`gh` / `gitlab` / `bitbucket`). Consumed by the
    /// dispatch tests; the allow keeps non-test builds quiet without dropping
    /// the contract.
    #[cfg_attr(not(test), allow(dead_code))]
    pub key: &'static str,
    /// What this forge calls a pull request, forge name included, as it should
    /// read in a message to the user ("GitLab merge request"). One field rather
    /// than name-plus-noun: nothing ever needs the two apart.
    pub pr_noun: &'static str,
}

pub trait GithubProvider {
    fn identity(&self) -> ForgeIdentity;

    /// How this adapter declines an operation its forge has no equivalent for,
    /// or one GitLane has not implemented there yet. The wording lives here so
    /// the twelve GitHub-only methods below need no per-adapter refusal body —
    /// GitLab and Bitbucket used to hand-write ~130 lines of them (GL-354).
    fn unsupported(&self, action: &str) -> GithubError {
        let pr_noun = self.identity().pr_noun;
        GithubError::CommandFailed(format!(
            "{action} isn't supported for {pr_noun}s in GitLane yet."
        ))
    }

    /// Signed-in accounts of this provider's own kind. Only the gh provider has
    /// a gh-shaped account list; GitLab and Bitbucket surface theirs through the
    /// forge-auth / OAuth flows, and the service only ever calls this on gh.
    fn accounts(&self) -> Result<Vec<GithubAccount>, GithubError> {
        Ok(Vec::new())
    }

    fn resolve_repository(
        &self,
        workdir: &str,
        account: Option<&GithubAccountRef>,
    ) -> Result<GithubRepository, GithubError>;
    fn list_prs(&self, ctx: &GithubContext) -> Result<Vec<PullRequestSummary>, GithubError>;
    fn pr_detail(&self, ctx: &GithubContext, number: u64)
        -> Result<PullRequestDetail, GithubError>;
    fn pr_commits(&self, ctx: &GithubContext, number: u64) -> Result<PrCommitList, GithubError>;
    fn pr_diff(&self, ctx: &GithubContext, number: u64) -> Result<Vec<FileDiff>, GithubError>;
    fn merge_pr(
        &self,
        ctx: &GithubContext,
        number: u64,
        method: &str,
        delete_branch: bool,
    ) -> Result<PullRequestMergeOutcome, GithubError>;
    fn review_pr(
        &self,
        ctx: &GithubContext,
        number: u64,
        action: &str,
        body: &str,
    ) -> Result<String, GithubError>;
    fn create_pr(&self, ctx: &GithubContext, input: &PrCreateInput) -> Result<String, GithubError>;

    // ---- Defaults below have exactly one real GitHub implementation
    // (`GhProvider`). Origin also implements review threads, replies, and
    // resolve/reopen; GitLab/Bitbucket keep these defaults.
    //
    // Two kinds of default, and the distinction is the point. Where the honest
    // answer on another forge is *"there is nothing here"* the default returns
    // the empty value, so the UI simply omits the section. Where it is *"this
    // cannot be done"* the default refuses — a write that silently did nothing
    // would be indistinguishable from success. ----

    /// CI/build checks for a pull request. Empty where GitLane does not read
    /// them yet, so the Checks tab shows "no checks" rather than an error.
    fn pr_checks(&self, _ctx: &GithubContext, _number: u64) -> Result<Vec<PrCheck>, GithubError> {
        Ok(Vec::new())
    }

    /// The stack `number` belongs to, or `None` when it is not stacked. Stacked
    /// pull requests are a GitHub feature; on a forge without them "this PR is
    /// not in a stack" is simply true, and it keeps the stack card absent
    /// instead of erroring once per pull request.
    fn pr_stack(&self, _ctx: &GithubContext, _number: u64) -> Result<Option<PrStack>, GithubError> {
        Ok(None)
    }

    /// Every stack in the repo, flattened per pull request, for the list badge.
    /// Empty without stacks — same reasoning as [`GithubProvider::pr_stack`].
    fn list_stacks(&self, _ctx: &GithubContext) -> Result<Vec<PrStackMembership>, GithubError> {
        Ok(Vec::new())
    }

    /// Inline review threads. None where GitLane does not read them yet, so the
    /// detail view omits the threads section.
    fn review_threads(
        &self,
        _ctx: &GithubContext,
        _number: u64,
    ) -> Result<ReviewThreadList, GithubError> {
        Ok(ReviewThreadList {
            threads: Vec::new(),
            truncated: false,
        })
    }

    /// People who can be asked to review here. Empty hides the picker rather
    /// than failing the create-PR dialog.
    fn reviewer_candidates(
        &self,
        _ctx: &GithubContext,
    ) -> Result<Vec<PrReviewerCandidate>, GithubError> {
        Ok(Vec::new())
    }

    /// Atomically merge `number` and every unmerged layer below it.
    fn merge_stack(
        &self,
        _ctx: &GithubContext,
        _number: u64,
        _method: &str,
    ) -> Result<String, GithubError> {
        Err(self.no_stacks("merge"))
    }

    /// Link existing pull requests into a stack, bottom-first.
    fn link_stack(&self, _ctx: &GithubContext, _numbers: &[u64]) -> Result<String, GithubError> {
        Err(self.no_stacks("link"))
    }

    fn set_thread_resolved(
        &self,
        _ctx: &GithubContext,
        _number: u64,
        _thread_id: &str,
        _resolved: bool,
    ) -> Result<String, GithubError> {
        Err(self.unsupported("Resolving review threads"))
    }

    fn reply_thread(
        &self,
        _ctx: &GithubContext,
        _number: u64,
        _thread_id: &str,
        _body: &str,
    ) -> Result<String, GithubError> {
        Err(self.unsupported("Replying to review threads"))
    }

    fn comment_pr(
        &self,
        _ctx: &GithubContext,
        _number: u64,
        _body: &str,
    ) -> Result<String, GithubError> {
        Err(self.unsupported("Commenting"))
    }

    fn set_pr_state(
        &self,
        _ctx: &GithubContext,
        _number: u64,
        _action: &str,
    ) -> Result<String, GithubError> {
        Err(self.unsupported("Closing or reopening"))
    }

    /// Stacks are a GitHub concept with no equivalent elsewhere, so this reads
    /// differently from a not-implemented-yet refusal: there is nothing to add.
    fn no_stacks(&self, verb: &str) -> GithubError {
        let pr_noun = self.identity().pr_noun;
        GithubError::CommandFailed(format!(
            "Stacked pull requests are a GitHub feature; {pr_noun}s have no stack to {verb}."
        ))
    }
}

// The four adapters are unit structs — no state, no configuration — so they
// live as statics and dispatch borrows them for `'static`. That is what lets a
// command hold its `(provider, context)` pair for the length of the operation
// without threading a service instance through.
static GH: GhProvider = GhProvider;
static GITLAB: GitLabProvider = GitLabProvider;
static BITBUCKET: BitbucketProvider = BitbucketProvider;
static ORIGIN: OriginProvider = OriginProvider;

/// Signed-in GitHub accounts. Not a dispatched operation: `gh` is the only
/// provider with a gh-shaped account list, and this runs before any repository
/// is known, so there is no forge to select on.
pub fn accounts() -> Result<Vec<GithubAccount>, GithubError> {
    GH.accounts()
}

/// Resolve the provider for a repository and the validated context every
/// operation runs against — the whole point of this module.
///
/// This is where a PR operation is *authorised*: the repository's own remote
/// authority is derived and checked against the chosen account's host before
/// the account's token locator reaches any provider. A caller holds the result
/// and calls the provider directly; there is no per-operation wrapper to keep
/// in sync (GL-352).
pub fn context(
    workdir: &str,
    account: Option<&GithubAccountRef>,
) -> Result<(&'static dyn GithubProvider, GithubContext), GithubError> {
    let account = account.map(normalize_account_ref);
    // Select the provider by the repo's detected forge (GL-140): GitHub
    // (and an unrecognised host, which `gh` may still resolve as github.com)
    // dispatch to the gh provider; a GitLab remote to the GitLab provider;
    // Bitbucket to Bitbucket; Cursor Origin to Origin; any other recognised
    // forge is unsupported. The account ref no longer
    // drives selection — its token/keychain locator is used by the chosen
    // provider, not to pick one.
    let remote = forge::detect(workdir);
    let provider = provider_for(remote.as_ref())?;
    // Repository resolution runs without the selected account. This keeps
    // its token/keychain locator out of every provider until the local
    // remote authority has been proven compatible below.
    let repository = provider.resolve_repository(workdir, None)?;
    let repository = validate_repository_authority(workdir, repository, account.as_ref())?;
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
/// provider; Cursor Origin to the Origin provider; any other known forge is
/// an explicit unsupported error.
fn provider_for(
    remote: Option<&forge::RemoteForge>,
) -> Result<&'static dyn GithubProvider, GithubError> {
    match remote.map(|r| &r.kind) {
        Some(ForgeKind::GitLab) => Ok(&GITLAB),
        Some(ForgeKind::Bitbucket) => Ok(&BITBUCKET),
        Some(ForgeKind::CursorOrigin) => Ok(&ORIGIN),
        Some(ForgeKind::GitHub) | None => Ok(&GH),
        Some(other) => Err(GithubError::UnsupportedForge {
            forge: other.label().to_string(),
            host: remote.map(|r| r.host.clone()).unwrap_or_default(),
        }),
    }
}

/// Validate and bind the API authority carried into provider operations.
/// HTTP(S) remotes have an exact API authority, so an explicit port is part of
/// the security boundary. SSH/scp remotes carry only a transport hostname; if
/// that hostname matches the account hostname, the account's HTTPS authority
/// (including its API port) becomes the context authority used by later calls.
fn validate_repository_authority(
    workdir: &str,
    mut repository: GithubRepository,
    account: Option<&GithubAccountRef>,
) -> Result<GithubRepository, GithubError> {
    let project = if repository.owner.is_empty() {
        repository.name.clone()
    } else {
        format!("{}/{}", repository.owner, repository.name)
    };
    let remote = forge::remote_api_authority_for_project(workdir, &repository.host, &project);

    let Some(account) = account else {
        if let Some(remote) = remote {
            repository.host = match remote {
                forge::RemoteApiAuthority::Http(authority)
                | forge::RemoteApiAuthority::TransportHost(authority) => {
                    forge::ApiAuthority::new(authority)
                }
            };
        }
        return Ok(repository);
    };

    let repo_authority = match remote {
        Some(forge::RemoteApiAuthority::Http(authority)) => {
            let authority = forge::ApiAuthority::new(authority);
            if !authority.matches(&account.host) {
                return Err(GithubError::HostMismatch {
                    repo_host: authority.into_inner(),
                    account_host: account.host.clone(),
                });
            }
            // An explicit port on the HTTPS remote *is* the API port, and the
            // account ref may legitimately lack one (gh cannot express a port
            // at all), so the remote's authority wins when it has one. A
            // portless remote keeps the account's authority, which is where a
            // self-hosted GitLab account ref carries its own port.
            if authority.port().is_some() {
                authority
            } else {
                forge::ApiAuthority::new(account.host.clone())
            }
        }
        Some(forge::RemoteApiAuthority::TransportHost(host)) => {
            let account_authority = forge::ApiAuthority::new(account.host.clone());
            if !account_authority.matches_hostname(&host) {
                return Err(GithubError::HostMismatch {
                    repo_host: host,
                    account_host: account.host.clone(),
                });
            }
            account_authority
        }
        None => {
            if !repository.host.matches(&account.host) {
                return Err(GithubError::HostMismatch {
                    repo_host: repository.host.into_inner(),
                    account_host: account.host.clone(),
                });
            }
            forge::ApiAuthority::new(account.host.clone())
        }
    };
    repository.host = repo_authority;
    Ok(repository)
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

    fn account(host: &str) -> GithubAccountRef {
        GithubAccountRef {
            provider: "gh".into(),
            host: host.into(),
            account_id: "account-that-does-not-exist".into(),
            login: "account-that-does-not-exist".into(),
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
            let dir =
                std::env::temp_dir().join(format!("gitlane-svc-{tag}-{}-{n}", std::process::id()));
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
        let err = context(repo.path(), None)
            .and_then(|(provider, ctx)| provider.list_prs(&ctx))
            .expect_err("no token → error");
        let msg = err.to_ipc_string();
        assert!(msg.contains("Bitbucket"), "{msg}");
        assert!(msg.contains("keychain token"), "{msg}");
        assert!(!msg.contains("gh auth"), "must not use gh wording: {msg}");
    }

    #[test]
    fn list_prs_rejects_a_bitbucket_server_host() {
        // A self-hosted Bitbucket (Server/Data Center) remote is detected as
        // Bitbucket but must be refused with a clear message rather than
        // misrouted to the cloud API (GL-141).
        let repo = TempRepo::init("bbserver", "https://bitbucket.example.com/team/app.git");
        let err = context(repo.path(), None)
            .and_then(|(provider, ctx)| provider.list_prs(&ctx))
            .expect_err("server host → error");
        let msg = err.to_ipc_string();
        assert!(msg.contains("Bitbucket Cloud"), "{msg}");
        assert!(msg.contains("bitbucket.example.com"), "{msg}");
    }

    #[test]
    fn a_declining_forge_names_itself_and_what_it_calls_a_pull_request() {
        // The refusal wording lives on the trait now (GL-354). It has to stay
        // forge-accurate, since it is what the user reads: GitLab does not have
        // "pull requests", and no refusal may fall back to gh's vocabulary.
        assert_eq!(
            GitLabProvider.unsupported("Commenting").to_ipc_string(),
            "Commenting isn't supported for GitLab merge requests in GitLane yet."
        );
        assert_eq!(
            BitbucketProvider
                .unsupported("Closing or reopening")
                .to_ipc_string(),
            "Closing or reopening isn't supported for Bitbucket pull requests in GitLane yet."
        );
        // Stacks read differently: a GitHub-only concept, not a gap to fill.
        let stacks = GitLabProvider.no_stacks("merge").to_ipc_string();
        assert!(stacks.contains("GitHub feature"), "{stacks}");
        assert!(stacks.contains("GitLab merge requests"), "{stacks}");
        for msg in [
            GitLabProvider.unsupported("Commenting").to_ipc_string(),
            BitbucketProvider.no_stacks("link").to_ipc_string(),
        ] {
            assert!(!msg.contains("gh auth"), "gh wording leaked: {msg}");
        }
    }

    #[test]
    fn provider_for_selects_by_forge() {
        // GitHub and an unrecognised/absent remote → gh; GitLab → gitlab;
        // Bitbucket → bitbucket; Cursor Origin → origin.
        assert_eq!(
            provider_for(Some(&remote(ForgeKind::GitHub, "github.com")))
                .unwrap()
                .identity()
                .key,
            "gh"
        );
        assert_eq!(provider_for(None).unwrap().identity().key, "gh");
        assert_eq!(
            provider_for(Some(&remote(ForgeKind::GitLab, "gitlab.com")))
                .unwrap()
                .identity()
                .key,
            "gitlab"
        );
        assert_eq!(
            provider_for(Some(&remote(ForgeKind::Bitbucket, "bitbucket.org")))
                .unwrap()
                .identity()
                .key,
            "bitbucket"
        );
        assert_eq!(
            provider_for(Some(&remote(
                ForgeKind::CursorOrigin,
                ForgeKind::CURSOR_ORIGIN_HOST,
            )))
            .unwrap()
            .identity()
            .key,
            ForgeKind::CursorOrigin.key()
        );
    }

    #[test]
    fn provider_for_rejects_other_forges() {
        for kind in [ForgeKind::AzureDevOps, ForgeKind::Gitea, ForgeKind::Forgejo] {
            // `&dyn GithubProvider` isn't Debug, so match rather than unwrap_err.
            let result = provider_for(Some(&remote(kind.clone(), "example.test")));
            assert!(
                matches!(result, Err(GithubError::UnsupportedForge { .. })),
                "{kind:?} should be unsupported"
            );
        }
    }

    #[test]
    fn ported_remote_keeps_its_api_port_against_a_portless_account() {
        let repo = TempRepo::init(
            "ghes-port-portless-account",
            "https://ghe.example.test:8443/octo/app.git",
        );
        let selected = account("ghe.example.test");

        let (_, ctx) = context(repo.path(), Some(&selected))
            .expect("a portless account ref must serve its ported remote");
        assert_eq!(
            ctx.repository.host, "ghe.example.test:8443",
            "the remote's explicit HTTPS port is the API port and must survive validation",
        );
    }

    #[test]
    fn https_port_mismatch_is_rejected_before_account_secret_resolution() {
        let repo = TempRepo::init(
            "ghes-port-mismatch",
            "https://ghe.example.test:8443/octo/app.git",
        );
        let selected = account("ghe.example.test:9443");

        // `context` must return HostMismatch using only local remote metadata.
        // The deliberately nonexistent account would fail first if repository
        // resolution still attempted `gh auth token` or a keychain lookup.
        let err = match context(repo.path(), Some(&selected)) {
            Err(err) => err,
            Ok(_) => panic!("different HTTPS ports must not share token authority"),
        };
        assert_eq!(
            err,
            GithubError::HostMismatch {
                repo_host: "ghe.example.test:8443".into(),
                account_host: "ghe.example.test:9443".into(),
            }
        );
    }

    #[test]
    fn exact_https_port_builds_context_without_resolving_account_secret() {
        let repo = TempRepo::init(
            "ghes-port-exact",
            "https://ghe.example.test:8443/octo/app.git",
        );
        let selected = account("https://GHE.EXAMPLE.TEST:8443/");

        let (_, ctx) =
            context(repo.path(), Some(&selected)).expect("exact authority resolves locally");
        assert_eq!(ctx.repository.host, "ghe.example.test:8443");
        assert_eq!(ctx.repository.owner, "octo");
        assert_eq!(ctx.repository.name, "app");
        assert_eq!(ctx.account.unwrap().host, "ghe.example.test:8443");
    }

    #[test]
    fn ssh_transport_host_maps_to_matching_account_api_authority() {
        let selected = account("ghe.example.test:8443");
        for (tag, url) in [
            ("ghes-scp-map", "git@ghe.example.test:octo/app.git"),
            (
                "ghes-ssh-map",
                "ssh://git@ghe.example.test:2222/octo/app.git",
            ),
        ] {
            let repo = TempRepo::init(tag, url);
            let (_, ctx) = context(repo.path(), Some(&selected))
                .expect("same SSH hostname may use the account's HTTPS API port");
            assert_eq!(ctx.repository.host, "ghe.example.test:8443");
            assert_eq!(
                super::super::cli::repo_selector(&ctx.repository),
                "ghe.example.test:8443/octo/app",
                "tokened gh commands must target the validated API authority, not the bare SSH host",
            );
        }
    }

    #[test]
    fn ssh_transport_host_rejects_a_different_account_hostname() {
        let repo = TempRepo::init("ghes-ssh-mismatch", "git@ghe.example.test:octo/app.git");
        let selected = account("other.example.test:8443");

        let err = match context(repo.path(), Some(&selected)) {
            Err(err) => err,
            Ok(_) => panic!("different SSH and account hostnames must not share a token"),
        };
        assert_eq!(
            err,
            GithubError::HostMismatch {
                repo_host: "ghe.example.test".into(),
                account_host: "other.example.test:8443".into(),
            }
        );
    }

    #[test]
    fn github_account_on_origin_remote_is_host_mismatch() {
        let repo = TempRepo::init(
            "origin-gh-mismatch",
            &format!("https://{}/acme/app.git", ForgeKind::CURSOR_ORIGIN_HOST),
        );
        let selected = account("github.com");
        let err = match context(repo.path(), Some(&selected)) {
            Err(err) => err,
            Ok(_) => panic!("a GitHub account must not authenticate an Origin remote"),
        };
        assert_eq!(
            err,
            GithubError::HostMismatch {
                repo_host: ForgeKind::CURSOR_ORIGIN_HOST.into(),
                account_host: "github.com".into(),
            }
        );
    }
}
