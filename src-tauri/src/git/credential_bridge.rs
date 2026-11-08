//! App-managed `GIT_ASKPASS` credential bridge for GitLane-owned provider tokens
//! (GL-132).
//!
//! When a git network operation runs under a `providerToken`
//! [`TransportCredential`], GitLane must hand git a token it stored itself
//! without that token ever reaching the frontend. It does so the way editors
//! like VS Code do: git is pointed at **this same executable** as its
//! `GIT_ASKPASS` helper. Git execs it directly (no shell — so an app path with
//! spaces is never a hazard) with the credential prompt as `argv[1]`. The parent
//! process reads the token from the OS keychain once and exposes it through a
//! command-scoped loopback broker protected by a random nonce. The helper carries
//! no keychain locator and prints only the broker's answer on stdout. The token
//! value is never in IPC, the command line, the git environment, or a log. The
//! git environment does carry the broker's endpoint and nonce, so any process git
//! spawns, hooks included, can ask for the token while the command runs. Hooks
//! are trusted user code (`docs/rules/architecture-rules.md` §2).
//!
//! Two entry points:
//! - [`is_askpass_invocation`] / [`respond_to_askpass`] — the re-entrant helper,
//!   dispatched at the very top of `run()` before Tauri starts.
//! - [`git_invocation`] — builds the `-c` config prefix and extra env the
//!   transport layer applies to a git command for a given credential strategy.

use std::io::Write;

use crate::git::transport_auth::{ProviderTokenBridge, TransportCredential};
use crate::secrets::{KeyringStore, SecretKey, SecretStore};

mod broker;
// The ssh askpass bridge (remote-ssh-repos) secures its loopback the same way.
#[cfg(feature = "desktop")]
pub(crate) use broker::{constant_time_eq, random_nonce};

/// Marks a child process launched as our `GIT_ASKPASS` helper. Its presence — set
/// only on the git child we spawn — is what distinguishes an askpass invocation
/// from a normal app launch.
const ASKPASS_FLAG: &str = "GITLANE_ASKPASS";
const ENV_ENDPOINT: &str = "GITLANE_ASKPASS_ENDPOINT";
const ENV_NONCE: &str = "GITLANE_ASKPASS_NONCE";
const ENV_USERNAME: &str = "GITLANE_ASKPASS_USERNAME";

/// The `-c` config prefix and extra environment for one git network invocation.
#[derive(Default)]
pub struct GitInvocation {
    /// `-c key=value` pairs to prepend to the git argv.
    pub config: Vec<String>,
    /// Extra environment variables for the git child.
    pub env: Vec<(String, String)>,
    /// Owns the parent-side token broker for exactly as long as the git command.
    _broker: Option<broker::Lease>,
}

/// Whether this process was spawned by git as the `GIT_ASKPASS` helper.
pub fn is_askpass_invocation() -> bool {
    std::env::var_os(ASKPASS_FLAG).is_some()
}

/// Answer git's single askpass prompt (passed as `argv[1]`) from the parent's
/// broker, then return. Runs before Tauri initialises, so the helper process never opens
/// a window or touches IPC. Writes at most one line — the credential — to stdout
/// and nothing to stderr; on any miss it stays silent so git surfaces its own
/// authentication error.
pub fn respond_to_askpass() {
    let prompt = std::env::args().nth(1).unwrap_or_default();
    let env = AskpassEnv::from_process();
    if let Some(answer) = answer_askpass(&prompt, &env) {
        // The single line of stdout is the credential; the secret is never
        // written to stderr, argv, or any log.
        let mut out = std::io::stdout();
        let _ = out.write_all(answer.as_bytes());
        let _ = out.write_all(b"\n");
        let _ = out.flush();
    }
}

/// Build the git config prefix + env for a resolved [`TransportCredential`].
/// `None`/`Gh`/`Glab` carry no env (`Gh`'s pinned token lives only inside its
/// helper's `gh` child);
/// `ProviderToken` clears the host's inherited helper and wires `GIT_ASKPASS`
/// back to this binary with a non-secret locator.
pub fn git_invocation(cred: &TransportCredential) -> Result<GitInvocation, String> {
    match cred {
        TransportCredential::None => Ok(GitInvocation::default()),
        TransportCredential::CredentialHelper {
            host,
            use_http_path,
        } => Ok(GitInvocation {
            config: if *use_http_path {
                vec![
                    "-c".to_string(),
                    format!("credential.https://{host}.useHttpPath=true"),
                ]
            } else {
                Vec::new()
            },
            env: Vec::new(),
            _broker: None,
        }),
        TransportCredential::Gh {
            host,
            gh_host,
            login,
        } => Ok(GitInvocation {
            config: gh_helper_config(host, gh_host, login),
            env: Vec::new(),
            _broker: None,
        }),
        TransportCredential::Glab { host } => Ok(GitInvocation {
            config: glab_helper_config(host),
            env: Vec::new(),
            _broker: None,
        }),
        TransportCredential::ProviderToken(bridge) => {
            provider_token_invocation(bridge, &current_exe_path()?, &KeyringStore::new())
        }
    }
}

