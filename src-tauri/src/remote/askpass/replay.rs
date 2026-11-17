//! When a remembered ssh answer may be handed to another `ssh` of the same
//! connect attempt (harden-remote-locator-and-askpass).
//!
//! Only a prompt that names what it unlocks is safe to reuse, and only when the
//! name cannot come from a server: OpenSSH 8.4 and newer put `(user@host) ` in
//! front of every keyboard-interactive prompt, while older clients pass the
//! server's text through, so a server could copy `me@jump's password: `.

use std::process::Command;
use std::sync::mpsc;
use std::sync::OnceLock;
use std::time::Duration;

/// How long `ssh -V` may take before the version counts as unknown.
const VERSION_TIMEOUT: Duration = Duration::from_secs(5);

/// One `user@host` word: text on both sides of a single `@`, no whitespace.
fn is_user_at_host(word: &str) -> bool {
    !word.chars().any(char::is_whitespace)
        && matches!(word.split_once('@'), Some((user, host)) if !user.is_empty() && !host.is_empty() && !host.contains('@'))
}

/// Whether `prompt` names the account or key its answer unlocks.
pub(super) fn names_its_target(prompt: &str) -> bool {
    let prompt = prompt.trim_end();
    if let Some(who) = prompt.strip_suffix("'s password:") {
        return is_user_at_host(who);
    }
    if prompt.starts_with("Enter passphrase for key '") && prompt.ends_with("':") {
        return true;
    }
    prompt
        .strip_prefix('(')
        .and_then(|rest| rest.split_once(") "))
        .is_some_and(|(who, _)| is_user_at_host(who))
}

/// `(major, minor)` from `ssh -V` output such as `OpenSSH_9.6p1, LibreSSL 3.3.6`
/// or `OpenSSH_for_Windows_8.1p1, …`; `None` for any other client.
pub(super) fn openssh_version(text: &str) -> Option<(u32, u32)> {
    let rest = text.trim_start().strip_prefix("OpenSSH_")?;
    let rest = rest.strip_prefix("for_Windows_").unwrap_or(rest);
    let (major, rest) = rest.split_once('.')?;
    let minor: String = rest.chars().take_while(char::is_ascii_digit).collect();
    Some((major.parse().ok()?, minor.parse().ok()?))
}

/// Whether the `ssh` GitLane runs marks server prompts (OpenSSH 8.4+). Checked
/// once per process; a failure, a timeout or another client counts as no.
pub(super) fn named_prompts_are_marked() -> bool {
    static MARKED: OnceLock<bool> = OnceLock::new();
    *MARKED.get_or_init(|| {
        // `ssh -V` prints to stderr, which `shell::output_within` discards, so
        // it runs on its own thread under a timeout instead.
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let out = Command::new("ssh")
                .arg("-V")
                .env("PATH", crate::shell::path())
                .output();
            let _ = tx.send(out.map(|o| String::from_utf8_lossy(&o.stderr).into_owned()));
        });
        rx.recv_timeout(VERSION_TIMEOUT)
            .ok()
            .and_then(Result::ok)
            .and_then(|text| openssh_version(&text))
            .is_some_and(|version| version >= (8, 4))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_prompt_names_its_target_only_with_a_user_and_host_or_a_key() {
        for named in [
            "me@devbox's password: ",
            "Enter passphrase for key '/home/me/.ssh/id_ed25519': ",
            "(me@devbox) Password: ",
        ] {
            assert!(names_its_target(named), "{named}");
        }
        for unnamed in [
            "Password: ",
            "Verification code: ",
            "(no host) Password: ",
            "me @devbox's password: ",
            "@devbox's password: ",
        ] {
            assert!(!names_its_target(unnamed), "{unnamed}");
        }
    }

    #[test]
    fn reads_the_openssh_version_from_ssh_v() {
        assert_eq!(
            openssh_version("OpenSSH_9.6p1, LibreSSL 3.3.6"),
            Some((9, 6))
        );
        assert_eq!(
            openssh_version("OpenSSH_for_Windows_8.1p1, LibreSSL 3.0.2"),
            Some((8, 1))
        );
        assert_eq!(openssh_version("plink: Release 0.81"), None);
    }
}
