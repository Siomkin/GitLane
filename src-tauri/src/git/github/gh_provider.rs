//! `gh`-backed implementation of the internal GitHub provider contract.

use crate::git::forge;
use crate::git::types::{
    FileDiff, GithubAccount, GithubAccountRef, PrCheck, PrCommitList, PrCreateInput,
    PrReviewerCandidate, PrStack, PrStackMembership, PullRequestDetail, PullRequestMergeOutcome,
    PullRequestSummary, ReviewThreadList,
};

use super::domain::{GithubContext, GithubError, GithubRepository, GH_PROVIDER};
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
            .transpose()?
            .map_or_else(
                || {
                    // Repository authority has already been validated by the
                    // service at this point. Preserve the gh capability gate
                    // for system-auth operations without resolving a secret.
                    cli::ensure_supported()?;
                    Ok(None)
                },
                |token| Ok(Some(token)),
            )
    }

    fn map<T>(operation: &'static str, result: Result<T, String>) -> Result<T, GithubError> {
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

    fn resolve_repository(
        &self,
        workdir: &str,
        _account: Option<&GithubAccountRef>,
    ) -> Result<GithubRepository, GithubError> {
        // Repository discovery is deliberately local and token-free. Calling
        // `gh repo view` here would resolve the selected account token before
        // the service had proved that the repository belongs to that account's
        // authority, allowing a wrong GHES host/port to receive the token.
        let (host, project) =
            forge::github_project(workdir).ok_or_else(|| GithubError::RepositoryNotFound {
                workdir: workdir.to_string(),
            })?;
        let (owner, name) = project
            .split_once('/')
            .filter(|(owner, name)| !owner.is_empty() && !name.is_empty() && !name.contains('/'))
            .ok_or_else(|| GithubError::RepositoryNotFound {
                workdir: workdir.to_string(),
            })?;
        Ok(GithubRepository {
            host,
            owner: owner.to_string(),
            name: name.to_string(),
        })
    }

    fn list_prs(&self, ctx: &GithubContext) -> Result<Vec<PullRequestSummary>, GithubError> {
        let token = self.token_for_context(ctx, "list pull requests")?;
        prs::list_prs(&ctx.workdir, &ctx.repository, token.as_deref())
            .map_err(|err| GithubError::from_command("list pull requests", err))
    }

    fn pr_detail(
        &self,
        ctx: &GithubContext,
        number: u64,
    ) -> Result<PullRequestDetail, GithubError> {
        let token = self.token_for_context(ctx, "pull request detail")?;
        prs::pr_detail(&ctx.workdir, &ctx.repository, number, token.as_deref())
            .map_err(|err| GithubError::from_command("pull request detail", err))
    }

    fn pr_checks(&self, ctx: &GithubContext, number: u64) -> Result<Vec<PrCheck>, GithubError> {
        let token = self.token_for_context(ctx, "pull request checks")?;
        prs::pr_checks(&ctx.workdir, &ctx.repository, number, token.as_deref())
            .map_err(|err| GithubError::from_command("pull request checks", err))
    }

    fn pr_commits(&self, ctx: &GithubContext, number: u64) -> Result<PrCommitList, GithubError> {
        let token = self.token_for_context(ctx, "pull request commits")?;
        prs::pr_commits(&ctx.workdir, &ctx.repository, number, token.as_deref())
            .map_err(|err| GithubError::from_command("pull request commits", err))
    }

    fn pr_stack(&self, ctx: &GithubContext, number: u64) -> Result<Option<PrStack>, GithubError> {
        let token = self.token_for_context(ctx, "pull request stack")?;
        prs::pr_stack(&ctx.workdir, &ctx.repository, number, token.as_deref())
            .map_err(|err| GithubError::from_command("pull request stack", err))
    }

    fn list_stacks(&self, ctx: &GithubContext) -> Result<Vec<PrStackMembership>, GithubError> {
        let token = self.token_for_context(ctx, "repository stacks")?;
        prs::list_stacks(&ctx.workdir, &ctx.repository, token.as_deref())
            .map_err(|err| GithubError::from_command("repository stacks", err))
    }

    fn merge_stack(
        &self,
        ctx: &GithubContext,
        number: u64,
        method: &str,
    ) -> Result<String, GithubError> {
        let token = self.token_for_context(ctx, "merge pull request stack")?;
        Self::map(
            "merge pull request stack",
            prs::merge_stack(
                &ctx.workdir,
                &ctx.repository,
                number,
                method,
                token.as_deref(),
            ),
        )
    }

    fn pr_diff(&self, ctx: &GithubContext, number: u64) -> Result<Vec<FileDiff>, GithubError> {
        let token = self.token_for_context(ctx, "pull request diff")?;
        diff::pr_diff(&ctx.workdir, &ctx.repository, number, token.as_deref())
            .map_err(|err| GithubError::from_command("pull request diff", err))
    }

    fn review_threads(
        &self,
        ctx: &GithubContext,
        number: u64,
    ) -> Result<ReviewThreadList, GithubError> {
        let token = self.token_for_context(ctx, "pull request review threads")?;
        threads::review_threads(&ctx.workdir, &ctx.repository, number, token.as_deref())
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
            threads::set_thread_resolved(
                &ctx.workdir,
                &ctx.repository,
                thread_id,
                resolved,
                token.as_deref(),
            ),
        )
    }

    fn reply_thread(
        &self,
        ctx: &GithubContext,
        thread_id: &str,
        body: &str,
    ) -> Result<String, GithubError> {
        let token = self.token_for_context(ctx, "reply to review thread")?;
        Self::map(
            "reply to review thread",
            threads::reply_thread(
                &ctx.workdir,
                &ctx.repository,
                thread_id,
                body,
                token.as_deref(),
            ),
        )
    }

    fn merge_pr(
        &self,
        ctx: &GithubContext,
        number: u64,
        method: &str,
        delete_branch: bool,
    ) -> Result<PullRequestMergeOutcome, GithubError> {
        let token = self.token_for_context(ctx, "merge pull request")?;
        Self::map(
            "merge pull request",
            prs::merge_pr(
                &ctx.workdir,
                &ctx.repository,
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
            prs::comment_pr(
                &ctx.workdir,
                &ctx.repository,
                number,
                body,
                token.as_deref(),
            ),
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
            prs::review_pr(
                &ctx.workdir,
                &ctx.repository,
                number,
                action,
                body,
                token.as_deref(),
            ),
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
            prs::set_pr_state(
                &ctx.workdir,
                &ctx.repository,
                number,
                action,
                token.as_deref(),
            ),
        )
    }

    fn create_pr(&self, ctx: &GithubContext, input: &PrCreateInput) -> Result<String, GithubError> {
        let token = self.token_for_context(ctx, "create pull request")?;
        Self::map(
            "create pull request",
            prs::create_pr(&ctx.workdir, &ctx.repository, input, token.as_deref()),
        )
    }

    fn reviewer_candidates(
        &self,
        ctx: &GithubContext,
    ) -> Result<Vec<PrReviewerCandidate>, GithubError> {
        let token = self.token_for_context(ctx, "list reviewers")?;
        Self::map(
            "list reviewers",
            prs::reviewer_candidates(&ctx.workdir, &ctx.repository, token.as_deref()),
        )
    }
}