/// Inline gh helper for `host`, pinned to `login`: clear any inherited helper,
/// then set one that resolves `login`'s token on `gh_host` and hands it to
/// `gh auth git-credential` through `GH_TOKEN` / `GH_ENTERPRISE_TOKEN`.
///
/// gh's helper ignores the URL username and answers only for gh's *active*
/// account, so without the pin a remote bound to an inactive account gets no
/// credential at all. The token value is exported only to the exec'd `gh` child,
/// not to git's environment, because every git child starts without inherited
/// provider-token env (`write::cli::insulate_from_provider_tokens_and_locale`).
/// A hook inherits this `-c` helper, though, and can run it.
/// A failed or empty lookup exits 1 instead of letting gh fall back to the
/// active account. Only `get` resolves a token (gh's `store`/`erase` are
/// no-ops), and the lookup reads no stdin, so git's credential request reaches
/// `gh auth git-credential` intact. `gh_host` and `login` are validated by
/// `transport_auth` (no quotes, `$`, `;` or whitespace) before they get here.
fn gh_helper_config(host: &str, gh_host: &str, login: &str) -> Vec<String> {
    vec![
        "-c".to_string(),
        format!("credential.https://{host}.helper="),
        "-c".to_string(),
        format!(
            "credential.https://{host}.helper=!f() {{ \
             [ \"$1\" = get ] || exit 0; \
             t=$(gh auth token --hostname '{gh_host}' --user '{login}' </dev/null) && [ -n \"$t\" ] || exit 1; \
             GH_TOKEN=\"$t\" GH_ENTERPRISE_TOKEN=\"$t\" exec gh auth git-credential \"$@\"; \
             }}; f"
        ),
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
/// stored credential). The parent reads the keychain and starts an ephemeral
/// broker; the child receives only its random capability and the username.
///
/// The single empty `credential.https://<host>.helper=` reliably overrides a
/// *global* `credential.helper` too: git treats an empty value as a reset of the
/// accumulated helper list for that credential context, and `-c` config is
/// applied last — this is the documented "per-URL setting overrides a wider
/// default" behaviour, and the same mechanism the `gh` path (GL-129) relies on to
/// pin a specific account. It is deliberately scoped to this host so a submodule
/// on another host keeps using the user's helper.
///
/// The capability is generated afresh for this command and the broker is torn
/// down when [`GitInvocation`] drops. Static provider/host/account locators are
/// intentionally absent, so independently launching the app as an askpass
/// helper cannot turn it into a keychain oracle.
fn provider_token_invocation(
    bridge: &ProviderTokenBridge,
    exe: &str,
    store: &dyn SecretStore,
) -> Result<GitInvocation, String> {
    let key = SecretKey::new(
        &bridge.provider,
        &bridge.credential_host,
        &bridge.account_id,
    );
    let token = store
        .get(&key)
        .map_err(String::from)?
        .ok_or_else(|| "No stored token is available for this account.".to_string())?;
    let broker = broker::start(bridge.credential_host.clone(), token)?;
    let endpoint = broker.endpoint().to_string();
    let nonce = broker.nonce().to_string();

    Ok(GitInvocation {
        config: vec![
            "-c".to_string(),
            format!("credential.https://{}.helper=", bridge.credential_host),
        ],
        env: vec![
            ("GIT_ASKPASS".to_string(), exe.to_string()),
            (ASKPASS_FLAG.to_string(), "1".to_string()),
            (ENV_ENDPOINT.to_string(), endpoint),
            (ENV_NONCE.to_string(), nonce),
            (ENV_USERNAME.to_string(), bridge.username.clone()),
        ],
        _broker: Some(broker),
    })
}

fn current_exe_path() -> Result<String, String> {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.to_str().map(String::from))
        .ok_or_else(|| "Could not locate the GitLane executable for the credential bridge.".into())
}

/// Ephemeral broker capability read from the helper process environment.
struct AskpassEnv {
    endpoint: String,
    nonce: String,
    username: String,
}

impl AskpassEnv {
    fn from_process() -> Self {
        let read = |k: &str| std::env::var(k).unwrap_or_default();
        Self {
            endpoint: read(ENV_ENDPOINT),
            nonce: read(ENV_NONCE),
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

/// Resolve one askpass prompt. Usernames are non-secret; passwords must come
/// from the live parent broker. Any missing/forged capability stays silent.
fn answer_askpass(prompt: &str, env: &AskpassEnv) -> Option<String> {
    match askpass_field(prompt)? {
        AskpassField::Username => {
            let username = env.username.trim();
            (!username.is_empty()).then(|| username.to_string())
        }
        AskpassField::Password => broker::request(&env.endpoint, &env.nonce, prompt),
    }
}

fn hosts_match(a: &str, b: &str) -> bool {
    a.trim().eq_ignore_ascii_case(b.trim())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    mod git_integration;
    mod git_invocation;
    #[cfg(unix)]
    mod hook_boundary;
    mod provider_token;
    #[cfg(unix)]
    mod support;

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
}
