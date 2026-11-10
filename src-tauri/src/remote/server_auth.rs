//! What to do on the server when a remote repository's fetch, pull or push
//! fails authentication (`remote/ssh-repos`: "No credentials on the server").
//! Git there uses the server's own credentials, so every fix happens there —
//! never with this computer's accounts.

use crate::git::types::{CommandError, CommandErrorKind};

/// Commands that authenticate to the repository's remote over git transport.
pub const TRANSPORT_COMMANDS: &[&str] = &[
    "fetch",
    "pull",
    "push_branch",
    "publish_branch",
    "force_push",
    "push_tag",
    "delete_remote_tag",
    "delete_remote_branch",
];

/// `err` with the server-side fix appended, when it is an auth failure.
/// `forge_kind` is the remote's forge key (`"github"`, `"gitlab"`, …) and
/// `remote_host` its host, both read from the server's remote configuration.
pub fn with_hint(
    mut err: CommandError,
    server: &str,
    forge_kind: Option<&str>,
    remote_host: Option<&str>,
) -> CommandError {
    if err.kind != CommandErrorKind::Auth {
        return err;
    }
    let target = remote_host.unwrap_or("the remote");
    let login = match (forge_kind, remote_host) {
        (Some("github"), Some(host)) => format!("run `gh auth login --hostname {host}` there, "),
        (Some("gitlab"), Some(host)) => format!("run `glab auth login --hostname {host}` there, "),
        _ => String::new(),
    };
    err.message = format!(
        "{}\n\nGit on {server} could not authenticate to {target}. To fix it on {server}: \
         {login}set up a git credential helper there, or switch the remote to an SSH URL. \
         The terminal opens on {server}.",
        err.message.trim_end()
    );
    err
}

#[cfg(test)]
mod tests {
    use super::*;

    fn auth() -> CommandError {
        CommandError::new(CommandErrorKind::Auth, "fatal: Authentication failed")
    }

    #[test]
    fn github_names_server_host_and_gh_login() {
        let err = with_hint(auth(), "devbox", Some("github"), Some("github.com"));
        assert!(err.message.starts_with("fatal: Authentication failed"));
        assert!(err
            .message
            .contains("Git on devbox could not authenticate to github.com"));
        assert!(err
            .message
            .contains("`gh auth login --hostname github.com`"));
        assert!(err.message.contains("credential helper"));
        assert!(err.message.contains("SSH URL"));
    }

    #[test]
    fn gitlab_suggests_glab() {
        let err = with_hint(
            auth(),
            "devbox",
            Some("gitlab"),
            Some("gitlab.example.test"),
        );
        assert!(err
            .message
            .contains("`glab auth login --hostname gitlab.example.test`"));
    }

    #[test]
    fn unknown_forge_still_names_server_and_never_this_computer() {
        let err = with_hint(auth(), "devbox", None, Some("git.example.test"));
        assert!(err.message.contains("devbox"));
        assert!(err.message.contains("git.example.test"));
        assert!(!err.message.contains("auth login"));
        for local in ["this computer", "Settings", "Accounts", "sign in"] {
            assert!(!err.message.contains(local), "{local}: {}", err.message);
        }
    }

    #[test]
    fn other_errors_are_untouched() {
        let err = CommandError::new(CommandErrorKind::Network, "unreachable");
        assert_eq!(
            with_hint(err, "devbox", Some("github"), Some("github.com")).message,
            "unreachable"
        );
    }
}
