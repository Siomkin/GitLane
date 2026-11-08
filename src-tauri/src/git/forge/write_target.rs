//! Reads a pull request back before a write, so the write lands on the one the
//! user selected. A number alone can name a different pull request once the
//! open repository or its remote has changed.

use super::domain::{GithubContext, GithubError};
use super::ipc;
use super::service::GithubProvider;
use crate::git::types::CommandError;

/// A pull request a write will touch: its number, and the `url` of the row the
/// user acted on.
pub type PrTarget = (u64, String);

/// Pair each number with its URL, refusing rather than leaving one unchecked.
pub fn pr_targets(numbers: &[u64], urls: Vec<String>) -> Result<Vec<PrTarget>, GithubError> {
    if numbers.len() != urls.len() {
        return Err(GithubError::CommandFailed(
            "Each pull request to link needs its URL.".into(),
        ));
    }
    Ok(numbers.iter().copied().zip(urls).collect())
}

fn check_pr_target(
    provider: &dyn GithubProvider,
    ctx: &GithubContext,
    number: u64,
    selected_url: &str,
) -> Result<(), GithubError> {
    let current_url = provider.pr_url(ctx, number)?;
    let selected = selected_url.trim_end_matches('/');
    let current = current_url.trim_end_matches('/');
    let pr_noun = provider.identity().pr_noun;
    // Bitbucket and GitLab can omit the URL, and two empty strings prove nothing.
    if selected.is_empty() || current.is_empty() {
        return Err(GithubError::CommandFailed(format!(
            "GitLane couldn't confirm which {pr_noun} #{number} is, because the provider \
             didn't report its URL."
        )));
    }
    // Both URLs come from the provider, so a local remote URL with an old name
    // or different case cannot cause a false refusal. A row loaded before a
    // rename still holds the old URL and is refused until the list is refreshed.
    if selected.eq_ignore_ascii_case(current) {
        return Ok(());
    }
    Err(GithubError::CommandFailed(format!(
        "#{number} in this repository is no longer the {pr_noun} you selected. \
         Refresh the list and try again."
    )))
}

/// Run `write` only if every target still resolves to its selected URL, using
/// the context the write itself receives.
pub fn check_then_write<T>(
    provider: &dyn GithubProvider,
    ctx: &GithubContext,
    targets: &[PrTarget],
    write: impl FnOnce() -> Result<T, CommandError>,
) -> Result<T, CommandError> {
    for (number, selected_url) in targets {
        ipc(check_pr_target(provider, ctx, *number, selected_url))?;
    }
    write()
}

#[cfg(test)]
mod tests {
    use super::super::domain::GithubRepository;
    use super::super::gh_provider::GhProvider;
    use super::super::service::ForgeIdentity;
    use super::super::ApiAuthority;
    use super::*;
    use crate::git::types::{
        FileDiff, GithubAccountRef, MergeMethod, PrCommitList, PrCreateInput, PullRequestDetail,
        PullRequestMergeOutcome, PullRequestSummary,
    };
    use std::cell::Cell;

    const URL: &str = "https://github.com/acme/app/pull/7";

    /// Answers `pr_detail` with `url`, or fails when `url` is `None`.
    struct FakeProvider {
        url: Option<&'static str>,
    }

    impl GithubProvider for FakeProvider {
        fn identity(&self) -> ForgeIdentity {
            GhProvider.identity()
        }
        fn resolve_repository(
            &self,
            _: &str,
            _: Option<&GithubAccountRef>,
        ) -> Result<GithubRepository, GithubError> {
            unreachable!()
        }
        fn list_prs(&self, _: &GithubContext) -> Result<Vec<PullRequestSummary>, GithubError> {
            unreachable!()
        }
        fn pr_detail(&self, _: &GithubContext, _: u64) -> Result<PullRequestDetail, GithubError> {
            unreachable!("the read-back must not load the full detail")
        }
        fn pr_url(&self, _: &GithubContext, _: u64) -> Result<String, GithubError> {
            self.url
                .map(String::from)
                .ok_or_else(|| GithubError::CommandFailed("no such pull request".into()))
        }
        fn pr_commits(&self, _: &GithubContext, _: u64) -> Result<PrCommitList, GithubError> {
            unreachable!()
        }
        fn pr_diff(&self, _: &GithubContext, _: u64) -> Result<Vec<FileDiff>, GithubError> {
            unreachable!()
        }
        fn merge_pr(
            &self,
            _: &GithubContext,
            _: u64,
            _: MergeMethod,
            _: bool,
        ) -> Result<PullRequestMergeOutcome, GithubError> {
            unreachable!()
        }
        fn approve_pr(&self, _: &GithubContext, _: u64) -> Result<String, GithubError> {
            unreachable!()
        }
        fn create_pr(&self, _: &GithubContext, _: &PrCreateInput) -> Result<String, GithubError> {
            unreachable!()
        }
    }

    fn ctx() -> GithubContext {
        GithubContext {
            workdir: "/nonexistent".into(),
            repository: GithubRepository {
                host: ApiAuthority::new("github.com".into()),
                owner: "acme".into(),
                name: "app".into(),
            },
            account: None,
        }
    }

    /// Runs the guarded write once; the bool says whether the write was reached.
    fn attempt(
        current: Option<&'static str>,
        targets: &[PrTarget],
    ) -> (Result<(), CommandError>, bool) {
        let wrote = Cell::new(false);
        let result = check_then_write(&FakeProvider { url: current }, &ctx(), targets, || {
            wrote.set(true);
            Ok(())
        });
        (result, wrote.get())
    }

    #[test]
    fn a_matching_url_reaches_the_write() {
        let (result, wrote) = attempt(Some(URL), &[(7, URL.into())]);
        assert!(result.is_ok());
        assert!(wrote);
    }

    #[test]
    fn case_and_trailing_slash_differences_reach_the_write() {
        let selected = "https://GitHub.com/Acme/App/pull/7/";
        let (result, wrote) = attempt(Some(URL), &[(7, selected.into())]);
        assert!(result.is_ok());
        assert!(wrote);
    }

    #[test]
    fn a_different_pull_request_stops_before_the_write() {
        let elsewhere = "https://github.com/acme/other/pull/7";
        let (result, wrote) = attempt(Some(elsewhere), &[(7, URL.into())]);
        assert!(!wrote);
        assert!(result.unwrap_err().to_string().contains("Refresh the list"));
    }

    #[test]
    fn a_failed_read_back_stops_before_the_write() {
        let (result, wrote) = attempt(None, &[(7, URL.into())]);
        assert!(!wrote);
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("no such pull request"));
    }

    #[test]
    fn a_missing_url_stops_before_the_write_with_its_own_message() {
        for (current, selected) in [("", ""), ("", URL), (URL, ""), ("/", "/")] {
            let (result, wrote) = attempt(Some(current), &[(7, selected.into())]);
            assert!(!wrote);
            assert!(result.unwrap_err().to_string().contains("couldn't confirm"));
        }
    }

    #[test]
    fn one_stale_target_stops_a_multi_target_write() {
        let targets = [
            (7, URL.into()),
            (8, "https://github.com/acme/app/pull/8".into()),
        ];
        let (result, wrote) = attempt(Some(URL), &targets);
        assert!(result.is_err());
        assert!(!wrote);
    }

    #[test]
    fn numbers_and_urls_must_pair_up() {
        assert!(pr_targets(&[7, 8], vec![URL.into()]).is_err());
        assert_eq!(
            pr_targets(&[7], vec![URL.into()]).unwrap(),
            vec![(7, URL.to_string())]
        );
    }
}
