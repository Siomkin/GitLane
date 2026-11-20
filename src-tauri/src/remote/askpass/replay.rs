//! When a remembered ssh answer may be handed to another `ssh` of the same
//! connect attempt (harden-remote-locator-and-askpass).
//!
//! Only a prompt that names what it unlocks is safe to reuse, and only when the
//! name cannot come from a server: OpenSSH 8.4 and newer put `(user@host) ` in
//! front of every keyboard-interactive prompt, while older clients pass the
//! server's text through, so a server could copy `me@jump's password: `.

use std::process::Command;
use std::sync::OnceLock;
use std::sync::mpsc;
use std::time::Duration;

use super::{Remembered, Request, classify};
use crate::git::types::SshPromptKind;

/// How long `ssh -V` may take before the version counts as unknown.
const VERSION_TIMEOUT: Duration = Duration::from_secs(5);

/// Replay the remembered answer to a different `ssh` asking the same question,
/// when `replay_named` (OpenSSH 8.4+) and the prompt names its target;
/// otherwise ask, and remember a secret answer for the rest of the attempt.
#[expect(
    clippy::collapsible_if,
    reason = "collapsing it needs a let-chain; converted in the let-chain follow-up"
)]
pub(super) fn decide(
    request: &Request,
    remembered: &mut Option<Remembered>,
    replay_named: bool,
    ask: impl FnOnce(&str, SshPromptKind) -> Option<String>,
) -> Option<String> {
    if let Some(r) = remembered.as_mut() {
        if replay_named
            && names_its_target(&request.prompt)
            && r.prompt == request.prompt
            && (r.ssh_pid != request.ssh_pid || request.ssh_pid == 0)
        {
            r.ssh_pid = request.ssh_pid;
            // A pid of 0 can't tell a retry from a new process: replay once.
            let answer = r.answer.clone();
            if request.ssh_pid == 0 {
                *remembered = None;
            }
            return Some(answer);
        }
    }
    let kind = classify(&request.prompt);
    let answer = ask(&request.prompt, kind);
    *remembered = match (&answer, kind) {
        (Some(answer), SshPromptKind::Secret) => Some(Remembered {
            prompt: request.prompt.clone(),
            answer: answer.clone(),
            ssh_pid: request.ssh_pid,
        }),
        _ => None,
    };
    answer
}

/// One `user@host` word: no whitespace, and text on both sides of the last
/// `@`. A user name may itself contain `@` (`alice@corp.example@devbox`).
fn is_user_at_host(word: &str) -> bool {
    !word.chars().any(char::is_whitespace)
        && matches!(word.rsplit_once('@'), Some((user, host)) if !user.is_empty() && !host.is_empty())
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

/// Whether the `ssh` GitLane runs marks server prompts (OpenSSH 8.4+). A
/// failed start or another client counts as no and is kept for the process; a
/// timeout counts as no for this connect only, so the next one checks again.
pub fn named_prompts_are_marked() -> bool {
    static MARKED: OnceLock<bool> = OnceLock::new();
    if let Some(&marked) = MARKED.get() {
        return marked;
    }
    // Resolved before the timer starts: the first lookup of the login-shell
    // PATH has its own bound and must not eat the `ssh -V` budget.
    let mut cmd = Command::new("ssh");
    cmd.arg("-V").env("PATH", crate::shell::path());
    crate::shell::hide_console(&mut cmd);
    // `ssh -V` prints to stderr, which `shell::output_within` discards, so it
    // runs on its own thread under a timeout instead.
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(
            cmd.output()
                .map(|o| String::from_utf8_lossy(&o.stderr).into_owned()),
        );
    });
    match rx.recv_timeout(VERSION_TIMEOUT) {
        Ok(out) => *MARKED.get_or_init(|| {
            out.ok()
                .and_then(|text| openssh_version(&text))
                .is_some_and(|version| version >= (8, 4))
        }),
        Err(_) => false,
    }
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
            "alice@corp.example@devbox's password: ",
            "(alice@corp.example@devbox) Password: ",
        ] {
            assert!(names_its_target(named), "{named}");
        }
        for unnamed in [
            "Password: ",
            "Verification code: ",
            "(no host) Password: ",
            "me @devbox's password: ",
            "@devbox's password: ",
            "me@'s password: ",
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
