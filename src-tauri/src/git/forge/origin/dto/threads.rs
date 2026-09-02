use serde::Deserialize;

use crate::git::types::ReviewThread;

use super::OriginComment;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::git::forge::origin) struct OriginThread {
    #[serde(default)]
    id: String,
    #[serde(default)]
    resolved: bool,
    #[serde(default)]
    path: Option<String>,
    #[serde(default, alias = "startLine")]
    line: Option<u32>,
    #[serde(default)]
    comments: Vec<OriginComment>,
}

impl OriginThread {
    pub(in crate::git::forge::origin) fn into_thread(self) -> ReviewThread {
        ReviewThread {
            id: self.id,
            path: self.path.unwrap_or_default(),
            line: self.line,
            is_resolved: self.resolved,
            is_outdated: false,
            comments_truncated: false,
            diff_hunk: None,
            comments: self
                .comments
                .into_iter()
                .map(OriginComment::into_comment)
                .collect(),
        }
    }
}

#[derive(Debug, Deserialize)]
pub(in crate::git::forge::origin) struct OriginThreadList {
    #[serde(default)]
    pub(in crate::git::forge::origin) threads: Vec<OriginThread>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_origin_thread_json_with_nullable_path_and_cli_field_names() {
        let thread: OriginThread = serde_json::from_str(
            r#"{"id":"t_1","resolved":false,"path":null,"startLine":12,"comments":[{"body":"Fixed","authorId":"ada","createdAt":"t"}]}"#,
        )
        .unwrap();
        let thread = thread.into_thread();
        assert_eq!(thread.path, "");
        assert_eq!(thread.line, Some(12));
        assert_eq!(thread.comments[0].author.login, "ada");
        assert_eq!(thread.diff_hunk, None);
    }
}
