use crate::git::forge::domain::{GithubContext, GithubError};
use crate::git::types::PrReview;

use super::super::dto::{parse_json, OriginReview, OriginReviewList};
use super::{repo_slug, run};

fn view_reviews_args(repo: &str, number: u64) -> Vec<String> {
    vec![
        "pr".into(),
        "view".into(),
        number.to_string(),
        "--json".into(),
        "reviews".into(),
        "-R".into(),
        repo.into(),
    ]
}

pub(super) fn load_reviews(ctx: &GithubContext, number: u64) -> Result<Vec<PrReview>, GithubError> {
    let repo = repo_slug(&ctx.repository);
    let raw = run(ctx, &view_reviews_args(&repo, number))?;
    parse_reviews(&raw)
}

fn parse_reviews(raw: &str) -> Result<Vec<PrReview>, GithubError> {
    let reviews = parse_json::<OriginReviewList>(raw, "pull request reviews")
        .map(|list| list.reviews)
        .or_else(|_| parse_json::<Vec<OriginReview>>(raw, "pull request reviews"))?;
    Ok(reviews.into_iter().map(OriginReview::into_review).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::types::ReviewState;

    #[test]
    fn review_args_pin_number_field_and_repository() {
        assert_eq!(
            view_reviews_args("acme/app", 9),
            ["pr", "view", "9", "--json", "reviews", "-R", "acme/app"]
        );
    }

    #[test]
    fn parsed_reviews_populate_the_detail_contract() {
        let reviews = parse_reviews(
            r#"{"reviews":[{"authorId":"ada","verdict":"approve","createdAt":"t"}]}"#,
        )
        .unwrap();
        assert_eq!(reviews.len(), 1);
        assert_eq!(reviews[0].author.login, "ada");
        assert_eq!(reviews[0].state, ReviewState::Approved);
    }
}
