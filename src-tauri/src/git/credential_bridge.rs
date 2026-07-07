//! App-managed `GIT_ASKPASS` credential bridge for GitLane-owned provider tokens
//! (GL-132).
//!
//! When a git network operation runs under a `providerToken`
//! [`TransportCredential`], GitLane must hand git a token it stored itself
//! without that token ever reaching the frontend. It does so the way editors
//! like VS Code do: git is pointed at **this same executable** as its
//! `GIT_ASKPASS` helper. Git execs it directly (no shell — so an app path with
//! spaces is never a hazard) with the credential prompt as `argv[1]`; a few
//! **non-secret** environment variables tell the helper which keychain entry to
//! answer with. The helper reads the token from the OS keychain
//! ([`crate::secrets`]) inside that short-lived child process and prints it on
//! stdout. The token lives only in the git↔helper process pair; it is never in
//! IPC, the command line, or a log.
//!
//! Two entry points:
//! - [`is_askpass_invocation`] / [`respond_to_askpass`] — the re-entrant helper,
//!   dispatched at the very top of `run()` before Tauri starts.
//! - [`git_invocation`] — builds the `-c` config prefix and extra env the
//!   transport layer applies to a git command for a given credential strategy.

use std::io::Write;

use crate::git::transport_auth::{ProviderTokenBridge, TransportCredential};
use crate::secrets::{KeyringStore, SecretKey, SecretStore};

/// Marks a child process launched as our `GIT_ASKPASS` helper. Its presence — set
/// only on the git child we spawn — is what distinguishes an askpass invocation
/// from a normal app launch.
const ASKPASS_FLAG: &str = "GITLANE_ASKPASS";
const ENV_PROVIDER: &str = "GITLANE_ASKPASS_PROVIDER";
const ENV_HOST: &str = "GITLANE_ASKPASS_HOST";
const ENV_ACCOUNT: &str = "GITLANE_ASKPASS_ACCOUNT";
const ENV_USERNAME: &str = "GITLANE_ASKPASS_USERNAME";

/// The `-c` config prefix and extra environment for one git network invocation.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct GitInvocation {
    /// `-c key=value` pairs to prepend to the git argv.
    pub config: Vec<String>,
    /// Extra environment variables for the git child.
    pub env: Vec<(String, String)>,
}

/// Whether this process was spawned by git as the `GIT_ASKPASS` helper.
pub fn is_askpass_invocation() -> bool {
    std::env::var_os(ASKPASS_FLAG).is_some()
}

/// Answer git's single askpass prompt (passed as `argv[1]`) from the OS keychain,
/// then return. Runs before Tauri initialises, so the helper process never opens
/// a window or touches IPC. Writes at most one line — the credential — to stdout
/// and nothing to stderr; on any miss it stays silent so git surfaces its own
/// authentication error.
pub fn respond_to_askpass() {
    let prompt = std::env::args().nth(1).unwrap_or_default();
    let env = AskpassEnv::from_process();
    let store = KeyringStore::new();
    if let Some(answer) = answer_askpass(&prompt, &env, &store) {
        // The single line of stdout is the credential; the secret is never
        // written to stderr, argv, or any log.
        let mut out = std::io::stdout();
        let _ = out.write_all(answer.as_bytes());
        let _ = out.write_all(b"\n");
        let _ = out.flush();
    }
}

/// Build the git config prefix + env for a resolved [`TransportCredential`].
/// `None`/`Gh` carry no env and reproduce the pre-GL-132 behaviour exactly;
/// `ProviderToken` clears the host's inherited helper and wires `GIT_ASKPASS`
/// back to this binary with a non-secret locator.
pub fn git_invocation(cred: &TransportCredential) -> Result<GitInvocation, String> {
    match cred {
        TransportCredential::None => Ok(GitInvocation::default()),
        TransportCredential::Gh { host } => Ok(GitInvocation {
            config: gh_helper_config(host),
            env: Vec::new(),
        }),
        TransportCredential::Glab { host } => Ok(GitInvocation {
            config: glab_helper_config(host),
            env: Vec::new(),
        }),
        TransportCredential::ProviderToken(bridge) => {
            Ok(provider_token_invocation(bridge, &current_exe_path()?))
        }
    }
}

