//! A real `git` push in provider-token mode, through the production push path:
//! git does not pass a hook the token value in its environment or argv. A hook
//! can still ask the credential route git was given, which is the documented
//! trust boundary (`docs/rules/architecture-rules.md` §2).

use super::support::{basic_auth, serve_until_authorized, unique_id, Scratch};
use super::*;
use crate::secrets::MemoryStore;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

/// The stored token goes through the real helper logic and broker, and git sends
/// it on the wire before its pre-push hook runs. The only stub is the askpass
/// script, which replays that answer in place of the app binary.
#[test]
fn pre_push_hook_env_and_argv_do_not_contain_the_provider_token() {
    const TOKEN: &str = "fake-hook-boundary-token";
    let scratch = Scratch(std::env::temp_dir().join(format!(
        "gitlane-hook-boundary-{}-{}",
        std::process::id(),
        unique_id()
    )));
    let dir = &scratch.0;
    let repo = dir.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    let git = || {
        let mut cmd = crate::git::isolated_git_command();
        cmd.arg("-C")
            .arg(&repo)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1");
        cmd
    };
    assert!(git().args(["init", "-q"]).status().unwrap().success());
    assert!(git()
        .args(["-c", "user.name=t", "-c", "user.email=t@example.test"])
        .args(["commit", "-q", "--allow-empty", "-m", "x"])
        .status()
        .unwrap()
        .success());

    let script = |path: &Path, body: String| {
        std::fs::write(path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    };
    let (env_log, argv_log) = (dir.join("hook.env"), dir.join("hook.argv"));
    // A custom or empty init template leaves no hooks directory.
    std::fs::create_dir_all(repo.join(".git/hooks")).unwrap();
    // The hook declines the push, so the server never has to accept a pack.
    script(
        &repo.join(".git/hooks/pre-push"),
        format!(
            "env > '{}'\nprintf '%s\\n' \"$@\" > '{}'\nexit 1",
            env_log.display(),
            argv_log.display()
        ),
    );

    // Git runs pre-push only after it has this empty receive-pack advertisement.
    let capabilities = format!("{} capabilities^{{}}\0report-status\n", "0".repeat(40));
    let advertisement = format!(
        "001f# service=git-receive-pack\n0000{:04x}{capabilities}0000",
        capabilities.len() + 4
    );
    let accepted = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/x-git-receive-pack-advertisement\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{advertisement}",
        advertisement.len()
    );
    let expected = basic_auth("alice", TOKEN);
    let (addr, handle) = serve_until_authorized(expected.clone(), accepted.into_bytes());

    let host = addr.to_string();
    let store = MemoryStore::new();
    store
        .set(&SecretKey::new("gitlab", &host, "1"), TOKEN)
        .unwrap();
    let askpass = dir.join("askpass.sh");
    let mut inv = provider_token_invocation(
        &ProviderTokenBridge {
            credential_host: host.clone(),
            username: "alice".into(),
            provider: "gitlab".into(),
            account_id: "1".into(),
        },
        askpass.to_str().unwrap(),
        &store,
    )
    .unwrap();
    // Hermetic: the developer's config, helpers and proxy must not take part.
    inv.env.extend(
        [
            ("GIT_CONFIG_GLOBAL", "/dev/null"),
            ("GIT_CONFIG_NOSYSTEM", "1"),
            ("NO_PROXY", "*"),
        ]
        .map(|(key, value)| (key.to_string(), value.to_string())),
    );
    let read_env = |key: &str| inv.env.iter().find(|(k, _)| k == key).unwrap().1.clone();

    // The stub replays the real answer only if git asks this exact prompt.
    let prompt = format!("Password for 'http://alice@{host}': ");
    let answer = answer_askpass(
        &prompt,
        &AskpassEnv {
            endpoint: read_env(ENV_ENDPOINT),
            nonce: read_env(ENV_NONCE),
            username: read_env(ENV_USERNAME),
        },
    )
    .expect("the broker answers git's prompt");
    let answer_file = dir.join("answer");
    std::fs::write(&answer_file, answer).unwrap();
    script(
        &askpass,
        format!(
            "case \"$1\" in \"{prompt}\") cat '{}' ;; *) exit 1 ;; esac",
            answer_file.display()
        ),
    );

    let url = format!("http://alice@{host}/repo.git");
    assert!(git()
        .args(["remote", "add", "origin", &url])
        .status()
        .unwrap()
        .success());
    let output = crate::git::write::remotes::run_push_under(
        repo.to_str().unwrap(),
        &inv,
        "origin",
        &["HEAD:refs/heads/main"],
    );
    let seen = handle.join().expect("server thread joins");

    assert!(
        seen.contains(&expected),
        "git should authenticate with the token: {seen:?} {output:?}"
    );
    let read_log = |path: &Path| {
        std::fs::read_to_string(path)
            .unwrap_or_else(|err| panic!("pre-push hook did not run: {err}; {output:?}"))
    };
    let (hook_env, hook_argv) = (read_log(&env_log), read_log(&argv_log));
    assert!(
        hook_env.contains(&format!("{ENV_NONCE}={}", read_env(ENV_NONCE))),
        "the hook should see this invocation's environment"
    );
    assert!(hook_argv.contains(&url), "argv was recorded: {hook_argv}");
    let encoded = expected.strip_prefix("Basic ").unwrap();
    for secret in [TOKEN, encoded] {
        assert!(!hook_env.contains(secret), "token in hook env");
        assert!(!hook_argv.contains(secret), "token in hook argv");
    }
}
