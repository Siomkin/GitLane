use super::super::bounded_output::{CliError, DIFF_STDOUT_LIMIT};
use super::super::diff::parse_unified_diff;
use super::super::domain::{GithubContext, GithubError, GithubRepository};
use super::capabilities::ensure_supported;
use super::command::{run_origin, run_origin_with_limit};
use super::dto::{
    parse_json, parse_list, OriginCommentList, OriginCommitList, OriginPull, OriginPullList,
    OriginThread, OriginThreadList,
};
use crate::git::types::{
    FileDiff, MergeMethod, PrComment, PrCommitList, PrCreateInput, PrStateAction,
    PullRequestDetail, PullRequestMergeOutcome, PullRequestSummary, ReviewThreadList,
};

mod checks;
mod collaboration;
mod reviews;

pub(super) use checks::pr_checks;
pub(super) use collaboration::approve_pr;

pub(super) fn repo_slug(repository: &GithubRepository) -> String {
    format!("{}/{}", repository.owner, repository.name)
}

pub(super) fn list_prs_args(repo: &str) -> Vec<String> {
    // Origin's list defaults to open, like GitHub's REST. Ask for every state
    // so Closed/All can show merged PRs (`gh pr list --state all`).
    api_args("/repos/{owner}/{repo}/pulls?state=all&pageSize=100", repo)
}

pub(super) fn api_args(path: &str, repo: &str) -> Vec<String> {
    vec!["api".into(), path.into(), "-R".into(), repo.into()]
}

pub(super) fn view_comments_args(repo: &str, number: u64) -> Vec<String> {
    vec![
        "pr".into(),
        "view".into(),
        number.to_string(),
        "--json".into(),
        "comments".into(),
        "-R".into(),
        repo.into(),
    ]
}

pub(super) fn diff_args(repo: &str, number: u64) -> Vec<String> {
    vec![
        "pr".into(),
        "diff".into(),
        number.to_string(),
        "--patch".into(),
        "--color".into(),
        "never".into(),
        "-R".into(),
        repo.into(),
    ]
}

pub(super) fn thread_list_args(repo: &str, number: u64) -> Vec<String> {
    vec![
        "pr".into(),
        "thread".into(),
        "list".into(),
        number.to_string(),
        "-R".into(),
        repo.into(),
        "--json".into(),
        "id,resolved,path,startLine,comments".into(),
        "-c".into(),
    ]
}

pub(super) fn create_pr_args(
    repo: &str,
    input: &PrCreateInput,
) -> Result<Vec<String>, GithubError> {
    if input.title.trim().is_empty() {
        return Err(GithubError::CommandFailed(
            "A title is required to open a pull request.".to_string(),
        ));
    }
    Ok(vec![
        "pr".into(),
        "create".into(),
        "--head".into(),
        input.head.clone(),
        "--base".into(),
        input.base.clone(),
        "--title".into(),
        input.title.clone(),
        "--body".into(),
        input.body.clone(),
        "--status".into(),
        if input.draft { "draft" } else { "open" }.into(),
        "-R".into(),
        repo.into(),
    ])
}

pub(super) fn set_pr_state_args(repo: &str, number: u64, action: PrStateAction) -> Vec<String> {
    let action = match action {
        PrStateAction::Close => "close",
        PrStateAction::Reopen => "reopen",
        PrStateAction::Ready => "ready",
    };
    vec![
        "pr".into(),
        action.into(),
        number.to_string(),
        "-R".into(),
        repo.into(),
    ]
}

/// Origin merge is `--merge` or `--squash`. There is no rebase-merge flag and
/// no delete-branch flag (`origin pr merge --help`).
pub(super) fn merge_pr_args(
    repo: &str,
    number: u64,
    method: MergeMethod,
) -> Result<Vec<String>, GithubError> {
    let method_flag = match method {
        MergeMethod::Merge => "--merge",
        MergeMethod::Squash => "--squash",
        MergeMethod::Rebase => {
            return Err(GithubError::CommandFailed(
                "Rebase-and-merge isn't supported for Cursor Origin pull requests. Use Merge or Squash."
                    .to_string(),
            ))
        }
    };
    Ok(vec![
        "pr".into(),
        "merge".into(),
        number.to_string(),
        method_flag.into(),
        "-R".into(),
        repo.into(),
    ])
}