/// Inline `gh auth git-credential` for `host`: clear any inherited helper, then
/// set gh's. Unchanged from the original per-remote GitHub auth wiring (GL-129).
fn gh_helper_config(host: &str) -> Vec<String> {
    vec![
        "-c".to_string(),
        format!("credential.https://{host}.helper="),
        "-c".to_string(),
        format!("credential.https://{host}.helper=!gh auth git-credential"),
    ]
}

/// Inline `glab auth git-credential` for `host` — the GitLab analogue of
/// [`gh_helper_config`] (GL-139). glab implements the same git credential-helper
/// protocol as gh and answers from its own token store, so a glab sign-in makes
/// GitLab remotes authenticate with no per-remote setup. Scoped to `host` (the
/// empty reset overrides only that host's inherited helper); `glab` is resolved
/// on the augmented PATH the git child runs with, same as `gh`.
fn glab_helper_config(host: &str) -> Vec<String> {
    vec![
        "-c".to_string(),
        format!("credential.https://{host}.helper="),
        "-c".to_string(),
        format!("credential.https://{host}.helper=!glab auth git-credential"),
    ]
}

/// Point git at this binary as `GIT_ASKPASS`, clearing the host's inherited
/// helper so git falls through to the bridge (rather than returning a different
/// stored credential). The env carries only non-secret locators; the token is
/// fetched from the keychain by the helper child.
///
/// The single empty `credential.https://<host>.helper=` reliably overrides a
/// *global* `credential.helper` too: git treats an empty value as a reset of the
/// accumulated helper list for that credential context, and `-c` config is
/// applied last — this is the documented "per-URL setting overrides a wider
/// default" behaviour, and the same mechanism the `gh` path (GL-129) relies on to
/// pin a specific account. It is deliberately scoped to this host so a submodule
/// on another host keeps using the user's helper.
///
/// Threat model: the helper reads the keychain from a child of this same signed
/// binary, so a local, same-user process that can exec GitLane with the right env
/// could invoke it and read a token. That is inherent to the GIT_ASKPASS +
/// OS-keychain pattern (VS Code, GitKraken, etc. share it); hardening it to a
/// parent-brokered socket with a per-run nonce is tracked as future work.
fn provider_token_invocation(bridge: &ProviderTokenBridge, exe: &str) -> GitInvocation {
    GitInvocation {
        config: vec![
            "-c".to_string(),
            format!("credential.https://{}.helper=", bridge.credential_host),
        ],
        env: vec![
            ("GIT_ASKPASS".to_string(), exe.to_string()),
            (ASKPASS_FLAG.to_string(), "1".to_string()),
            (ENV_PROVIDER.to_string(), bridge.provider.clone()),
            (ENV_HOST.to_string(), bridge.credential_host.clone()),
            (ENV_ACCOUNT.to_string(), bridge.account_id.clone()),
            (ENV_USERNAME.to_string(), bridge.username.clone()),
        ],
    }
}

fn current_exe_path() -> Result<String, String> {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.to_str().map(String::from))
        .ok_or_else(|| "Could not locate the GitLane executable for the credential bridge.".into())
}

/// Non-secret locator read from the child process environment.
struct AskpassEnv {
    provider: String,
    host: String,
    account_id: String,
    username: String,
}

impl AskpassEnv {
    fn from_process() -> Self {
        let read = |k: &str| std::env::var(k).unwrap_or_default();
        Self {
            provider: read(ENV_PROVIDER),
            host: read(ENV_HOST),
            account_id: read(ENV_ACCOUNT),
            username: read(ENV_USERNAME),
        }
    }
}

/// Which field git is asking for.
#[derive(Debug, PartialEq, Eq)]
enum AskpassField {
    Username,
    Password,
}

