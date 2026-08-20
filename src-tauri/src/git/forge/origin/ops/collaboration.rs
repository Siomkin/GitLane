use crate::git::forge::domain::{GithubContext, GithubError};

use super::{repo_slug, run, run_stdin};

fn comment_command<'a>(
    repo: &str,
    number: u64,
    body: &'a str,
) -> Result<(Vec<String>, &'a str), GithubError> {
    if body.trim().is_empty() {
        return Err(GithubError::CommandFailed(
            "Comment body is empty.".to_string(),
        ));
    }
    Ok((
        vec![
            "pr".into(),
            "comment".into(),
            number.to_string(),
            "-F".into(),
            "-".into(),
            "-R".into(),
            repo.into(),
        ],
        body,
    ))
}

pub(in crate::git::forge::origin) fn comment_pr(
    ctx: &GithubContext,
    number: u64,
    body: &str,
) -> Result<String, GithubError> {
    let repo = repo_slug(&ctx.repository);
    let (args, stdin) = comment_command(&repo, number, body)?;
    run_stdin(ctx, &args, stdin)
}

fn review_command<'a>(
    repo: &str,
    number: u64,
    action: &str,
    body: &'a str,
) -> Result<(Vec<String>, Option<&'a str>), GithubError> {
    match action {
        "request-changes" => {
            return Err(GithubError::CommandFailed(
                "Request changes isn't supported by the Cursor Origin CLI yet.".to_string(),
            ))
        }
        "comment" => {
            return Err(GithubError::CommandFailed(
                "Formal comment-only reviews aren't supported for Cursor Origin pull requests in GitLane; post a top-level comment instead."
                    .to_string(),
            ))
        }
        "approve" => {}
        _ => {
            return Err(GithubError::CommandFailed(format!(
                "Unsupported Cursor Origin review action: {action}."
            )))
        }
    }

    let mut args = vec![
        "pr".into(),
        "review".into(),
        number.to_string(),
        "--approve".into(),
    ];
    let stdin = (!body.trim().is_empty()).then_some(body);
    if stdin.is_some() {
        args.extend(["-F".into(), "-".into()]);
    }
    args.extend(["-R".into(), repo.into()]);
    Ok((args, stdin))
}

pub(in crate::git::forge::origin) fn review_pr(
    ctx: &GithubContext,
    number: u64,
    action: &str,
    body: &str,
) -> Result<String, GithubError> {
    let repo = repo_slug(&ctx.repository);
    let (args, stdin) = review_command(&repo, number, action, body)?;
    match stdin {
        Some(stdin) => run_stdin(ctx, &args, stdin),
        None => run(ctx, &args),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn comment_uses_pinned_args_and_stdin_and_rejects_empty_input() {
        let (args, stdin) = comment_command("acme/app", 7, "Looks good\n").unwrap();
        assert_eq!(args, ["pr", "comment", "7", "-F", "-", "-R", "acme/app"]);
        assert_eq!(stdin, "Looks good\n");
        assert!(comment_command("acme/app", 7, " \n").is_err());
    }

    #[test]
    fn approval_uses_optional_stdin_body() {
        let (args, stdin) = review_command("acme/app", 7, "approve", "Ship it").unwrap();
        assert_eq!(
            args,
            [
                "pr",
                "review",
                "7",
                "--approve",
                "-F",
                "-",
                "-R",
                "acme/app"
            ]
        );
        assert_eq!(stdin, Some("Ship it"));

        let (args, stdin) = review_command("acme/app", 7, "approve", " ").unwrap();
        assert_eq!(args, ["pr", "review", "7", "--approve", "-R", "acme/app"]);
        assert_eq!(stdin, None);
    }

    #[test]
    fn unsupported_review_actions_fail_before_execution() {
        let request = review_command("acme/app", 7, "request-changes", "fix").unwrap_err();
        assert!(request.to_ipc_string().contains("Origin CLI"));

        let comment = review_command("acme/app", 7, "comment", "note").unwrap_err();
        assert!(comment.to_ipc_string().contains("top-level comment"));

        let unknown = review_command("acme/app", 7, "future", "").unwrap_err();
        assert!(unknown
            .to_ipc_string()
            .contains("Unsupported Cursor Origin review action"));
    }
}
