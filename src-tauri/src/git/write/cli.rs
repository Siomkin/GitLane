//! Shared real-`git` subprocess helpers.

use std::ffi::OsString;
use std::io::Write;
use std::process::{Command, ExitStatus, Output, Stdio};

// Stops git's own HTTPS username/password prompts from blocking the app/dev
// terminal. SSH and external askpass helpers have their own prompting paths.
const GIT_TERMINAL_PROMPT_DISABLED: &str = "0";

/// Turn a finished git process into a `Result`, guaranteeing a **non-empty**
/// error message. Some git versions fail a command without writing anything to
/// stdout/stderr — notably git 2.43 (the default on Ubuntu 24.04 LTS / Debian
/// stable) on a failed `stash push` against a locked index. Returning the raw
/// combined output there would surface an *empty* error to the user, so fall
/// back to the exit status when there's nothing else to show.
fn finish(status: ExitStatus, stdout: &str, stderr: &str, args: &[&str]) -> Result<String, String> {
    let combined = format!("{stdout}{stderr}").trim().to_string();
    if status.success() {
        Ok(combined)
    } else if combined.is_empty() {
        let how = status
            .code()
            .map(|c| format!("exit code {c}"))
            .unwrap_or_else(|| "a signal".to_string());
        // Name only the subcommand (first couple of args), never the full argv —
        // later positions can carry a remote URL with embedded credentials or a
        // commit message, and git gave us nothing else to echo.
        let op = args.iter().take(2).copied().collect::<Vec<_>>().join(" ");
        Err(format!("git {op} failed ({how})"))
    } else {
        // Scrub any credential git echoed in a URL before it reaches a toast/log.
        Err(crate::redact::redact_secrets(&combined))
    }
}

/// Run `git -C <repo> <args...>`, returning combined stdout/stderr on success
/// or the error output on a non-zero exit.
pub(super) fn run_git(repo: &str, args: &[&str]) -> Result<String, String> {
    run_git_env(repo, args, &[])
}