/// Classify git's askpass prompt. git uses `Username for '<url>'` /
/// `Password for '<url>'`; these prompts are not localised.
fn askpass_field(prompt: &str) -> Option<AskpassField> {
    let p = prompt.trim_start().to_ascii_lowercase();
    if p.starts_with("username") {
        Some(AskpassField::Username)
    } else if p.starts_with("password") {
        Some(AskpassField::Password)
    } else {
        None
    }
}

/// The credential authority named inside an askpass prompt, if any — the URL git
/// quotes (`Password for 'https://alice@gitlab.com'`). Used as a defensive check
/// so a token is never answered for a host other than the one it was scoped to.
fn prompt_host(prompt: &str) -> Option<String> {
    let start = prompt.find('\'')? + 1;
    let rest = &prompt[start..];
    let end = rest.find('\'')?;
    super::forge::credential_host_for_url(&rest[..end])
}

/// Resolve the answer for one askpass prompt from `env` + `store`, or `None` when
/// GitLane should stay silent (unknown field, host mismatch, or no stored token).
fn answer_askpass(prompt: &str, env: &AskpassEnv, store: &dyn SecretStore) -> Option<String> {
    match askpass_field(prompt)? {
        AskpassField::Username => {
            let username = env.username.trim();
            (!username.is_empty()).then(|| username.to_string())
        }
        AskpassField::Password => {
            // Fail closed: only hand the token to the exact host it was scoped to.
            // `GIT_ASKPASS` is inherited by nested git processes (submodule
            // fetches, cross-host redirects), so if the prompt names a different
            // host — or no parseable host at all — refuse rather than risk leaking
            // the token to the wrong authority.
            match prompt_host(prompt) {
                Some(host) if hosts_match(&host, &env.host) => {
                    let key = SecretKey::new(&env.provider, &env.host, &env.account_id);
                    store.get(&key).ok().flatten()
                }
                _ => None,
            }
        }
    }
}

