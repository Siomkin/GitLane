//! Shared real-`git` subprocess helpers.

use std::ffi::OsString;
use std::io::Write;
use std::process::{Command, ExitStatus, Output, Stdio};
use std::sync::OnceLock;

#[cfg(test)]
use crate::git::REPOSITORY_LOCAL_ENV_VARS;
use crate::git::{clear_repository_local_env, isolated_git_command};

// Stops git's own HTTPS username/password prompts from blocking the app/dev
// terminal. SSH and external askpass helpers have their own prompting paths.
const GIT_TERMINAL_PROMPT_DISABLED: &str = "0";
const MINIMUM_GIT_VERSION: (u32, u32, u32) = (2, 36, 0);
static GIT_VERSION_CHECK: OnceLock<Result<(), String>> = OnceLock::new();

fn ensure_supported_git() -> Result<(), String> {
    GIT_VERSION_CHECK
        .get_or_init(|| {
            let output = isolated_git_command()
                .arg("--version")
                .env("PATH", crate::shell::path())
                .output()
                .map_err(|error| format!("failed to launch git: {error}"))?;
            if !output.status.success() {
                return Err("Git is installed but its version could not be determined.".to_string());
            }
            let text = String::from_utf8_lossy(&output.stdout);
            let version = parse_git_version(&text).ok_or_else(|| {
                format!(
                    "Could not understand the installed Git version: {}",
                    text.trim()
                )
            })?;
            if version < MINIMUM_GIT_VERSION {
                return Err(format!(
                    "GitLane requires Git 2.36.0 or newer; installed version is {}.{}.{}.",
                    version.0, version.1, version.2
                ));
            }
            Ok(())
        })
        .clone()
}

fn parse_git_version(output: &str) -> Option<(u32, u32, u32)> {
    let version = output.trim().strip_prefix("git version ")?;
    let mut parts = version.split(['.', ' ', '-']);
    Some((
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next().and_then(|part| part.parse().ok()).unwrap_or(0),
    ))
}

/// Turn a finished git process into a `Result`, guaranteeing a **non-empty**
/// error message. Some git versions fail a command without writing anything to
/// stdout/stderr — notably git 2.43 (the default on Ubuntu 24.04 LTS / Debian
/// stable) on a failed `stash push` against a locked index. Returning the raw
/// combined output there would surface an *empty* error to the user, so fall
/// back to the exit status when there's nothing else to show.
pub(super) fn finish(
    status: ExitStatus,
    stdout: &str,
    stderr: &str,
    args: &[&str],
) -> Result<String, String> {
    let combined = format!("{stdout}{stderr}").trim().to_string();
    if status.success() {
        Ok(combined)
    } else if combined.is_empty() {
        let how = status
            .code()
            .map(|c| format!("exit code {c}"))
            .unwrap_or_else(|| "a signal".to_string());
        // Name only the first couple of args, never the full argv. The second
        // argument can itself be a URL-valued push remote, so scrub this fallback
        // just like real stderr before it crosses IPC.
        let op = args.iter().take(2).copied().collect::<Vec<_>>().join(" ");
        Err(crate::redact::redact_secrets(&format!(
            "git {op} failed ({how})"
        )))
    } else {
        // Errors cross IPC directly. Scrub any credential git echoed before it
        // reaches a toast/log, while preserving successful machine output for
        // internal parsers (diffs, stash lists, porcelain status, and so on).
        Err(crate::redact::redact_secrets(&combined))
    }
}

/// Run `git -C <repo> <args...>`, returning combined stdout/stderr on success
/// or the error output on a non-zero exit.
pub(super) fn run_git(repo: &str, args: &[&str]) -> Result<String, String> {
    run_git_env(repo, args, &[])
}

