//! `gh`-backed implementation of the internal GitHub provider contract.

use crate::git::types::{
    FileDiff, GithubAccount, GithubAccountRef, PrCheck, PrCommitSignature, PullRequestDetail,
    PullRequestSummary, ReviewThread,
};
use crate::git::{forge, forge::ForgeKind};

use super::domain::{GithubContext, GithubError, GithubGitAuth, GithubRepository, GH_PROVIDER};
use super::service::GithubProvider;
use super::{cli, diff, prs, threads};

pub struct GhProvider;

impl GhProvider {
    fn token_for_context(
        &self,
        ctx: &GithubContext,
        operation: &'static str,
    ) -> Result<Option<String>, GithubError> {
        debug_assert!(!ctx.repository.host.is_empty());
        ctx.account
            .as_ref()
            .map(|account| {
                cli::token_for(account).map_err(|err| {
                    match GithubError::from_command(operation, err) {
                        GithubError::CommandFailed(_) => GithubError::NotAuthenticated {
                            host: account.host.clone(),
                            account: Some(account.login.clone()),
                        },
                        other => other,
                    }
                })
            })
            .transpose()
    }

    fn map(operation: &'static str, result: Result<String, String>) -> Result<String, GithubError> {
        result.map_err(|err| GithubError::from_command(operation, err))
    }
}