pub(super) fn thread_set_resolved_args(
    repo: &str,
    number: u64,
    thread_id: &str,
    resolved: bool,
) -> Vec<String> {
    vec![
        "pr".into(),
        "thread".into(),
        if resolved { "resolve" } else { "reopen" }.into(),
        thread_id.into(),
        number.to_string(),
        "-R".into(),
        repo.into(),
    ]
}

fn run(ctx: &GithubContext, args: &[String]) -> Result<String, GithubError> {
    ensure_supported()?;
    let argv: Vec<&str> = args.iter().map(String::as_str).collect();
    run_origin(&ctx.workdir, &argv).map_err(|err| map_origin_error(ctx, err))
}

fn run_diff(ctx: &GithubContext, args: &[String]) -> Result<String, GithubError> {
    ensure_supported()?;
    let argv: Vec<&str> = args.iter().map(String::as_str).collect();
    run_origin_with_limit(&ctx.workdir, &argv, DIFF_STDOUT_LIMIT)
        .map_err(|err| map_origin_error(ctx, err))
}

/// The Origin counterpart of `map_glab_error`: a signed-out or rejected session
/// is `NotAuthenticated` with Origin's own sign-in hint, so the UI offers the
/// "Fix authentication" action; everything else goes through the shared
/// classifier. The auth check runs first because the shared one would name
/// `gh auth login` for the same text.
fn map_origin_error(ctx: &GithubContext, err: CliError) -> GithubError {
    match err {
        CliError::Failed(err) if is_origin_auth_failure(&err) => GithubError::NotAuthenticated {
            host: ctx.repository.host.hostname().to_string(),
            account: None,
            hint: Some(
                "Your Cursor Origin session is signed out or expired. Run `origin auth login`, then retry."
                    .to_string(),
            ),
        },
        err => GithubError::from_command("Cursor Origin request", err),
    }
}

