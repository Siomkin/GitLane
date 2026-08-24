use serde::Deserialize;

use super::{GqlAuthor, GqlNodes};
use crate::git::types::{PrAuthor, PrComment, ReviewThread};

// ---- GraphQL review-thread response shapes ----

#[derive(Deserialize)]
pub(in crate::git::forge) struct GqlThreadsResp {
    pub(in crate::git::forge) data: GqlThreadsData,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::git::forge) struct GqlThreadsData {
    pub(in crate::git::forge) repository: GqlThreadsRepo,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::git::forge) struct GqlThreadsRepo {
    pub(in crate::git::forge) pull_request: GqlThreadsPr,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::git::forge) struct GqlThreadsPr {
    pub(in crate::git::forge) review_threads: GqlNodes<GqlThread>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::git::forge) struct GqlThread {
    pub(in crate::git::forge) id: String,
    #[serde(default)]
    pub(in crate::git::forge) path: String,
    pub(in crate::git::forge) line: Option<u32>,
    #[serde(default)]
    pub(in crate::git::forge) is_resolved: bool,
    #[serde(default)]
    pub(in crate::git::forge) is_outdated: bool,
    pub(in crate::git::forge) comments: GqlNodes<GqlThreadComment>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::git::forge) struct GqlThreadComment {
    pub(in crate::git::forge) author: Option<GqlAuthor>,
    #[serde(default)]
    pub(in crate::git::forge) body: String,
    #[serde(default)]
    pub(in crate::git::forge) created_at: String,
    /// First comment's hunk is the thread snippet; replies share it.
    #[serde(default)]
    pub(in crate::git::forge) diff_hunk: Option<String>,
}

impl GqlThread {
    pub(in crate::git::forge) fn into_thread(self) -> ReviewThread {
        // The query caps comments per thread (no nested pagination); GitHub's
        // totalCount tells us when that cap actually cut something off.
        let comments_truncated = self
            .comments
            .total_count
            .is_some_and(|total| total > self.comments.nodes.len() as u64);
        // Empty GitHub `diffHunk` is "no snippet", not an empty card.
        let diff_hunk = self.comments.nodes.first().and_then(|c| {
            c.diff_hunk
                .as_deref()
                .filter(|hunk| !hunk.is_empty())
                .map(str::to_string)
        });
        ReviewThread {
            id: self.id,
            path: self.path,
            line: self.line,
            is_resolved: self.is_resolved,
            is_outdated: self.is_outdated,
            comments_truncated,
            diff_hunk,
            comments: self
                .comments
                .nodes
                .into_iter()
                .map(|c| {
                    // A deleted author serializes as null; fall back to "ghost".
                    let login = c.author.map(|a| a.login).unwrap_or_default();
                    let name = if login.is_empty() {
                        "ghost".to_string()
                    } else {
                        login.clone()
                    };
                    PrComment {
                        author: PrAuthor { name, login },
                        body: c.body,
                        created_at: c.created_at,
                    }
                })
                .collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- deleted comment authors (GqlThread::into_thread) ----

    #[test]
    fn deleted_thread_author_renders_as_ghost() {
        let thread = GqlThread {
            id: "T_1".into(),
            path: "src/foo.rs".into(),
            line: Some(10),
            is_resolved: false,
            is_outdated: false,
            comments: GqlNodes {
                nodes: vec![
                    GqlThreadComment {
                        author: None,
                        body: "deleted user".into(),
                        created_at: "t".into(),
                        diff_hunk: None,
                    },
                    GqlThreadComment {
                        author: Some(GqlAuthor {
                            login: "octocat".into(),
                        }),
                        body: "alive".into(),
                        created_at: "t".into(),
                        diff_hunk: None,
                    },
                ],
                page_info: None,
                total_count: None,
            },
        };
        let mapped = thread.into_thread();
        assert_eq!(mapped.comments.len(), 2);
        assert!(!mapped.comments_truncated);
        // null author → login empty, display name "ghost".
        assert_eq!(mapped.comments[0].author.login, "");
        assert_eq!(mapped.comments[0].author.name, "ghost");
        // present author → name == login.
        assert_eq!(mapped.comments[1].author.login, "octocat");
        assert_eq!(mapped.comments[1].author.name, "octocat");
        assert_eq!(mapped.line, Some(10));
        assert!(!mapped.is_resolved);
        assert_eq!(mapped.diff_hunk, None);
    }

    fn thread_from_json(raw: &str) -> ReviewThread {
        serde_json::from_str::<GqlThread>(raw)
            .expect("thread JSON")
            .into_thread()
    }

    #[test]
    fn maps_first_comment_diff_hunk() {
        let mapped = thread_from_json(
            r#"{
                "id":"T_1","path":"src/foo.rs","line":10,
                "isResolved":false,"isOutdated":false,
                "comments":{"nodes":[
                    {"author":{"login":"octocat"},"body":"nits","createdAt":"t",
                     "diffHunk":"@@ -1,2 +1,3 @@\n context\n-old\n+new"},
                    {"author":{"login":"octocat"},"body":"reply","createdAt":"t",
                     "diffHunk":"ignored"}
                ]}
            }"#,
        );
        assert_eq!(
            mapped.diff_hunk.as_deref(),
            Some("@@ -1,2 +1,3 @@\n context\n-old\n+new")
        );
    }

    #[test]
    fn missing_diff_hunk_is_none() {
        let mapped = thread_from_json(
            r#"{
                "id":"T_1","path":"src/foo.rs","line":10,
                "isResolved":false,"isOutdated":false,
                "comments":{"nodes":[
                    {"author":{"login":"octocat"},"body":"nits","createdAt":"t"}
                ]}
            }"#,
        );
        assert_eq!(mapped.diff_hunk, None);
    }

    #[test]
    fn empty_diff_hunk_is_none() {
        let mapped = thread_from_json(
            r#"{
                "id":"T_1","path":"src/foo.rs","line":10,
                "isResolved":false,"isOutdated":false,
                "comments":{"nodes":[
                    {"author":{"login":"octocat"},"body":"nits","createdAt":"t","diffHunk":""}
                ]}
            }"#,
        );
        assert_eq!(mapped.diff_hunk, None);
    }
}