impl GithubProvider for GhProvider {
    fn kind(&self) -> &'static str {
        GH_PROVIDER
    }

    fn accounts(&self) -> Result<Vec<GithubAccount>, GithubError> {
        cli::accounts().map_err(|err| GithubError::from_command("github account discovery", err))
    }

    fn token_for_git(
        &self,
        account: Option<&GithubAccountRef>,
    ) -> Result<Option<GithubGitAuth>, GithubError> {
        account
            .map(|account| {
                cli::token_for(account)
                    .map(|token| GithubGitAuth {
                        host: account.host.clone(),
                        token,
                    })
                    .map_err(
                        |err| match GithubError::from_command("git credential token", err) {
                            GithubError::CommandFailed(_) => GithubError::NotAuthenticated {
                                host: account.host.clone(),
                                account: Some(account.login.clone()),
                            },
                            other => other,
                        },
                    )
            })
            .transpose()
    }

    fn resolve_repository(
        &self,
        workdir: &str,
        account: Option<&GithubAccountRef>,
    ) -> Result<GithubRepository, GithubError> {
        let token = account
            .map(|account| {
                cli::token_for(account).map_err(|err| {
                    match GithubError::from_command("repository token", err) {
                        GithubError::CommandFailed(_) => GithubError::NotAuthenticated {
                            host: account.host.clone(),
                            account: Some(account.login.clone()),
                        },
                        other => other,
                    }
                })
            })
            .transpose()?;
        cli::repo_identity(workdir, token.as_deref()).map_err(|err| {
            let mapped = GithubError::from_command("repository resolution", err);
            match mapped {
                GithubError::CommandFailed(_) => {
                    unsupported_forge(workdir).unwrap_or_else(|| GithubError::RepositoryNotFound {
                        workdir: workdir.to_string(),
                    })
                }
                other => other,
            }
        })
    }

    fn list_prs(&self, ctx: &GithubContext) -> Result<Vec<PullRequestSummary>, GithubError> {
        let token = self.token_for_context(ctx, "list pull requests")?;
        prs::list_prs(&ctx.workdir, token.as_deref())
            .map_err(|err| GithubError::from_command("list pull requests", err))
    }

    fn pr_detail(
        &self,
        ctx: &GithubContext,
        number: u64,
    ) -> Result<PullRequestDetail, GithubError> {
        let token = self.token_for_context(ctx, "pull request detail")?;
        prs::pr_detail(&ctx.workdir, number, token.as_deref())
            .map_err(|err| GithubError::from_command("pull request detail", err))
    }

    fn pr_checks(&self, ctx: &GithubContext, number: u64) -> Result<Vec<PrCheck>, GithubError> {
        let token = self.token_for_context(ctx, "pull request checks")?;
        prs::pr_checks(&ctx.workdir, number, token.as_deref())
            .map_err(|err| GithubError::from_command("pull request checks", err))
    }

    fn commit_signatures(
        &self,
        ctx: &GithubContext,
        number: u64,
    ) -> Result<Vec<PrCommitSignature>, GithubError> {
        let token = self.token_for_context(ctx, "pull request commit signatures")?;
        prs::commit_signatures(&ctx.workdir, number, token.as_deref())
            .map_err(|err| GithubError::from_command("pull request commit signatures", err))
    }

    fn pr_diff(&self, ctx: &GithubContext, number: u64) -> Result<Vec<FileDiff>, GithubError> {
        let token = self.token_for_context(ctx, "pull request diff")?;
        diff::pr_diff(&ctx.workdir, number, token.as_deref())
            .map_err(|err| GithubError::from_command("pull request diff", err))
    }

    fn review_threads(
        &self,
        ctx: &GithubContext,
        number: u64,
    ) -> Result<Vec<ReviewThread>, GithubError> {
        let token = self.token_for_context(ctx, "pull request review threads")?;
        threads::review_threads(&ctx.workdir, number, token.as_deref())
            .map_err(|err| GithubError::from_command("pull request review threads", err))
    }

    fn set_thread_resolved(
        &self,
        ctx: &GithubContext,
        thread_id: &str,
        resolved: bool,
    ) -> Result<String, GithubError> {
        let token = self.token_for_context(ctx, "resolve review thread")?;
        Self::map(
            "resolve review thread",
            threads::set_thread_resolved(&ctx.workdir, thread_id, resolved, token.as_deref()),
        )
    }

    fn merge_pr(
        &self,
        ctx: &GithubContext,
        number: u64,
        method: &str,
        delete_branch: bool,
    ) -> Result<String, GithubError> {
        let token = self.token_for_context(ctx, "merge pull request")?;
        Self::map(
            "merge pull request",
            prs::merge_pr(
                &ctx.workdir,
                number,
                method,
                delete_branch,
                token.as_deref(),
            ),
        )
    }

    fn comment_pr(
        &self,
        ctx: &GithubContext,
        number: u64,
        body: &str,
    ) -> Result<String, GithubError> {
        let token = self.token_for_context(ctx, "comment pull request")?;
        Self::map(
            "comment pull request",
            prs::comment_pr(&ctx.workdir, number, body, token.as_deref()),
        )
    }

    fn review_pr(
        &self,
        ctx: &GithubContext,
        number: u64,
        action: &str,
        body: &str,
    ) -> Result<String, GithubError> {
        let token = self.token_for_context(ctx, "review pull request")?;
        Self::map(
            "review pull request",
            prs::review_pr(&ctx.workdir, number, action, body, token.as_deref()),
        )
    }

    fn set_pr_state(
        &self,
        ctx: &GithubContext,
        number: u64,
        action: &str,
    ) -> Result<String, GithubError> {
        let token = self.token_for_context(ctx, "set pull request state")?;
        Self::map(
            "set pull request state",
            prs::set_pr_state(&ctx.workdir, number, action, token.as_deref()),
        )
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
        let token = self.token_for_context(ctx, "create pull request")?;
        Self::map(
            "create pull request",
            prs::create_pr(
                &ctx.workdir,
                base,
                head,
                title,
                body,
                draft,
                token.as_deref(),
            ),
        )
    }
}

fn unsupported_forge(workdir: &str) -> Option<GithubError> {
    let remote = forge::detect(workdir)?;
    if remote.kind == ForgeKind::GitHub {
        return None;
    }
    Some(GithubError::UnsupportedForge {
        forge: remote.kind.label().to_string(),
        host: remote.host,
    })
}
