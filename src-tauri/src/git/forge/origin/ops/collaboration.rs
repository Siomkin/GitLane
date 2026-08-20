use crate::git::forge::domain::{GithubContext, GithubError};

use super::{repo_slug, run};

fn approve_command(repo: &str, number: u64) -> Vec<String> {
    vec![
        "pr".into(),
        "review".into(),
        number.to_string(),
        "--approve".into(),
        "-R".into(),
        repo.into(),
    ]
}

pub(in crate::git::forge::origin) fn approve_pr(
    ctx: &GithubContext,
    number: u64,
) -> Result<String, GithubError> {
    run(ctx, &approve_command(&repo_slug(&ctx.repository), number))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn approval_accepts_no_action_or_body() {
        assert_eq!(
            approve_command("acme/app", 7),
            ["pr", "review", "7", "--approve", "-R", "acme/app"]
        );
    }
}