fn is_origin_auth_failure(err: &str) -> bool {
    let lower = err.to_ascii_lowercase();
    [
        "not logged in",
        "not signed in",
        "not authenticated",
        "unauthenticated",
        "unauthorized",
        "authentication",
        "bad credentials",
        "origin auth login",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

pub(super) fn list_prs(ctx: &GithubContext) -> Result<Vec<PullRequestSummary>, GithubError> {
    let repo = repo_slug(&ctx.repository);
    let raw = run(ctx, &list_prs_args(&repo))?;
    let list: OriginPullList = parse_pull_list(&raw)?;
    Ok(list
        .pulls
        .into_iter()
        .map(|p| p.into_summary(&ctx.repository.owner, &ctx.repository.name))
        .collect())
}

fn parse_pull_list(raw: &str) -> Result<OriginPullList, GithubError> {
    parse_list(raw, "pull request list", |pulls: Vec<OriginPull>| {
        OriginPullList { pulls }
    })
}

pub(super) fn pr_detail(
    ctx: &GithubContext,
    number: u64,
) -> Result<PullRequestDetail, GithubError> {
    let repo = repo_slug(&ctx.repository);
    let path = format!("/repos/{{owner}}/{{repo}}/pulls/{number}");
    let raw = run(ctx, &api_args(&path, &repo))?;
    let pull: OriginPull = parse_json(&raw, "pull request detail")?;
    let comments = load_comments(ctx, number)?;
    // Reviews are decoration on the detail: an Origin CLI that cannot serve the
    // `reviews` field leaves the list empty instead of hiding the whole pull
    // request behind a CLI error.
    let reviews = reviews::load_reviews(ctx, number).unwrap_or_default();
    let files = pr_diff(ctx, number)?.into_iter().map(|f| f.path).collect();
    Ok(pull.into_detail(
        &ctx.repository.owner,
        &ctx.repository.name,
        files,
        comments,
        reviews,
    ))
}

fn load_comments(ctx: &GithubContext, number: u64) -> Result<Vec<PrComment>, GithubError> {
    let repo = repo_slug(&ctx.repository);
    // REST `/pulls/{n}/comments` returns `{ "pullRequest": ... }`, not a comment
    // list. Discussion comments live on `origin pr view --json comments`.
    let raw = run(ctx, &view_comments_args(&repo, number))?;
    let list = parse_list(&raw, "pull request comments", |comments| {
        OriginCommentList { comments }
    })?;
    Ok(list
        .comments
        .into_iter()
        .map(|c| c.into_comment())
        .collect())
}

pub(super) fn pr_commits(ctx: &GithubContext, number: u64) -> Result<PrCommitList, GithubError> {
    let repo = repo_slug(&ctx.repository);
    let path = format!("/repos/{{owner}}/{{repo}}/pulls/{number}/commits?pageSize=100");
    let raw = run(ctx, &api_args(&path, &repo))?;
    parse_commit_list(&raw)
}

fn parse_commit_list(raw: &str) -> Result<PrCommitList, GithubError> {
    let list = parse_list(raw, "pull request commits", |commits| OriginCommitList {
        commits,
        truncated: false,
    })?;
    Ok(PrCommitList {
        truncated: list.truncated,
        commits: list.commits.into_iter().map(|c| c.into_commit()).collect(),
    })
}

pub(super) fn pr_diff(ctx: &GithubContext, number: u64) -> Result<Vec<FileDiff>, GithubError> {
    let repo = repo_slug(&ctx.repository);
    let raw = run_diff(ctx, &diff_args(&repo, number))?;
    Ok(parse_unified_diff(&raw))
}

pub(super) fn review_threads(
    ctx: &GithubContext,
    number: u64,
) -> Result<ReviewThreadList, GithubError> {
    let repo = repo_slug(&ctx.repository);
    let raw = run(ctx, &thread_list_args(&repo, number))?;
    let threads = parse_threads(&raw)?;
    Ok(ReviewThreadList {
        truncated: false,
        threads: threads.into_iter().map(OriginThread::into_thread).collect(),
    })
}

fn parse_threads(raw: &str) -> Result<Vec<OriginThread>, GithubError> {
    parse_list(raw, "review threads", |threads| OriginThreadList {
        threads,
    })
    .map(|list| list.threads)
}

pub(super) fn create_pr(ctx: &GithubContext, input: &PrCreateInput) -> Result<String, GithubError> {
    let repo = repo_slug(&ctx.repository);
    run(ctx, &create_pr_args(&repo, input)?)
}

pub(super) fn set_pr_state(
    ctx: &GithubContext,
    number: u64,
    action: PrStateAction,
) -> Result<String, GithubError> {
    let repo = repo_slug(&ctx.repository);
    run(ctx, &set_pr_state_args(&repo, number, action))
}

pub(super) fn merge_pr(
    ctx: &GithubContext,
    number: u64,
    method: MergeMethod,
    _delete_branch: bool,
) -> Result<PullRequestMergeOutcome, GithubError> {
    let repo = repo_slug(&ctx.repository);
    run(ctx, &merge_pr_args(&repo, number, method)?)?;
    Ok(PullRequestMergeOutcome::default())
}

pub(super) fn set_thread_resolved(
    ctx: &GithubContext,
    number: u64,
    thread_id: &str,
    resolved: bool,
) -> Result<String, GithubError> {
    let repo = repo_slug(&ctx.repository);
    run(
        ctx,
        &thread_set_resolved_args(&repo, number, thread_id, resolved),
    )?;
    Ok(if resolved {
        "Thread resolved.".to_string()
    } else {
        "Thread reopened.".to_string()
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_signed_out_origin_session_is_an_auth_error_naming_origin_login() {
        let ctx = GithubContext {
            workdir: ".".into(),
            repository: GithubRepository {
                host: crate::git::forge::ApiAuthority::new("origin.cursor.com".into()),
                owner: "acme".into(),
                name: "app".into(),
            },
            account: None,
        };
        for failure in [
            "Error: not signed in. Run `origin auth login` to sign in.",
            "HTTP 401 Unauthorized",
            "api error: Bad credentials",
        ] {
            let error = map_origin_error(&ctx, CliError::Failed(failure.to_string()));
            let message = error.to_ipc_string();
            assert!(message.contains("origin auth login"), "{message}");
            assert!(!message.contains("gh auth"), "{message}");
            assert_eq!(
                crate::git::types::CommandError::from(error).kind,
                crate::git::types::CommandErrorKind::Auth,
                "{failure}"
            );
        }
        let other = map_origin_error(&ctx, CliError::Failed("pull request 7 not found".into()));
        assert!(matches!(other, GithubError::CommandFailed(_)), "{other:?}");
    }

    use super::*;

    fn create_input(draft: bool) -> PrCreateInput {
        PrCreateInput {
            base: "main".into(),
            head: "feature/origin-prs".into(),
            title: "Origin PR support".into(),
            body: "Create and manage pull requests.".into(),
            draft,
            reviewers: vec![],
        }
    }

    #[test]
    fn api_args_target_repo_without_version_flags() {
        let args = api_args("/repos/{owner}/{repo}/pulls", "acme/app");
        assert_eq!(
            args,
            ["api", "/repos/{owner}/{repo}/pulls", "-R", "acme/app"]
        );
        assert!(!args.iter().any(|a| a == "--version"));
    }

    #[test]
    fn list_prs_args_request_every_state() {
        assert_eq!(
            list_prs_args("acme/app"),
            [
                "api",
                "/repos/{owner}/{repo}/pulls?state=all&pageSize=100",
                "-R",
                "acme/app"
            ]
        );
    }

    #[test]
    fn thread_args_use_resolve_or_reopen() {
        assert_eq!(
            thread_set_resolved_args("acme/app", 7, "t_1", true),
            ["pr", "thread", "resolve", "t_1", "7", "-R", "acme/app"]
        );
        assert_eq!(
            thread_set_resolved_args("acme/app", 7, "t_1", false),
            ["pr", "thread", "reopen", "t_1", "7", "-R", "acme/app"]
        );
    }

    #[test]
    fn create_pr_args_set_explicit_open_or_draft_status() {
        let open = create_pr_args("acme/app", &create_input(false)).unwrap();
        assert_eq!(
            open,
            [
                "pr",
                "create",
                "--head",
                "feature/origin-prs",
                "--base",
                "main",
                "--title",
                "Origin PR support",
                "--body",
                "Create and manage pull requests.",
                "--status",
                "open",
                "-R",
                "acme/app"
            ]
        );

        let draft = create_pr_args("acme/app", &create_input(true)).unwrap();
        assert_eq!(
            draft[draft.len() - 4..],
            ["--status", "draft", "-R", "acme/app"]
        );
    }

    #[test]
    fn set_pr_state_args_map_every_action() {
        for (action, word) in [
            (PrStateAction::Close, "close"),
            (PrStateAction::Reopen, "reopen"),
            (PrStateAction::Ready, "ready"),
        ] {
            assert_eq!(
                set_pr_state_args("acme/app", 7, action),
                ["pr", word, "7", "-R", "acme/app"]
            );
        }
    }

    #[test]
    fn commit_list_preserves_origin_truncation() {
        let list = parse_commit_list(r#"{"commits":[],"truncated":true}"#).unwrap();
        assert!(list.truncated);
    }

    #[test]
    fn diff_args_request_patch_without_json() {
        let args = diff_args("acme/app", 9);
        assert!(args.contains(&"--patch".to_string()));
        assert!(!args.iter().any(|a| a == "--json"));
    }

    #[test]
    fn view_comments_args_request_json_comments() {
        assert_eq!(
            view_comments_args("acme/app", 1),
            ["pr", "view", "1", "--json", "comments", "-R", "acme/app"]
        );
    }

    #[test]
    fn merge_pr_args_use_squash_or_merge_and_refuse_rebase() {
        assert_eq!(
            merge_pr_args("acme/app", 1, MergeMethod::Squash).unwrap(),
            ["pr", "merge", "1", "--squash", "-R", "acme/app"]
        );
        assert_eq!(
            merge_pr_args("acme/app", 1, MergeMethod::Merge).unwrap(),
            ["pr", "merge", "1", "--merge", "-R", "acme/app"]
        );
        let err = merge_pr_args("acme/app", 1, MergeMethod::Rebase).unwrap_err();
        let msg = err.to_ipc_string();
        assert!(msg.contains("Rebase-and-merge isn't supported"), "{msg}");
        assert!(!msg.contains("gh"), "{msg}");
    }

    /// An object on stdout that is not the list wrapper — here an error body on
    /// a zero exit — must fail like its sibling lists, not render as no PRs or
    /// no threads.
    #[test]
    fn an_unexpected_object_is_an_error_not_an_empty_list() {
        let raw = r#"{"error":"x"}"#;
        assert!(parse_pull_list(raw).is_err());
        assert!(parse_threads(raw).is_err());
        assert!(parse_commit_list(raw).is_err());
        // Both accepted shapes still parse.
        assert!(parse_pull_list(r#"{"pullRequests":[]}"#)
            .unwrap()
            .pulls
            .is_empty());
        assert!(parse_pull_list("[]").unwrap().pulls.is_empty());
        assert!(parse_threads(r#"{"threads":[]}"#).unwrap().is_empty());
        assert!(parse_threads("[]").unwrap().is_empty());
    }
}