/// Run git while accepting specific non-zero exit codes as an idempotent
/// success. This is intentionally narrow: callers must name the exact codes
/// documented by the subcommand (for example, `git config --unset-all`
/// returns 5 when the key is already absent). Every other launch/exit failure
/// still goes through [`finish`] and is surfaced to the user.
pub(super) fn run_git_allow_exit_codes(
    repo: &str,
    args: &[&str],
    allowed: &[i32],
) -> Result<String, String> {
    let output = git_output(repo, args, &[])?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if output
        .status
        .code()
        .is_some_and(|code| allowed.contains(&code))
    {
        return Ok(crate::redact::redact_secrets(
            format!("{stdout}{stderr}").trim(),
        ));
    }
    finish(output.status, &stdout, &stderr, args)
}

/// Run git and return **stdout only, untrimmed**, for callers that parse
/// machine-readable output line by line.
///
/// [`run_git`] concatenates stdout and stderr and trims the result, which is
/// right for the human-facing callers but corrupts porcelain parsing twice
/// over: a warning git wrote to stderr becomes an extra "record", and trimming
/// eats the leading space of the first one (`" M f.txt"` → `"M f.txt"`), which
/// carries meaning — the first status column is the staged half. Failures still
/// go through [`finish`], so error text and redaction are unchanged.
pub(super) fn run_git_stdout(repo: &str, args: &[&str]) -> Result<String, String> {
    let output = git_output(repo, args, &[])?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    if output.status.success() {
        return Ok(stdout);
    }
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    finish(output.status, &stdout, &stderr, args)
}

/// Run a command whose trailing operands are repository paths, forcing Git to
/// treat every pathspec byte literally. `--` only ends option parsing; without
/// this global mode a real filename such as `:(glob)*` can still expand to
/// unrelated files.
pub(super) fn run_git_literal_paths(repo: &str, args: &[&str]) -> Result<String, String> {
    let mut literal_args = Vec::with_capacity(args.len() + 1);
    literal_args.push("--literal-pathspecs");
    literal_args.extend_from_slice(args);
    run_git(repo, &literal_args)
}

fn scoped_git_os_output(
    repo: &str,
    common_dir: &std::ffi::OsStr,
    args: &[OsString],
) -> Result<Output, String> {
    let mut cmd = git_command(repo)?;
    // `git_command` clears every inherited repository-routing variable first.
    // Restore only the canonical common directory captured by the caller so a
    // mutable linked-worktree `commondir` file cannot redirect this command.
    cmd.env("GIT_COMMON_DIR", common_dir)
        .args(args)
        .stdin(Stdio::null());

    cmd.output()
        .map_err(|e| format!("failed to launch git: {e}"))
}

/// Run an OS-string command pinned to an already validated worktree gitdir and
/// common directory. The caller supplies explicit `--git-dir`/`--work-tree`
/// arguments; this helper pins the remaining linked-worktree indirection.
pub(super) fn run_git_scoped_os(
    repo: &str,
    common_dir: &std::ffi::OsStr,
    args: &[OsString],
) -> Result<String, String> {
    let output = scoped_git_os_output(repo, common_dir, args)?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let labels = args
        .iter()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    let label_refs = labels.iter().map(String::as_str).collect::<Vec<_>>();

    finish(output.status, &stdout, &stderr, &label_refs)
}

