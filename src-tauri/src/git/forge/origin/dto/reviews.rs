use serde::Deserialize;

use crate::git::types::{PrAuthor, PrReview, ReviewState};

use super::OriginActor;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::git::forge::origin) struct OriginReview {
    #[serde(default)]
    author: Option<OriginActor>,
    #[serde(default)]
    author_id: String,
    #[serde(default, alias = "state", alias = "status")]
    verdict: String,
    #[serde(default)]
    dismissal: Option<OriginReviewDismissal>,
}

#[derive(Debug, Deserialize)]
struct OriginReviewDismissal {}

impl OriginReview {
    pub(in crate::git::forge::origin) fn into_review(self) -> PrReview {
        let author = self
            .author
            .map(OriginActor::into_author)
            .unwrap_or_else(|| PrAuthor {
                login: self.author_id.clone(),
                name: self.author_id,
            });
        let state = if self.dismissal.is_some() {
            ReviewState::Dismissed
        } else {
            match self.verdict.to_ascii_lowercase().as_str() {
                "approve" | "approved" => ReviewState::Approved,
                "request_changes" | "request-changes" | "changes_requested" => {
                    ReviewState::ChangesRequested
                }
                "comment" | "commented" => ReviewState::Commented,
                "dismissed" => ReviewState::Dismissed,
                _ => ReviewState::Other(self.verdict),
            }
        };
        PrReview { author, state }
    }
}

#[derive(Debug, Deserialize)]
pub(in crate::git::forge::origin) struct OriginReviewList {
    pub(in crate::git::forge::origin) reviews: Vec<OriginReview>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_verdicts_and_dismissal_from_camel_case_json() {
        let json = r#"{"reviews":[
            {"authorId":"ada","authorKind":"user","verdict":"approve","createdAt":"t"},
            {"authorId":"lin","verdict":"request_changes"},
            {"authorId":"sam","verdict":"comment"},
            {"authorId":"pat","verdict":"approve","dismissal":{"dismissedAt":"t","dismissedById":"ada","dismissedByKind":"user","dismissalMessage":"stale"}}
        ]}"#;
        let list: OriginReviewList = serde_json::from_str(json).unwrap();
        let reviews: Vec<_> = list
            .reviews
            .into_iter()
            .map(OriginReview::into_review)
            .collect();

        assert_eq!(reviews[0].author.login, "ada");
        assert_eq!(reviews[0].state, ReviewState::Approved);
        assert_eq!(reviews[1].state, ReviewState::ChangesRequested);
        assert_eq!(reviews[2].state, ReviewState::Commented);
        assert_eq!(reviews[3].state, ReviewState::Dismissed);
    }

    #[test]
    fn unknown_verdict_does_not_fail_the_payload() {
        let review: OriginReview =
            serde_json::from_str(r#"{"authorId":"ada","verdict":"future_verdict"}"#).unwrap();
        assert_eq!(
            review.into_review().state,
            ReviewState::Other("future_verdict".into())
        );
    }
}
