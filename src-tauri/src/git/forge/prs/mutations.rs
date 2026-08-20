//! PR write operations over `gh pr` verbs, plus the reviewer picker source.

use super::super::cli::{repo_selector, run_gh};
use super::super::domain::GithubRepository;
use super::super::dto::*;
use super::target_repository;
use crate::git::types::{PrCreateInput, PrReviewerCandidate};

/// Submit a bodyless approval.
pub fn approve_pr(
    workdir: &str,
    repository: &GithubRepository,
    number: u64,
    token: Option<&str>,
) -> Result<String, String> {
    let num = number.to_string();
    let repo = repo_selector(repository);
    let args = approve_pr_args(&repo, &num);
    run_gh(workdir, &args, token)
}

fn approve_pr_args<'a>(repository: &'a str, num: &'a str) -> Vec<&'a str> {
    target_repository(vec!["pr", "review", num, "--approve"], repository)
}

/// Change a PR's lifecycle state. `action` is "close" | "reopen" | "ready"
/// (mark a draft ready for review).
pub fn set_pr_state(
    workdir: &str,
    repository: &GithubRepository,
    number: u64,
    action: &str,
    token: Option<&str>,
) -> Result<String, String> {
    let num = number.to_string();
    let repo = repo_selector(repository);
    let args = set_pr_state_args(&repo, &num, action);
    run_gh(workdir, &args, token)
}

/// Pure argument builder for [`set_pr_state`].
fn set_pr_state_args<'a>(repository: &'a str, num: &'a str, action: &'a str) -> Vec<&'a str> {
    let sub = match action {
        "reopen" => "reopen",
        "ready" => "ready",
        _ => "close",
    };
    target_repository(vec!["pr", sub, num], repository)
}

/// Open a new PR from `head` into `base`. Returns gh's output (the new PR URL).
pub fn create_pr(
    workdir: &str,
    repository: &GithubRepository,
    input: &PrCreateInput,
    token: Option<&str>,
) -> Result<String, String> {
    if input.title.trim().is_empty() {
        return Err("A title is required to open a pull request.".to_string());
    }
    let repo = repo_selector(repository);
    let args = create_pr_args(&repo, input);
    run_gh(workdir, &args, token)
}

/// Pure argument builder for [`create_pr`].
///
/// `--reviewer` is repeated per login, which is how `gh` takes more than one.
fn create_pr_args<'a>(repository: &'a str, input: &'a PrCreateInput) -> Vec<&'a str> {
    let mut args = vec![
        "pr",
        "create",
        "--base",
        &input.base,
        "--head",
        &input.head,
        "--title",
        &input.title,
        "--body",
        &input.body,
    ];
    if input.draft {
        args.push("--draft");
    }
    for reviewer in &input.reviewers {
        args.push("--reviewer");
        args.push(reviewer);
    }
    target_repository(args, repository)
}

/// Repository collaborators, as review-request candidates.
///
/// `gh api` rather than `gh pr`: there is no `gh pr reviewers` subcommand, and
/// the collaborators endpoint is the same list GitHub's own reviewer picker
/// offers. A caller without push access gets a 403, which surfaces as "no
/// candidates" rather than an error — the reviewer row is optional, and failing
/// the whole dialog over it would be worse than hiding a picker.
pub fn reviewer_candidates(
    workdir: &str,
    repository: &GithubRepository,
    token: Option<&str>,
) -> Result<Vec<PrReviewerCandidate>, String> {
    let repo = repo_selector(repository);
    let path = format!("repos/{repo}/collaborators?per_page=100");
    let args = vec!["api", path.as_str(), "--hostname", &repository.host];
    let Ok(raw) = run_gh(workdir, &args, token) else {
        return Ok(Vec::new());
    };
    let parsed: Vec<GhCollaborator> = serde_json::from_str(&raw).unwrap_or_default();
    Ok(parsed
        .into_iter()
        .map(|user| PrReviewerCandidate {
            name: user.name.clone().unwrap_or_else(|| user.login.clone()),
            login: user.login,
            avatar_url: user.avatar_url,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::super::TARGET;
    use super::*;

    fn repository() -> GithubRepository {
        GithubRepository {
            host: "ghe.example.test:8443".into(),
            owner: "octo".into(),
            name: "app".into(),
        }
    }

    fn create_input(title: &str) -> PrCreateInput {
        PrCreateInput {
            base: "main".to_string(),
            head: "feat".to_string(),
            title: title.to_string(),
            body: "b".to_string(),
            draft: false,
            reviewers: Vec::new(),
        }
    }

    #[test]
    fn create_pr_rejects_empty_title() {
        let msg = "A title is required to open a pull request.";
        assert_eq!(
            create_pr(".", &repository(), &create_input(""), None).unwrap_err(),
            msg
        );
        assert_eq!(
            create_pr(".", &repository(), &create_input("  "), None).unwrap_err(),
            msg
        );
    }

    #[test]
    fn approve_pr_args_accept_no_action_or_body() {
        assert_eq!(
            approve_pr_args(TARGET, "7"),
            vec!["pr", "review", "7", "--approve", "--repo", TARGET]
        );
    }

    #[test]
    fn set_pr_state_args_map_action_to_subcommand() {
        assert_eq!(
            set_pr_state_args(TARGET, "7", "close"),
            vec!["pr", "close", "7", "--repo", TARGET]
        );
        assert_eq!(
            set_pr_state_args(TARGET, "7", "reopen"),
            vec!["pr", "reopen", "7", "--repo", TARGET]
        );
        assert_eq!(
            set_pr_state_args(TARGET, "7", "ready"),
            vec!["pr", "ready", "7", "--repo", TARGET]
        );
        // Unknown action defaults to close (historical behaviour).
        assert_eq!(
            set_pr_state_args(TARGET, "7", "bogus"),
            vec!["pr", "close", "7", "--repo", TARGET]
        );
    }

    #[test]
    fn create_pr_args_preserve_order_and_draft_flag() {
        let input = create_input("t");
        assert_eq!(
            create_pr_args(TARGET, &input),
            vec![
                "pr", "create", "--base", "main", "--head", "feat", "--title", "t", "--body", "b",
                "--repo", TARGET
            ]
        );
        let draft = PrCreateInput {
            draft: true,
            ..create_input("t")
        };
        assert_eq!(
            create_pr_args(TARGET, &draft),
            vec![
                "pr", "create", "--base", "main", "--head", "feat", "--title", "t", "--body", "b",
                "--draft", "--repo", TARGET
            ]
        );
    }

    #[test]
    fn create_pr_args_repeat_the_reviewer_flag_per_login() {
        let input = PrCreateInput {
            reviewers: vec!["octocat".to_string(), "hubot".to_string()],
            ..create_input("t")
        };
        assert_eq!(
            create_pr_args(TARGET, &input),
            vec![
                "pr",
                "create",
                "--base",
                "main",
                "--head",
                "feat",
                "--title",
                "t",
                "--body",
                "b",
                "--reviewer",
                "octocat",
                "--reviewer",
                "hubot",
                "--repo",
                TARGET
            ]
        );
    }
}