/// Raw-stdout companion for NUL-delimited status/path output under the same
/// captured repository scope.
pub(super) fn run_git_scoped_os_stdout_raw(
    repo: &str,
    common_dir: &std::ffi::OsStr,
    args: &[OsString],
) -> Result<Vec<u8>, String> {
    let output = scoped_git_os_output(repo, common_dir, args)?;
    if output.status.success() {
        return Ok(output.stdout);
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let labels = args
        .iter()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    let label_refs = labels.iter().map(String::as_str).collect::<Vec<_>>();
    match finish(output.status, &stdout, &stderr, &label_refs) {
        Err(error) => Err(error),
        Ok(_) => unreachable!("a failed git process cannot finish successfully"),
    }
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

/// Run a network-facing git command and redact its successful diagnostics
/// before returning them across IPC. Low-level [`run_git`] deliberately keeps
/// successful output byte-for-byte (apart from trimming) because many callers
/// parse it as machine data.
pub(super) fn run_git_env_redacted(
    repo: &str,
    args: &[&str],
    envs: &[(&str, &str)],
) -> Result<String, String> {
    run_git_env(repo, args, envs).map(|output| crate::redact::redact_secrets(&output))
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
    let mut cmd = git_command(repo)?;
    cmd.args(args);
    // GitLane must surface missing credentials through IPC instead of letting
    // git block the dev/app terminal with an invisible password prompt.
    cmd.stdin(Stdio::null());
    for (k, v) in envs {
        cmd.env(k, v);
    }
    // Keep the repository argument authoritative even if a future caller
    // accidentally forwards one of Git's process-global routing variables.
    clear_repository_local_env(&mut cmd);

    cmd.output()
        .map_err(|e| format!("failed to launch git: {e}"))
}

pub(super) fn git_command(repo: &str) -> Result<Command, String> {
    ensure_supported_git()?;
    let mut cmd = isolated_git_command();
    cmd.arg("-C").arg(repo);
    // macOS GUI apps launch with a minimal PATH; use the augmented one so a
    // Homebrew git (and any credential helpers/signing tools it invokes) is found.
    cmd.env("PATH", crate::shell::path());
    cmd.env("GIT_TERMINAL_PROMPT", GIT_TERMINAL_PROMPT_DISABLED);
    clear_repository_local_env(&mut cmd);
    crate::shell::hide_console(&mut cmd);
    Ok(cmd)
}

/// Run `git -C <repo> <args...>` with `input` connected to stdin.
pub(super) fn run_git_with_input(repo: &str, args: &[&str], input: &str) -> Result<String, String> {
    let mut cmd = git_command(repo)?;
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
pub(super) fn git_command_bare(args: &[&str]) -> Result<Command, String> {
    ensure_supported_git()?;
    let mut cmd = isolated_git_command();
    cmd.args(args)
        .env("PATH", crate::shell::path())
        .env("GIT_TERMINAL_PROMPT", GIT_TERMINAL_PROMPT_DISABLED)
        .stdin(Stdio::null());
    clear_repository_local_env(&mut cmd);
    crate::shell::hide_console(&mut cmd);
    Ok(cmd)
}

/// Run `git <args>` **without** `-C <repo>`. Returns combined stdout/stderr on
/// success or the error output on a non-zero exit.
pub(super) fn run_git_bare(args: &[&str]) -> Result<String, String> {
    let output = git_command_bare(args)?
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

pub(super) fn run_git_env_stable_diagnostics_redacted(
    repo: &str,
    args: &[&str],
    envs: &[(&str, &str)],
) -> Result<String, String> {
    run_git_env_stable_diagnostics(repo, args, envs)
        .map(|output| crate::redact::redact_secrets(&output))
}

#[cfg(all(test, unix))]
mod tests {
    use super::{
        finish, git_command, git_command_bare, parse_git_version, run_git, run_git_env,
        run_git_env_redacted, run_git_stdout_raw, REPOSITORY_LOCAL_ENV_VARS,
    };
    use std::ffi::OsStr;
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
    fn parses_standard_and_vendor_git_versions() {
        assert_eq!(parse_git_version("git version 2.29.0\n"), Some((2, 29, 0)));
        assert_eq!(
            parse_git_version("git version 2.39.5 (Apple Git-154)\n"),
            Some((2, 39, 5))
        );
        assert_eq!(parse_git_version("git version 3.1\n"), Some((3, 1, 0)));
        assert_eq!(parse_git_version("unexpected"), None);
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
    fn silent_push_fallback_redacts_a_url_valued_remote() {
        let err = finish(
            exit(128),
            "",
            "",
            &[
                "push",
                "https://alice:push-secret@example.com/team/repo.git",
                "HEAD:main",
            ],
        )
        .unwrap_err();
        assert!(err.contains("git push"), "should name the op: {err}");
        assert!(
            err.contains("alice:***@"),
            "should retain safe context: {err}"
        );
        assert!(
            !err.contains("push-secret"),
            "must not echo credentials: {err}"
        );
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
    fn git_commands_clear_repository_local_environment() {
        for command in [
            git_command(".").expect("repository command"),
            git_command_bare(&["--version"]).expect("bare command"),
        ] {
            for key in REPOSITORY_LOCAL_ENV_VARS {
                assert!(
                    command
                        .get_envs()
                        .any(|(name, value)| name == OsStr::new(key) && value.is_none()),
                    "{key} must be removed from the git subprocess environment"
                );
            }
        }
    }

    #[test]
    fn repository_commands_ignore_inherited_repository_routing_env() {
        const CHILD_MARKER: &str = "GITLANE_ROUTING_ENV_TEST_CHILD";
        const REPO_A_ENV: &str = "GITLANE_ROUTING_ENV_TEST_REPO_A";
        const REPO_B_ENV: &str = "GITLANE_ROUTING_ENV_TEST_REPO_B";

        if std::env::var_os(CHILD_MARKER).is_some() {
            let repo_a = std::env::var(REPO_A_ENV).expect("repo A path");
            let repo_b = std::env::var(REPO_B_ENV).expect("repo B path");
            let top = run_git(&repo_a, &["rev-parse", "--show-toplevel"])
                .expect("-C repository remains authoritative");
            assert_eq!(
                std::fs::canonicalize(top).unwrap(),
                std::fs::canonicalize(&repo_a).unwrap()
            );

            run_git(&repo_a, &["clean", "-f", "--", "approved.txt"])
                .expect("clean the explicitly selected repository");
            assert!(!std::path::Path::new(&repo_a).join("approved.txt").exists());
            assert_eq!(
                std::fs::read_to_string(std::path::Path::new(&repo_b).join("precious.txt"))
                    .unwrap(),
                "keep\n"
            );
            return;
        }

        let repo_a = TestRepo::new("gitlane-routing-env-a");
        let repo_b = TestRepo::new("gitlane-routing-env-b");
        for repo in [&repo_a, &repo_b] {
            let output = git_command_bare(&["init", "-q", repo.path()])
                .unwrap()
                .output()
                .expect("git init launches");
            assert!(output.status.success(), "git init failed");
        }
        std::fs::write(repo_a.0.join("approved.txt"), "remove\n").unwrap();
        std::fs::write(repo_b.0.join("precious.txt"), "keep\n").unwrap();

        let output = Command::new(std::env::current_exe().expect("current test executable"))
            .args([
                "--exact",
                "git::write::cli::tests::repository_commands_ignore_inherited_repository_routing_env",
                "--nocapture",
            ])
            .env(CHILD_MARKER, "1")
            .env(REPO_A_ENV, repo_a.path())
            .env(REPO_B_ENV, repo_b.path())
            .env("GIT_DIR", repo_b.0.join(".git"))
            .env("GIT_WORK_TREE", &repo_b.0)
            .env("GIT_INDEX_FILE", repo_b.0.join(".git/index"))
            .output()
            .expect("launch isolated routing-env regression child");

        assert!(
            output.status.success(),
            "routing-env child failed:\nstdout:\n{}\nstderr:\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(!repo_a.0.join("approved.txt").exists());
        assert_eq!(
            std::fs::read_to_string(repo_b.0.join("precious.txt")).unwrap(),
            "keep\n"
        );
    }

    #[test]
    fn successful_network_output_redacts_echoed_remote_credentials() {
        let repo = TestRepo::new("gitlane-redacted-success");
        let init = Command::new("git")
            .args(["init", "-q", repo.path()])
            .output()
            .expect("git init launches");
        assert!(init.status.success(), "git init failed");

        let out = run_git_env_redacted(
            repo.path(),
            &[
                "-c",
                "alias.echo-secret=!printf 'To https://alice:push-secret@example.com/team/repo.git\\n'",
                "echo-secret",
            ],
            &[],
        )
        .unwrap();
        assert_eq!(out, "To https://alice:***@example.com/team/repo.git");
        assert!(!out.contains("push-secret"));
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