fn hosts_match(a: &str, b: &str) -> bool {
    a.trim().eq_ignore_ascii_case(b.trim())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::MemoryStore;

    fn env(host: &str) -> AskpassEnv {
        AskpassEnv {
            provider: "gitlab".into(),
            host: host.into(),
            account_id: "42".into(),
            username: "alice".into(),
        }
    }

    #[test]
    fn askpass_field_classifies_username_and_password_prompts() {
        assert_eq!(
            askpass_field("Username for 'https://gitlab.com': "),
            Some(AskpassField::Username)
        );
        assert_eq!(
            askpass_field("Password for 'https://alice@gitlab.com': "),
            Some(AskpassField::Password)
        );
        assert_eq!(askpass_field("Passphrase for key: "), None);
        assert_eq!(askpass_field(""), None);
    }

    #[test]
    fn prompt_host_extracts_the_quoted_authority() {
        assert_eq!(
            prompt_host("Password for 'https://alice@gitlab.com': ").as_deref(),
            Some("gitlab.com")
        );
        assert_eq!(
            prompt_host("Password for 'https://ghe.example.test:8443': ").as_deref(),
            Some("ghe.example.test:8443")
        );
        assert_eq!(prompt_host("Password: ").as_deref(), None);
    }

    #[test]
    fn answers_username_from_env_and_password_from_keychain() {
        let store = MemoryStore::new();
        store
            .set(
                &SecretKey::new("gitlab", "gitlab.com", "42"),
                "glpat-secret",
            )
            .unwrap();
        let env = env("gitlab.com");

        assert_eq!(
            answer_askpass("Username for 'https://gitlab.com': ", &env, &store).as_deref(),
            Some("alice")
        );
        assert_eq!(
            answer_askpass("Password for 'https://alice@gitlab.com': ", &env, &store).as_deref(),
            Some("glpat-secret")
        );
    }

    #[test]
    fn stays_silent_when_no_token_is_stored() {
        let store = MemoryStore::new();
        let env = env("gitlab.com");
        assert_eq!(
            answer_askpass("Password for 'https://alice@gitlab.com': ", &env, &store),
            None
        );
    }

    #[test]
    fn refuses_to_answer_a_password_for_a_different_host() {
        let store = MemoryStore::new();
        store
            .set(
                &SecretKey::new("gitlab", "gitlab.com", "42"),
                "glpat-secret",
            )
            .unwrap();
        let env = env("gitlab.com");
        // git is asking for evil.example, our token is scoped to gitlab.com.
        assert_eq!(
            answer_askpass("Password for 'https://alice@evil.example': ", &env, &store),
            None
        );
    }

    #[test]
    fn refuses_a_password_prompt_with_no_parseable_host() {
        // Fail closed: a prompt we cannot attribute to our host must not yield the
        // token (GIT_ASKPASS is inherited by nested git processes).
        let store = MemoryStore::new();
        store
            .set(
                &SecretKey::new("gitlab", "gitlab.com", "42"),
                "glpat-secret",
            )
            .unwrap();
        let env = env("gitlab.com");
        assert_eq!(answer_askpass("Password: ", &env, &store), None);
    }

    #[test]
    fn git_invocation_none_is_empty() {
        assert_eq!(
            git_invocation(&TransportCredential::None).unwrap(),
            GitInvocation::default()
        );
    }

    #[test]
    fn git_invocation_gh_clears_then_sets_gh_helper() {
        let inv = git_invocation(&TransportCredential::Gh {
            host: "github.com".into(),
        })
        .unwrap();
        assert_eq!(
            inv.config,
            vec![
                "-c".to_string(),
                "credential.https://github.com.helper=".to_string(),
                "-c".to_string(),
                "credential.https://github.com.helper=!gh auth git-credential".to_string(),
            ]
        );
        assert!(inv.env.is_empty());
    }

    #[test]
    fn git_invocation_glab_clears_then_sets_glab_helper() {
        let inv = git_invocation(&TransportCredential::Glab {
            host: "gitlab.com".into(),
        })
        .unwrap();
        assert_eq!(
            inv.config,
            vec![
                "-c".to_string(),
                "credential.https://gitlab.com.helper=".to_string(),
                "-c".to_string(),
                "credential.https://gitlab.com.helper=!glab auth git-credential".to_string(),
            ]
        );
        assert!(inv.env.is_empty());
    }

    #[test]
    fn provider_token_invocation_clears_helper_and_carries_no_secret() {
        let bridge = ProviderTokenBridge {
            credential_host: "gitlab.com".into(),
            username: "alice".into(),
            provider: "gitlab".into(),
            account_id: "42".into(),
        };
        let inv = provider_token_invocation(&bridge, "/Apps/Git Lane.app/Contents/MacOS/GitLane");

        // Only the helper-clearing -c line; no gh helper, no secret.
        assert_eq!(
            inv.config,
            vec![
                "-c".to_string(),
                "credential.https://gitlab.com.helper=".to_string(),
            ]
        );
        // Env points GIT_ASKPASS at this binary and carries only locators.
        let env: std::collections::HashMap<_, _> = inv.env.iter().cloned().collect();
        assert_eq!(
            env.get("GIT_ASKPASS").map(String::as_str),
            Some("/Apps/Git Lane.app/Contents/MacOS/GitLane")
        );
        assert_eq!(env.get(ASKPASS_FLAG).map(String::as_str), Some("1"));
        assert_eq!(env.get(ENV_PROVIDER).map(String::as_str), Some("gitlab"));
        assert_eq!(env.get(ENV_HOST).map(String::as_str), Some("gitlab.com"));
        assert_eq!(env.get(ENV_ACCOUNT).map(String::as_str), Some("42"));
        assert_eq!(env.get(ENV_USERNAME).map(String::as_str), Some("alice"));
        // The token itself is never present in the invocation.
        assert!(!inv
            .env
            .iter()
            .any(|(_, v)| v.contains("glpat") || v.contains("secret")));
    }
}

