//! Cursor Origin pull-request provider.
//!
//! Selected when the repo remote is `origin.cursor.com`. Shells out to the
//! user's `origin` CLI — structured reads through `origin api`, patch and
//! existing-thread operations through `origin pr`. GitLane never stores or
//! returns Origin tokens.

mod account;
mod capabilities;
mod command;
mod dto;
mod ops;

pub(crate) use account::current_account;
pub(crate) use capabilities::OriginCapabilities;

use crate::git::forge;
use crate::git::types::{
    FileDiff, GithubAccountRef, PrCheck, PrCommitList, PrCreateInput, PullRequestDetail,
    PullRequestMergeOutcome, PullRequestSummary, ReviewThreadList,
};

use super::domain::{GithubContext, GithubError, GithubRepository};
use super::service::{ForgeIdentity, GithubProvider};
use super::ForgeKind;

pub struct OriginProvider;

impl GithubProvider for OriginProvider {
    fn identity(&self) -> ForgeIdentity {
        ForgeIdentity {
            key: ForgeKind::CursorOrigin.key(),
            pr_noun: "Cursor Origin pull request",
        }
    }

    fn resolve_repository(
        &self,
        workdir: &str,
        _account: Option<&GithubAccountRef>,
    ) -> Result<GithubRepository, GithubError> {
        let (host, project) = forge::origin_project(workdir).ok_or_else(|| {
            GithubError::CommandFailed(format!(
                "Could not resolve a Cursor Origin repository for {workdir}. Check that the repo has an {} remote.",
                ForgeKind::CURSOR_ORIGIN_HOST
            ))
        })?;
        let (owner, name) = project
            .split_once('/')
            .filter(|(owner, name)| !owner.is_empty() && !name.is_empty() && !name.contains('/'))
            .ok_or_else(|| GithubError::RepositoryNotFound {
                workdir: workdir.to_string(),
            })?;
        Ok(GithubRepository {
            host: host.into(),
            owner: owner.to_string(),
            name: name.to_string(),
        })
    }

    fn list_prs(&self, ctx: &GithubContext) -> Result<Vec<PullRequestSummary>, GithubError> {
        ops::list_prs(ctx)
    }

    fn pr_detail(
        &self,
        ctx: &GithubContext,
        number: u64,
    ) -> Result<PullRequestDetail, GithubError> {
        ops::pr_detail(ctx, number)
    }

    fn pr_commits(&self, ctx: &GithubContext, number: u64) -> Result<PrCommitList, GithubError> {
        ops::pr_commits(ctx, number)
    }

    fn pr_diff(&self, ctx: &GithubContext, number: u64) -> Result<Vec<FileDiff>, GithubError> {
        ops::pr_diff(ctx, number)
    }

    fn pr_checks(&self, ctx: &GithubContext, number: u64) -> Result<Vec<PrCheck>, GithubError> {
        ops::pr_checks(ctx, number)
    }

    fn review_threads(
        &self,
        ctx: &GithubContext,
        number: u64,
    ) -> Result<ReviewThreadList, GithubError> {
        ops::review_threads(ctx, number)
    }

    fn set_thread_resolved(
        &self,
        ctx: &GithubContext,
        number: u64,
        thread_id: &str,
        resolved: bool,
    ) -> Result<String, GithubError> {
        ops::set_thread_resolved(ctx, number, thread_id, resolved)
    }

    fn merge_pr(
        &self,
        ctx: &GithubContext,
        number: u64,
        method: &str,
        delete_branch: bool,
    ) -> Result<PullRequestMergeOutcome, GithubError> {
        // Origin has no delete-branch flag; the CLI merge is the whole outcome.
        ops::merge_pr(ctx, number, method, delete_branch)
    }

    fn approve_pr(&self, ctx: &GithubContext, number: u64) -> Result<String, GithubError> {
        ops::approve_pr(ctx, number)
    }

    fn create_pr(&self, ctx: &GithubContext, input: &PrCreateInput) -> Result<String, GithubError> {
        ops::create_pr(ctx, input)
    }

    fn set_pr_state(
        &self,
        ctx: &GithubContext,
        number: u64,
        action: &str,
    ) -> Result<String, GithubError> {
        ops::set_pr_state(ctx, number, action)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unsupported_messages_are_origin_specific() {
        let p = OriginProvider;
        let msg = p.unsupported("Editing").to_ipc_string();
        assert!(msg.contains("Cursor Origin pull request"), "{msg}");
        assert!(!msg.contains("gh auth"), "{msg}");
    }
}
