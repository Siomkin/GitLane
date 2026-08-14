//! Shared real-`git` subprocess helpers.
//!
//! Facade over the focused submodules: `version` (the Git 2.36+ gate),
//! `finish` (non-empty error conversion), `command` (the single spawn site),
//! `runners` (stdout/env/literal/raw), `scoped` (linked-worktree OS-string
//! runners), `stdin`, and `stable_diagnostics`.

mod command;
mod finish;
mod runners;
mod scoped;
mod stable_diagnostics;
mod stdin;
mod version;

pub(super) use command::{git_command, git_command_bare};
pub(super) use finish::finish;
pub(super) use runners::{
    run_git, run_git_allow_exit_codes, run_git_bare, run_git_env, run_git_env_redacted,
    run_git_env_stdout, run_git_literal_paths, run_git_stdout, run_git_stdout_raw,
    run_git_stdout_raw_allow_exit_codes,
};
pub(super) use scoped::{run_git_scoped_os, run_git_scoped_os_stdout_raw};
pub(super) use stable_diagnostics::{
    run_git_env_stable_diagnostics, run_git_env_stable_diagnostics_redacted,
};
pub(super) use stdin::run_git_with_input;

#[cfg(test)]
use crate::git::REPOSITORY_LOCAL_ENV_VARS;
#[cfg(all(test, unix))]
use version::parse_git_version;

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
