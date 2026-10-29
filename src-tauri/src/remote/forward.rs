//! What changes as a command crosses to a host and its events come back:
//! locators become server paths on the way out, account references never
//! leave (`platform/git-invocation`), and only declared events with their paths
//! turned back into locators reach the webview.

use serde_json::Value;

use super::locator::{is_locator, Locator};
use crate::agent::dispatch::without_accounts;
use crate::events::{DELETE_WORKTREE_PROGRESS, HANDOFF_PROGRESS, REPO_CHANGED};

/// Parameters that name a repository or worktree path. Only these are
/// rewritten, so a commit or tag message that happens to contain `ssh://` is
/// sent unchanged.
const PATH_ARGS: &[&str] = &["path", "worktreePath", "fromWorktreePath", "toWorktreePath"];

/// The repository a command addresses, from its first locator path argument
/// (the same arguments the frontend routes on). `None` when it has none.
pub fn locator_of(args: &Value) -> Option<Result<Locator, String>> {
    PATH_ARGS
        .iter()
        .filter_map(|name| args.get(*name).and_then(Value::as_str))
        .find(|value| is_locator(value))
        .map(Locator::parse)
}

/// The arguments the agent receives: every path argument on `locator`'s host
/// as a server path, and no account references. A path argument on another
/// host is refused rather than sent to the wrong machine.
pub fn to_server_args(args: &Value, locator: &Locator) -> Result<Value, String> {
    let mut args = without_accounts(args);
    let origin = locator.origin();
    if let Some(map) = args.as_object_mut() {
        for name in PATH_ARGS {
            let Some(value) = map.get(*name).and_then(Value::as_str) else {
                continue;
            };
            if !is_locator(value) {
                continue;
            }
            let other = Locator::parse(value)?;
            if other.origin() != origin {
                return Err(format!(
                    "`{name}` is on {} but the repository is on {}.",
                    other.display_host(),
                    locator.display_host()
                ));
            }
            map.insert((*name).to_string(), Value::String(other.path));
        }
    }
    Ok(args)
}

/// The webview event for an agent event frame, with its path as a locator.
/// `None` for any name the agent may not raise: a server cannot make the
/// desktop emit arbitrary events.
pub fn to_webview_event(
    name: &str,
    mut payload: Value,
    locator: &Locator,
) -> Option<(&'static str, Value)> {
    let name = [REPO_CHANGED, HANDOFF_PROGRESS, DELETE_WORKTREE_PROGRESS]
        .into_iter()
        .find(|declared| *declared == name)?;
    if name == REPO_CHANGED {
        let path = payload.get("path").and_then(Value::as_str)?.to_string();
        payload["path"] = Value::String(locator.with_path(&path));
    }
    Some((name, payload))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn devbox() -> Locator {
        Locator::parse("ssh://devbox/srv/app").unwrap()
    }

    #[test]
    fn finds_the_locator_on_any_path_argument() {
        let l = locator_of(&json!({ "worktreePath": "ssh://devbox/srv/wt" }))
            .unwrap()
            .unwrap();
        assert_eq!(l.path, "/srv/wt");
        assert!(locator_of(&json!({ "path": "/local" })).is_none());
        assert!(locator_of(&json!({ "message": "ssh://devbox/x" })).is_none());
    }

    #[test]
    fn server_args_have_server_paths_and_no_accounts() {
        let args = json!({
            "path": "ssh://devbox/srv/app",
            "toWorktreePath": "ssh://devbox/srv/wt",
            "message": "see ssh://devbox/srv/app",
            "auth": { "provider": "gh", "login": "me" },
            "remoteAccounts": [],
        });
        assert_eq!(
            to_server_args(&args, &devbox()).unwrap(),
            json!({ "path": "/srv/app", "toWorktreePath": "/srv/wt", "message": "see ssh://devbox/srv/app" })
        );
    }

    #[test]
    fn a_path_on_another_host_is_refused() {
        let args = json!({ "path": "ssh://devbox/srv/app", "worktreePath": "ssh://other/srv/wt" });
        assert!(to_server_args(&args, &devbox())
            .unwrap_err()
            .contains("other"));
    }

    #[test]
    fn events_come_back_as_locators_and_only_declared_names_pass() {
        let (name, payload) = to_webview_event(
            REPO_CHANGED,
            json!({ "kind": "worktree", "path": "/srv/app" }),
            &devbox(),
        )
        .unwrap();
        assert_eq!(name, REPO_CHANGED);
        assert_eq!(payload["path"], "ssh://devbox/srv/app");

        let (name, payload) =
            to_webview_event(HANDOFF_PROGRESS, json!({ "step": "move" }), &devbox()).unwrap();
        assert_eq!(
            (name, payload),
            (HANDOFF_PROGRESS, json!({ "step": "move" }))
        );

        assert!(to_webview_event("pty-data", json!({}), &devbox()).is_none());
        assert!(to_webview_event("github-signin-progress", json!({}), &devbox()).is_none());
    }
}