/// Like [`run_git`], but trailing path arguments are passed as [`OsString`] so
/// NUL-delimited machine output can be forwarded byte-for-byte on Unix.
pub(super) fn run_git_os_paths(
    repo: &str,
    prefix_args: &[&str],
    path_args: &[OsString],
) -> Result<String, String> {
    let mut cmd = git_command(repo);
    cmd.args(prefix_args).args(path_args).stdin(Stdio::null());

    let output = cmd
        .output()
        .map_err(|e| format!("failed to launch git: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    finish(output.status, &stdout, &stderr, prefix_args)
}

/// Like [`run_git`] but with extra environment variables — used to pass a
/// bound account's `GH_TOKEN` through git's credential helper on push.
pub(super) fn run_git_env(
    repo: &str,
    args: &[&str],
    envs: &[(&str, &str)],
) -> Result<String, String> {
    let output = git_output(repo, args, envs)?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    finish(output.status, &stdout, &stderr, args)
}

/// Run git and return stdout byte-for-byte on success. This is reserved for
/// NUL-delimited machine output where [`run_git`]'s user-facing whitespace trim
/// would corrupt a leading-space path.
pub(super) fn run_git_stdout_raw(repo: &str, args: &[&str]) -> Result<Vec<u8>, String> {
    let output = git_output(repo, args, &[])?;
    if output.status.success() {
        return Ok(output.stdout);
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    match finish(output.status, &stdout, &stderr, args) {
        Err(error) => Err(error),
        Ok(_) => unreachable!("a failed git process cannot finish successfully"),
    }
}

fn git_output(repo: &str, args: &[&str], envs: &[(&str, &str)]) -> Result<Output, String> {
    let mut cmd = git_command(repo);
    cmd.args(args);
    // GitLane must surface missing credentials through IPC instead of letting
    // git block the dev/app terminal with an invisible password prompt.
    cmd.stdin(Stdio::null());
    for (k, v) in envs {
        cmd.env(k, v);
    }

    cmd.output()
        .map_err(|e| format!("failed to launch git: {e}"))
}

fn git_command(repo: &str) -> Command {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(repo);
    // macOS GUI apps launch with a minimal PATH; use the augmented one so a
    // Homebrew git (and any credential helpers/signing tools it invokes) is found.
    cmd.env("PATH", crate::shell::path());
    cmd.env("GIT_TERMINAL_PROMPT", GIT_TERMINAL_PROMPT_DISABLED);
    crate::shell::hide_console(&mut cmd);
    cmd
}

/// Run `git -C <repo> <args...>` with `input` connected to stdin.
pub(super) fn run_git_with_input(repo: &str, args: &[&str], input: &str) -> Result<String, String> {
    let mut cmd = git_command(repo);
    cmd.args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to launch git: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(input.as_bytes())
            .map_err(|e| format!("failed to write git stdin: {e}"))?;
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("failed to wait for git: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    finish(output.status, &stdout, &stderr, args)
}

/// Build a `git <args>` command **without** `-C <repo>` (PATH augmented like
/// [`run_git`]), for operations that act outside an existing repository
/// (clone/init). Callers needing custom stdio/streaming — the clone progress
/// reader — build on this so git subprocess construction stays centralized here;
/// most callers use the buffered [`run_git_bare`].
pub(super) fn git_command_bare(args: &[&str]) -> Command {
    let mut cmd = Command::new("git");
    cmd.args(args)
        .env("PATH", crate::shell::path())
        .env("GIT_TERMINAL_PROMPT", GIT_TERMINAL_PROMPT_DISABLED)
        .stdin(Stdio::null());
    crate::shell::hide_console(&mut cmd);
    cmd
}

/// Run `git <args>` **without** `-C <repo>`. Returns combined stdout/stderr on
/// success or the error output on a non-zero exit.
pub(super) fn run_git_bare(args: &[&str]) -> Result<String, String> {
    let output = git_command_bare(args)
        .output()
        .map_err(|e| format!("failed to launch git: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    finish(output.status, &stdout, &stderr, args)
}

pub(super) fn run_git_env_stable_diagnostics(
    repo: &str,
    args: &[&str],
    envs: &[(&str, &str)],
) -> Result<String, String> {
    let mut stable_envs = Vec::with_capacity(envs.len() + 2);
    stable_envs.extend_from_slice(envs);
    stable_envs.push(("LC_ALL", "C"));
    stable_envs.push(("LANG", "C"));
    run_git_env(repo, args, &stable_envs)
}

#[cfg(all(test, unix))]
mod tests {
    use super::{finish, run_git_env, run_git_stdout_raw};
    use std::os::unix::process::ExitStatusExt;
    use std::process::{Command, ExitStatus};
    use std::{io::Write, net::TcpListener};

    // On unix a raw wait status encodes the exit code in the high byte.
    fn exit(code: i32) -> ExitStatus {
        ExitStatus::from_raw(code << 8)
    }

    #[test]
    fn failed_git_with_no_output_still_yields_a_nonempty_error() {
        // git 2.43 (Ubuntu 24.04 LTS / Debian stable) can fail a command without
        // writing to stdout/stderr; the surfaced error must never be empty or the
        // UI shows a blank failure.
        let err = finish(exit(1), "", "", &["stash", "push"]).unwrap_err();
        assert!(!err.is_empty(), "error must not be empty");
        assert!(
            err.contains("stash push"),
            "error should name the command: {err}"
        );
    }

    #[test]
    fn fallback_names_only_the_subcommand_not_sensitive_args() {
        // When git is silent we only echo the first couple of args, so a remote
        // URL with embedded credentials never leaks into the surfaced error.
        let err = finish(
            exit(128),
            "",
            "",
            &[
                "remote",
                "set-url",
                "origin",
                "https://user:secret@example.com/r.git",
            ],
        )
        .unwrap_err();
        assert!(err.contains("remote set-url"), "should name the op: {err}");
        assert!(!err.contains("secret"), "must not echo credentials: {err}");
    }

    #[test]
    fn failed_git_prefers_real_stderr_when_present() {
        let err = finish(exit(1), "", "fatal: boom\n", &["stash", "push"]).unwrap_err();
        assert_eq!(err, "fatal: boom");
    }

    #[test]
    fn success_returns_trimmed_combined_output() {
        let out = finish(exit(0), "ok\n", "", &["status"]).unwrap();
        assert_eq!(out, "ok");
    }

    #[test]
    fn raw_stdout_preserves_leading_space_and_nul_delimiter() {
        let repo = TestRepo::new("gitlane-raw-stdout");
        let init = Command::new("git")
            .args(["init", "-q", repo.path()])
            .output()
            .expect("git init launches");
        assert!(init.status.success(), "git init failed");
        std::fs::write(repo.0.join(" leading-space.txt"), "new\n").unwrap();

        let output = run_git_stdout_raw(repo.path(), &["ls-files", "--others", "-z"])
            .expect("raw git output");

        assert_eq!(output, b" leading-space.txt\0");
    }

    #[test]
    fn https_auth_failure_does_not_prompt_on_terminal() {
        let repo = TestRepo::new("gitlane-no-prompt");
        let init = Command::new("git")
            .args(["init", "-q", repo.path()])
            .output()
            .expect("git init launches");
        assert!(init.status.success(), "git init failed");

        let listener = TcpListener::bind("127.0.0.1:0").expect("bind local test server");
        let addr = listener.local_addr().expect("local addr");
        let handle = std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let _ = stream.write_all(
                    b"HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"test\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                );
            }
        });

        let url = format!("http://alice@{addr}/repo.git");
        let err = run_git_env(
            repo.path(),
            &["fetch", &url, "HEAD"],
            &[
                ("GIT_CONFIG_GLOBAL", "/dev/null"),
                ("GIT_CONFIG_NOSYSTEM", "1"),
            ],
        )
        .expect_err("missing credentials should fail instead of prompting");
        handle.join().expect("server thread joins");

        assert!(
            err.contains("terminal prompts disabled") || err.contains("could not read Password"),
            "error should report a non-interactive credential failure:\n{err}"
        );
    }

    struct TestRepo(std::path::PathBuf);

    impl TestRepo {
        fn new(name: &str) -> Self {
            let mut path = std::env::temp_dir();
            path.push(format!("{name}-{}-{}", std::process::id(), unique_id()));
            std::fs::create_dir_all(&path).expect("create temp repo");
            Self(path)
        }

        fn path(&self) -> &str {
            self.0.to_str().expect("utf8 temp path")
        }
    }

    impl Drop for TestRepo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn unique_id() -> u128 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    }
}
