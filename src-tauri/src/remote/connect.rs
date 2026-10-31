//! Start the agent on a host over the user's own `ssh` (remote-ssh-repos D4):
//! its questions (password, passphrase, new host key) go to the app through
//! [`askpass`]; host-key checking is left exactly as the user configured it;
//! no agent forwarding unless their config asks for it.

use std::io::{BufReader, Read};
use std::process::{Child, ChildStderr, Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use super::askpass;
use super::locator::Locator;
use super::session::{Hello, HelloError, OnEvent, Session};
use super::ssh_errors::{self, UNREACHABLE};
use crate::agent::protocol::PROTOCOL;
use crate::git::types::CommandError;

/// `ssh` must deliver the agent's hello within this long: the TCP connect has
/// its own timeout, this one covers a login shell that hangs before exec.
const HELLO_TIMEOUT: Duration = Duration::from_secs(45);

/// The installed agent for this app version, relative to the remote `$HOME`.
pub fn agent_path() -> String {
    format!(
        ".gitlane-server/{}/gitlane-agent",
        env!("CARGO_PKG_VERSION")
    )
}

/// Options every `ssh` GitLane starts gets, the agent's and a terminal's alike.
const SSH_OPTIONS: [&str; 6] = [
    "-o",
    "ConnectTimeout=15",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
];

/// `ssh` with GitLane's fixed options, aimed at `locator`'s host, ready for a
/// remote command after the `--`. During a connect attempt its questions go
/// to the app; outside one (nobody to ask) it runs in batch mode and fails.
pub fn ssh_command(locator: &Locator) -> Command {
    let mut cmd = Command::new("ssh");
    cmd.arg("-T");
    match askpass::context_for(&locator.origin()) {
        Some(context) => {
            cmd.envs(context.env).args(context.args);
        }
        None => {
            cmd.args(["-o", "BatchMode=yes"]);
        }
    }
    cmd.args(SSH_OPTIONS)
        .args(locator.ssh_destination())
        .arg("--")
        // A GUI app starts with a minimal PATH; use the login shell's, like git.
        .env("PATH", crate::shell::path());
    crate::shell::hide_console(&mut cmd);
    cmd
}

/// The `ssh` arguments for a terminal in `locator`'s directory on its host
/// (remote-server-terminal D3). `-t` gives the shell a terminal, which also
/// keeps `ssh`'s own questions in it, so no askpass and no batch mode here.
/// `-e none`: a pasted line starting with `~.` must not end the connection.
/// `-S none`: a `ControlMaster` in the user's config would otherwise put the
/// terminal on the agent's connection, and closing that one would end it.
/// The login shell may be fish or tcsh, so the command runs under `sh`, and
/// the path travels base64-encoded: fish reads backslashes inside single
/// quotes, so no character of the path may reach the login shell's parser.
pub fn terminal_args(locator: &Locator, key_args: Vec<String>) -> Vec<String> {
    use base64::Engine;
    let mut args: Vec<String> = ["-t", "-e", "none", "-S", "none"].map(String::from).into();
    args.extend(key_args);
    args.extend(SSH_OPTIONS.map(String::from));
    args.extend(locator.ssh_destination());
    args.push("--".into());
    let path = base64::engine::general_purpose::STANDARD.encode(&locator.path);
    args.push(super::install::remote_sh(&format!(
        "d=$(printf %s {path} | base64 -d) && cd \"$d\" && exec \"${{SHELL:-/bin/sh}}\" -l"
    )));
    args
}

/// Run the installed agent on `locator`'s host and wait for its hello.
pub fn connect(
    locator: &Locator,
    on_event: OnEvent,
    on_close: Box<dyn FnOnce() + Send>,
) -> Result<(Session, Hello), CommandError> {
    let host = locator.display_host();
    // The remote shell expands `~` and runs the agent; the path is ours, not the user's.
    let mut child = ssh_command(locator)
        .arg(format!("~/{}", agent_path()))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            ssh_errors::unavailable(UNREACHABLE, format!("Could not start ssh for {host}: {e}"))
        })?;
    let (Some(stdin), Some(stdout), Some(stderr)) =
        (child.stdin.take(), child.stdout.take(), child.stderr.take())
    else {
        return Err(CommandError::internal("ssh started without its pipes"));
    };
    let stderr = collect_tail(stderr);
    let child = Arc::new(Mutex::new(Some(child)));
    let (hello_read, timed_out) = watchdog(child.clone(), locator.origin());

    let started = Session::start(
        host,
        Box::new(BufReader::new(stdout)),
        Box::new(stdin),
        on_event,
        on_close,
    );
    let _ = hello_read.send(());
    let child = child.lock().ok().and_then(|mut c| c.take());

    match started {
        Ok((session, hello)) => {
            if let Some(child) = child {
                session.attach(child);
            }
            if let Some(git_error) = hello.git_error.clone() {
                session.close();
                return Err(git_error);
            }
            if hello.version != env!("CARGO_PKG_VERSION") {
                session.close();
                return Err(ssh_errors::unavailable(
                    ssh_errors::AGENT_INSTALL,
                    format!(
                        "The GitLane agent on {host} is version {} (this app is {}).",
                        hello.version,
                        env!("CARGO_PKG_VERSION")
                    ),
                ));
            }
            if hello.protocol != PROTOCOL {
                session.close();
                return Err(ssh_errors::unavailable(
                    ssh_errors::AGENT_INSTALL,
                    format!(
                        "The GitLane agent on {host} speaks protocol {} (this app needs {PROTOCOL}).",
                        hello.protocol
                    ),
                ));
            }
            Ok((session, hello))
        }
        Err(failure) => {
            if let Some(mut child) = child {
                let _ = child.kill();
                let _ = child.wait();
            }
            let stderr = stderr.join().unwrap_or_default();
            if timed_out.recv_timeout(Duration::ZERO).is_ok() {
                return Err(ssh_errors::unavailable(
                    UNREACHABLE,
                    format!(
                        "{host} did not start the GitLane agent within {} seconds.",
                        HELLO_TIMEOUT.as_secs()
                    ),
                ));
            }
            Err(match failure {
                HelloError::Closed => ssh_errors::classify(host, &stderr),
                HelloError::Invalid(why) => ssh_errors::unavailable(
                    ssh_errors::AGENT_INSTALL,
                    format!("The GitLane agent on {host} did not answer as expected: {why}"),
                ),
            })
        }
    }
}

