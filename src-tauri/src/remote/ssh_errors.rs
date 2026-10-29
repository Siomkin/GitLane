//! Turn a failed `ssh` session into the error the user sees
//! (`remote/ssh-repos`: key/agent auth only, host trust never changed). Every
//! failure is `remoteUnavailable`, names the host, and carries a stable `code`
//! the frontend picks copy by.

use crate::git::types::{CommandError, CommandErrorKind};

pub const SSH_AUTH_REQUIRED: &str = "sshAuthRequired";
pub const SSH_HOST_KEY: &str = "sshHostKey";
pub const UNREACHABLE: &str = "unreachable";
pub const DISCONNECTED: &str = "disconnected";
pub const UNSUPPORTED_PLATFORM: &str = "unsupportedPlatform";
pub const AGENT_INSTALL: &str = "agentInstall";

pub fn unavailable(code: &str, message: String) -> CommandError {
    CommandError::new(CommandErrorKind::RemoteUnavailable, message).with_code(code)
}

/// The session ended while requests were waiting, or a request found it closed.
pub fn disconnected(host: &str) -> CommandError {
    unavailable(DISCONNECTED, format!("The connection to {host} was lost."))
}

/// Classify why `ssh` exited before the agent said hello, from its stderr.
pub fn classify(host: &str, stderr: &str) -> CommandError {
    let text = stderr.to_ascii_lowercase();
    let detail = last_line(stderr);
    if text.contains("remote host identification has changed")
        || text.contains("host key verification failed")
        || text.contains("host key for")
        || text.contains("no matching host key")
    {
        return unavailable(
            SSH_HOST_KEY,
            format!(
                "{host}'s host key is not trusted on this computer (unknown or changed). \
                 Verify it by connecting once from a terminal: ssh {host}"
            ),
        );
    }
    if text.contains("permission denied")
        || text.contains("too many authentication failures")
        || text.contains("no more authentication methods")
    {
        return unavailable(
            SSH_AUTH_REQUIRED,
            format!(
                "{host} did not accept key-based authentication. GitLane connects with \
                 your SSH keys or ssh-agent and cannot answer password or one-time-code \
                 prompts.{}",
                detail.map(|d| format!(" ({d})")).unwrap_or_default()
            ),
        );
    }
    unavailable(
        UNREACHABLE,
        match detail {
            Some(d) => format!("Could not connect to {host}: {d}"),
            None => format!("Could not connect to {host}."),
        },
    )
}

fn last_line(stderr: &str) -> Option<String> {
    stderr
        .lines()
        .map(str::trim)
        .rfind(|l| !l.is_empty())
        .map(crate::redact::redact_secrets)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn code(stderr: &str) -> String {
        let err = classify("devbox", stderr);
        assert_eq!(err.kind, CommandErrorKind::RemoteUnavailable);
        assert!(err.message.contains("devbox"), "{}", err.message);
        err.code.unwrap()
    }

    #[test]
    fn classifies_real_ssh_failures() {
        assert_eq!(code("No ED25519 host key is known for devbox and you have requested strict checking.\r\nHost key verification failed.\r\n"), SSH_HOST_KEY);
        assert_eq!(
            code("@@@@@@@@@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\n"),
            SSH_HOST_KEY
        );
        assert_eq!(
            code("siomkin@192.168.1.7: Permission denied (publickey,password).\r\n"),
            SSH_AUTH_REQUIRED
        );
        assert_eq!(
            code("Received disconnect from 10.0.0.1 port 22:2: Too many authentication failures\n"),
            SSH_AUTH_REQUIRED
        );
        assert_eq!(
            code("ssh: connect to host 127.0.0.1 port 22: Connection refused\r\n"),
            UNREACHABLE
        );
        assert_eq!(code("ssh: Could not resolve hostname nope: nodename nor servname provided, or not known\r\n"), UNREACHABLE);
        assert_eq!(code(""), UNREACHABLE);
    }

    #[test]
    fn the_password_message_explains_the_limitation() {
        let err = classify("devbox", "devbox: Permission denied (password).\n");
        assert!(err.message.contains("password"), "{}", err.message);
    }
}