/// End-to-end proof that a real `git` uses the `GIT_ASKPASS` bridge to obtain a
/// password and sends it over the wire — the credential is supplied entirely by
/// the helper, never by the frontend. The keychain read itself is covered by the
/// unit tests above; here the askpass helper is a small script so the test stays
/// hermetic (no OS keychain) and runs on headless CI.
#[cfg(all(test, unix))]
mod git_integration {
    use super::*;
    use base64::Engine;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::os::unix::fs::PermissionsExt;
    use std::process::Command;
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    #[test]
    fn git_fetch_sends_the_password_from_the_askpass_bridge() {
        let dir = std::env::temp_dir().join(format!(
            "gitlane-bridge-{}-{}",
            std::process::id(),
            unique_id()
        ));
        std::fs::create_dir_all(&dir).unwrap();

        // A throwaway repo to run `git -C` against.
        let repo = dir.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        assert!(Command::new("git")
            .args(["init", "-q", repo.to_str().unwrap()])
            .status()
            .expect("git init launches")
            .success());

        // An askpass helper answering git's Username/Password prompts — this
        // stands in for the real re-entrant binary, which resolves the password
        // from the keychain (see `answers_username_from_env_and_password...`).
        let askpass = dir.join("askpass.sh");
        std::fs::write(
            &askpass,
            "#!/bin/sh\ncase \"$1\" in\n  Username*) printf 'testuser' ;;\n  *) printf 's3cr3t-token' ;;\nesac\n",
        )
        .unwrap();
        std::fs::set_permissions(&askpass, std::fs::Permissions::from_mode(0o755)).unwrap();

        // A local server that *always* 401s so git escalates from an anonymous
        // request, to the URL username with an empty password, to the askpass
        // password — recording every Authorization header it sees. Non-blocking
        // with a deadline so the thread can never hang the test.
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind local test server");
        listener
            .set_nonblocking(true)
            .expect("nonblocking listener");
        let addr = listener.local_addr().expect("local addr");
        let expected = format!(
            "Basic {}",
            base64::engine::general_purpose::STANDARD.encode("testuser:s3cr3t-token")
        );
        let want = expected.clone();
        let captured = Arc::new(Mutex::new(Vec::<String>::new()));
        let sink = captured.clone();
        let handle = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(10);
            while Instant::now() < deadline {
                let (mut stream, _) = match listener.accept() {
                    Ok(conn) => conn,
                    Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(20));
                        continue;
                    }
                    Err(_) => break,
                };
                let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
                let mut buf = [0u8; 2048];
                let n = stream.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]);
                if let Some(auth) = req
                    .lines()
                    .find_map(|l| l.strip_prefix("Authorization: ").map(str::to_string))
                {
                    let done = auth == want;
                    sink.lock().unwrap().push(auth);
                    let _ = stream.write_all(
                        b"HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"t\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                    );
                    // Stop as soon as the real token lands so we don't wait out
                    // the deadline once the assertion can already pass.
                    if done {
                        break;
                    }
                } else {
                    let _ = stream.write_all(
                        b"HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"t\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                    );
                }
            }
        });

        // Build the invocation exactly as production does, but point GIT_ASKPASS
        // at the stub helper instead of the app binary.
        let bridge = ProviderTokenBridge {
            credential_host: format!("{addr}"),
            username: "testuser".into(),
            provider: "gitlab".into(),
            account_id: "1".into(),
        };
        let inv = provider_token_invocation(&bridge, askpass.to_str().unwrap());

        let url = format!("http://testuser@{addr}/repo.git");
        let mut args: Vec<String> = vec!["-C".into(), repo.to_str().unwrap().into()];
        args.extend(inv.config.clone());
        args.extend(["fetch".into(), url, "HEAD".into()]);

        let mut cmd = Command::new("git");
        cmd.args(&args)
            // Hermetic: ignore the developer's real git config / helpers.
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_TERMINAL_PROMPT", "0");
        for (k, v) in &inv.env {
            cmd.env(k, v);
        }
        // The fetch fails (the server is not a real git host); we only assert the
        // token reached the wire via askpass.
        let _ = cmd.output();
        handle.join().expect("server thread joins");

        let seen = captured.lock().unwrap().clone();
        assert!(
            seen.iter().any(|h| h == &expected),
            "git should authenticate with the askpass-provided token; saw {seen:?}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    fn unique_id() -> u128 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    }
}