/// Kill `child` if the hello has not been read within [`HELLO_TIMEOUT`] of
/// waiting time — time a question sits with the user doesn't count. The first
/// channel signals "hello read"; the second reports that it fired.
fn watchdog(
    child: Arc<Mutex<Option<Child>>>,
    origin: String,
) -> (mpsc::Sender<()>, mpsc::Receiver<()>) {
    const TICK: Duration = Duration::from_millis(500);
    let (hello_read, wait) = mpsc::channel::<()>();
    let (fired, timed_out) = mpsc::channel::<()>();
    thread::spawn(move || {
        let mut waited = Duration::ZERO;
        while waited < HELLO_TIMEOUT {
            match wait.recv_timeout(TICK) {
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if !askpass::prompting(&origin) {
                        waited += TICK;
                    }
                }
                _ => return,
            }
        }
        if let Some(child) = child.lock().ok().as_mut().and_then(|c| c.as_mut()) {
            let _ = child.kill();
        }
        let _ = fired.send(());
    });
    (hello_read, timed_out)
}

/// Drain `ssh`'s stderr for as long as it runs, keeping the last few KiB for
/// diagnosing a failed start. Draining also keeps a chatty stderr from filling
/// its pipe and stalling the session.
fn collect_tail(mut stderr: ChildStderr) -> thread::JoinHandle<String> {
    const KEEP: usize = 8 * 1024;
    thread::spawn(move || {
        let mut tail = Vec::new();
        let mut chunk = [0u8; 4096];
        while let Ok(n) = stderr.read(&mut chunk) {
            if n == 0 {
                break;
            }
            tail.extend_from_slice(&chunk[..n]);
            if tail.len() > KEEP {
                tail.drain(..tail.len() - KEEP);
            }
        }
        String::from_utf8_lossy(&tail).into_owned()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ssh_asks_through_the_app_only_during_a_connect_and_keeps_host_key_policy() {
        let locator = Locator::parse("ssh://me@devbox:2222/srv/app").unwrap();
        let args = |cmd: &Command| -> Vec<String> {
            cmd.get_args()
                .map(|a| a.to_string_lossy().into_owned())
                .collect()
        };
        let idle = args(&ssh_command(&locator));
        assert!(idle.windows(2).any(|w| w == ["-o", "BatchMode=yes"]));

        let key = vec![
            "-i".into(),
            "/k".into(),
            "-o".into(),
            "IdentitiesOnly=yes".into(),
        ];
        let _lease = askpass::start(&locator.origin(), Arc::new(|_, _| None), key).unwrap();
        let cmd = ssh_command(&locator);
        let args = args(&cmd);
        assert!(!args.iter().any(|a| a.contains("BatchMode")));
        assert!(args
            .windows(4)
            .any(|w| w == ["-i", "/k", "-o", "IdentitiesOnly=yes"]));
        assert!(cmd
            .get_envs()
            .any(|(k, v)| k == "SSH_ASKPASS_REQUIRE" && v.is_some_and(|v| v == "force")));
        assert!(args.ends_with(&["-p".into(), "2222".into(), "me@devbox".into(), "--".into()]));
        assert!(!args.iter().any(|a| a.contains("StrictHostKeyChecking")));
        assert!(!args.iter().any(|a| a == "-A" || a.contains("ForwardAgent")));
    }

    #[test]
    fn a_terminal_asks_in_itself_on_its_own_connection() {
        let path = "/srv/it's a $dir\\x";
        let locator = Locator::parse(&format!("ssh://me@devbox:2222{path}")).unwrap();
        let key = ["-i", "/k", "-o", "IdentitiesOnly=yes"].map(String::from);
        let args = terminal_args(&locator, key.to_vec());

        assert_eq!(args[..5], ["-t", "-e", "none", "-S", "none"]);
        assert!(args.windows(4).any(|w| w == key));
        assert!(!args.iter().any(|a| a == "-T" || a == "-A"));
        assert!(!args.iter().any(|a| a.contains("BatchMode")
            || a.contains("StrictHostKeyChecking")
            || a.contains("ForwardAgent")));
        let remote = args.last().unwrap();
        assert!(args.ends_with(&[
            "-p".into(),
            "2222".into(),
            "me@devbox".into(),
            "--".into(),
            remote.clone(),
        ]));
        // Only remote_sh's own wrapping quotes reach the login shell: nothing
        // of the path, whose quote, `$` and backslash fish would read.
        assert!(remote.starts_with("sh -c '") && remote.ends_with('\''));
        assert_eq!(remote.matches('\'').count(), 2, "{remote}");
        assert!(
            !remote.contains('\\') && !remote.contains("srv"),
            "{remote}"
        );
    }

    /// The real command under a POSIX login shell, in a directory whose name
    /// holds a quote, a space, `$` and a backslash: the shell `exec`ed there
    /// (a stand-in that prints its directory) starts in exactly that place.
    #[cfg(unix)]
    #[test]
    fn a_terminal_command_opens_its_login_shell_in_an_awkward_directory() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("gitlane-term-{}", std::process::id()));
        let dir = root.join("it's a $dir\\x");
        std::fs::create_dir_all(&dir).unwrap();
        let shell = root.join("login-shell");
        std::fs::write(&shell, "#!/bin/sh\npwd -P\n").unwrap();
        std::fs::set_permissions(&shell, std::fs::Permissions::from_mode(0o755)).unwrap();
        let locator = Locator::parse(&format!("ssh://devbox{}", dir.display())).unwrap();
        // `pwd -P` resolves symlinks (macOS's temp dir is under one).
        let expected = dir.canonicalize().unwrap();

        let remote = terminal_args(&locator, Vec::new()).pop().unwrap();
        let out = std::process::Command::new("sh")
            .arg("-c")
            .arg(&remote)
            .env("SHELL", &shell)
            .output()
            .unwrap();
        let _ = std::fs::remove_dir_all(&root);

        assert!(out.status.success(), "{out:?}");
        assert_eq!(
            String::from_utf8_lossy(&out.stdout).trim_end(),
            expected.to_string_lossy()
        );
    }

    #[test]
    fn the_agent_lives_under_a_per_version_directory() {
        assert_eq!(
            agent_path(),
            format!(
                ".gitlane-server/{}/gitlane-agent",
                env!("CARGO_PKG_VERSION")
            )
        );
    }
}
