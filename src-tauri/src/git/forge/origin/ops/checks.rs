use crate::git::forge::domain::{GithubContext, GithubError};
use crate::git::types::PrCheck;

use super::super::dto::{parse_json, OriginCheck};
use super::{repo_slug, run};

fn checks_args(repo: &str, number: u64) -> Vec<String> {
    vec![
        "pr".into(),
        "checks".into(),
        number.to_string(),
        "--json".into(),
        "name,status,conclusion".into(),
        "-R".into(),
        repo.into(),
    ]
}

pub(in crate::git::forge::origin) fn pr_checks(
    ctx: &GithubContext,
    number: u64,
) -> Result<Vec<PrCheck>, GithubError> {
    let repo = repo_slug(&ctx.repository);
    let raw = run(ctx, &checks_args(&repo, number))?;
    parse_checks(&raw)
}

fn parse_checks(raw: &str) -> Result<Vec<PrCheck>, GithubError> {
    let checks: Vec<OriginCheck> = parse_json(raw, "pull request checks")?;
    Ok(checks.into_iter().map(OriginCheck::into_check).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::types::CheckState;

    #[test]
    fn checks_args_pin_number_fields_and_repository() {
        assert_eq!(
            checks_args("acme/app", 7),
            [
                "pr",
                "checks",
                "7",
                "--json",
                "name,status,conclusion",
                "-R",
                "acme/app"
            ]
        );
    }

    #[test]
    fn parses_empty_and_normalized_check_lists() {
        assert!(parse_checks("[]").unwrap().is_empty());
        let checks = parse_checks(
            r#"[
                {"name":"unit","status":"completed","conclusion":"success","group":{"name":"CI"}},
                {"name":"lint","status":"completed","conclusion":"skipped"},
                {"name":"future","status":"completed","conclusion":"timed_out"}
            ]"#,
        )
        .unwrap();
        assert_eq!(checks[0].name, "CI / unit");
        assert_eq!(checks[0].state, CheckState::Pass);
        assert_eq!(checks[1].state, CheckState::Skipped);
        assert_eq!(checks[2].state, CheckState::Pending);
    }
}
