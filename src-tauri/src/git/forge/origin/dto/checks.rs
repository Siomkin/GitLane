use serde::Deserialize;

use crate::git::types::{CheckState, PrCheck};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::git::forge::origin) struct OriginCheck {
    #[serde(default)]
    name: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    conclusion: Option<String>,
    #[serde(default)]
    group: Option<OriginCheckGroup>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum OriginCheckGroup {
    Name(String),
    Detail {
        #[serde(default)]
        name: String,
    },
}

impl OriginCheck {
    pub(in crate::git::forge::origin) fn into_check(self) -> PrCheck {
        let group = match self.group {
            Some(OriginCheckGroup::Name(name)) => name,
            Some(OriginCheckGroup::Detail { name }) => name,
            None => String::new(),
        };
        let name = if group.trim().is_empty() {
            self.name
        } else {
            format!("{} / {}", group.trim(), self.name)
        };
        let state = if !self.status.is_empty() && !self.status.eq_ignore_ascii_case("completed") {
            CheckState::Pending
        } else {
            match self.conclusion.as_deref().unwrap_or_default() {
                "success" => CheckState::Pass,
                "failure" | "cancelled" => CheckState::Fail,
                "neutral" | "skipped" => CheckState::Skipped,
                _ => CheckState::Pending,
            }
        };
        PrCheck { name, state }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_status_conclusion_and_group_from_camel_case_json() {
        let fixtures = [
            (
                r#"{"name":"unit","status":"completed","conclusion":"success","group":{"id":"g1","name":"CI","detailsUrl":null}}"#,
                "CI / unit",
                CheckState::Pass,
            ),
            (
                r#"{"name":"lint","status":"completed","conclusion":"failure"}"#,
                "lint",
                CheckState::Fail,
            ),
            (
                r#"{"name":"cancelled","status":"completed","conclusion":"cancelled"}"#,
                "cancelled",
                CheckState::Fail,
            ),
            (
                r#"{"name":"neutral","status":"completed","conclusion":"neutral"}"#,
                "neutral",
                CheckState::Skipped,
            ),
            (
                r#"{"name":"queued","status":"in_progress","conclusion":"success"}"#,
                "queued",
                CheckState::Pending,
            ),
            (
                r#"{"name":"future","status":"completed","conclusion":"timed_out"}"#,
                "future",
                CheckState::Pending,
            ),
        ];

        for (json, name, state) in fixtures {
            let check: OriginCheck = serde_json::from_str(json).unwrap();
            let check = check.into_check();
            assert_eq!(check.name, name);
            assert_eq!(check.state, state);
        }
    }

    #[test]
    fn unknown_strings_do_not_fail_the_payload() {
        let check: OriginCheck = serde_json::from_str(
            r#"{"name":"future","status":"future_status","conclusion":"future_conclusion"}"#,
        )
        .unwrap();
        assert_eq!(check.into_check().state, CheckState::Pending);
    }
}
