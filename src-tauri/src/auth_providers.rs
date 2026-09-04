//! Auth-only status probes for non-GitHub forge providers.
//!
//! These probes deliberately do not read, store, or return tokens. They only
//! report whether a local CLI/auth path appears usable so Settings can guide
//! users before real provider-specific PR integrations exist.

use std::collections::HashMap;
use std::process::{Child, Command, Output, Stdio};
use std::time::{Duration, Instant};

use serde::Deserialize;

use crate::git::forge::ForgeKind;
use crate::git::types::{ForgeAccount, ForgeAuthStatus};

/// Upper bound on a single auth probe. Some CLIs (`glab auth status`) validate
/// the token against the remote API and can hang on a slow/offline network; a
/// timed-out probe is reported as "CLI present, auth unverified" rather than
/// blocking the Settings panel forever.
const PROBE_TIMEOUT: Duration = Duration::from_secs(4);

struct ProviderSpec {
    provider: &'static str,
    forge: &'static str,
    cli: Option<&'static str>,
    status_args: &'static [&'static str],
    auth_method: &'static str,
    login_command: &'static str,
    logout_args: Option<&'static [&'static str]>,
    /// When true, `logout_args` alone is insufficient: the CLI's `logout` refuses
    /// to run without an explicit `--hostname` and cannot prompt in our
    /// non-interactive spawn (glab). Sign-out then resolves the signed-in host(s)
    /// from `status_args` and appends `--hostname <host>` per host.
    logout_needs_hostname: bool,
    docs_url: &'static str,
    notes: &'static str,
    /// When true, a zero-exit probe with empty stdout+stderr is treated as
    /// *not* authenticated. Used for `tea login list`, which exits 0 even with
    /// no configured logins — we infer "signed in" only when it emits a login
    /// listing. Assumes an empty login list produces no output; if a future
    /// `tea` prints table chrome for the empty case this would over-report.
    require_output: bool,
}

const PROVIDERS: &[ProviderSpec] = &[
    ProviderSpec {
        provider: "gitlab",
        forge: "GitLab",
        cli: Some("glab"),
        status_args: &["auth", "status"],
        auth_method: "GitLab CLI",
        login_command: "glab auth login",
        logout_args: Some(&["auth", "logout"]),
        logout_needs_hostname: true,
        docs_url: "https://gitlab.com/gitlab-org/cli",
        notes: "Signed in with glab. Merge requests (list, view, create, merge, approve) work when glab is signed in.",
        require_output: false,
    },
    ProviderSpec {
        provider: ForgeKind::CURSOR_ORIGIN_KEY,
        forge: "Cursor Origin",
        cli: Some("origin"),
        status_args: &["auth", "status"],
        auth_method: "Origin CLI",
        login_command: "origin auth login",
        logout_args: Some(&["auth", "logout"]),
        logout_needs_hostname: false,
        docs_url: "https://cursor.com/docs/origin/cli",
        notes: "Signed in with origin. Pull request list, detail, diff, merge, and existing review threads work when origin is signed in. Creating Origin PRs is not in GitLane yet.",
        require_output: false,
    },
    ProviderSpec {
        provider: "bitbucket",
        forge: "Bitbucket",
        cli: None,
        status_args: &[],
        auth_method: "Git credential helper / GCM or SSH",
        login_command: "Use an HTTPS remote with Git Credential Manager, or use an SSH remote with a Bitbucket SSH key.",
        logout_args: None,
        logout_needs_hostname: false,
        docs_url: "https://support.atlassian.com/bitbucket-cloud/docs/configure-ssh-and-two-step-verification/",
        notes: "Bitbucket has no bundled CLI. Git transport works through Git's credential helper/GCM for HTTPS, or through SSH keys for SSH remotes.",
        require_output: false,
    },
    ProviderSpec {
        provider: "azure-devops",
        forge: "Azure DevOps",
        cli: Some("az"),
        status_args: &["account", "show", "--output", "none"],
        auth_method: "Azure CLI",
        login_command: "az login",
        logout_args: Some(&["logout"]),
        logout_needs_hostname: false,
        // The connect path's first step is installing `az`, so point at the
        // Azure CLI install guide rather than the Azure DevOps CLI extension docs.
        // Locale-less URL — Learn redirects to the visitor's locale.
        docs_url: "https://learn.microsoft.com/cli/azure/install-azure-cli?view=azure-cli-latest",
        notes: "Uses Azure CLI sign-in as the account signal. Git transport works through GCM/helper for HTTPS, or through SSH keys for SSH remotes.",
        require_output: false,
    },
    ProviderSpec {
        provider: "gitea",
        forge: "Gitea",
        cli: Some("tea"),
        status_args: &["login", "list"],
        auth_method: "tea CLI",
        login_command: "tea login add",
        logout_args: None,
        logout_needs_hostname: false,
        docs_url: "https://gitea.com/gitea/tea",
        notes: "Uses tea login metadata only. Gitea PR features are not implemented.",
        require_output: true,
    },
    ProviderSpec {
        provider: "forgejo",
        forge: "Forgejo",
        cli: Some("tea"),
        status_args: &["login", "list"],
        auth_method: "tea CLI",
        login_command: "tea login add",
        logout_args: None,
        logout_needs_hostname: false,
        docs_url: "https://forgejo.org/docs/latest/user/cli/",
        notes: "Forgejo is Gitea-compatible for tea login metadata. PR features are not implemented.",
        require_output: true,
    },
];

pub fn statuses() -> Vec<ForgeAuthStatus> {
    // Several providers share a CLI probe (Gitea and Forgejo both run
    // `tea login list`). Memoize by probe identity so each distinct CLI command
    // is spawned at most once per call.
    let mut cache: HashMap<String, (bool, Option<bool>)> = HashMap::new();
    PROVIDERS
        .iter()
        .map(|spec| status_for(spec, &mut cache))
        .collect()
}

fn status_for(
    spec: &ProviderSpec,
    cache: &mut HashMap<String, (bool, Option<bool>)>,
) -> ForgeAuthStatus {
    let (available, authenticated) = match spec.cli {
        Some(cli) => {
            let key = format!(
                "{cli}\u{1f}{}\u{1f}{}",
                spec.status_args.join("\u{1f}"),
                spec.require_output
            );
            if let Some(hit) = cache.get(&key) {
                *hit
            } else {
                let res = probe_cli(cli, spec.status_args, spec.require_output);
                cache.insert(key, res);
                res
            }
        }
        None => (false, None),
    };
    ForgeAuthStatus {
        provider: spec.provider.to_string(),
        forge: spec.forge.to_string(),
        cli: spec.cli.map(str::to_string),
        auth_method: spec.auth_method.to_string(),
        available,
        authenticated,
        login_command: spec.login_command.to_string(),
        docs_url: spec.docs_url.to_string(),
        notes: spec.notes.to_string(),
        // Account identity is resolved separately (a network whoami) so the
        // status probe stays fast and the UI can skeleton the identity. See
        // `account()` / the `forge_account` command.
        account: None,
    }
}

/// Fetch the signed-in account for an authenticated provider via its CLI whoami.
/// Best-effort and provider-specific (GitLab + Azure today); `None` means we
/// can't resolve it, and the UI falls back to a provider-level "signed in"
/// label. This is the slow, network-touching part — kept out of `statuses()`.
pub fn account(provider: &str) -> Option<ForgeAccount> {
    fetch_account(provider)
}

pub fn sign_out(provider: &str) -> Result<String, String> {
    let spec = PROVIDERS
        .iter()
        .find(|spec| spec.provider == provider)
        .ok_or_else(|| format!("Unsupported provider '{provider}'."))?;
    let cli = spec
        .cli
        .ok_or_else(|| format!("{} has no CLI sign-out path in GitLane.", spec.forge))?;
    let args = spec
        .logout_args
        .ok_or_else(|| format!("{} sign-out is not available from GitLane yet.", spec.forge))?;

    // glab's `auth logout` rejects an invocation without `--hostname` and cannot
    // prompt for one in a non-interactive spawn, so log out of each signed-in host.
    if spec.logout_needs_hostname {
        return sign_out_per_host(spec, cli, args);
    }

    let out = run_bounded_with_stderr(cli, args)
        .ok_or_else(|| format!("Failed to launch {cli} sign-out."))?;
    if out.status.success() {
        let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
        Ok(if text.is_empty() {
            format!("Signed out of {}", spec.forge)
        } else {
            text
        })
    } else {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            format!("{} sign-out failed.", spec.forge)
        } else {
            stderr
        })
    }
}

/// Sign out of a CLI whose `logout` needs an explicit `--hostname` (glab):
/// resolve the signed-in host(s) from the status probe and run `logout
/// --hostname <host>` for each. Reports honestly: full success only when every
/// host cleared, a partial error naming the hosts that remain otherwise, so a
/// half-failed logout never reads as done.
fn sign_out_per_host(spec: &ProviderSpec, cli: &str, base_args: &[&str]) -> Result<String, String> {
    let hosts = logged_in_hosts(cli, spec.status_args);
    if hosts.is_empty() {
        return Err(format!(
            "Could not determine which {} host to sign out of.",
            spec.forge
        ));
    }
    let mut ok_hosts: Vec<&String> = Vec::new();
    let mut failed_hosts: Vec<&String> = Vec::new();
    let mut last_err: Option<String> = None;
    for host in &hosts {
        let mut args: Vec<&str> = base_args.to_vec();
        args.push("--hostname");
        args.push(host);
        match run_bounded_with_stderr(cli, &args) {
            Some(out) if out.status.success() => ok_hosts.push(host),
            Some(out) => {
                failed_hosts.push(host);
                let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
                if !stderr.is_empty() {
                    last_err = Some(stderr);
                }
            }
            None => {
                failed_hosts.push(host);
                last_err = Some(format!("Failed to launch {cli} sign-out."));
            }
        }
    }
    match (ok_hosts.is_empty(), failed_hosts.is_empty()) {
        (false, true) => Ok(format!("Signed out of {}", spec.forge)),
        (true, _) => Err(last_err.unwrap_or_else(|| format!("{} sign-out failed.", spec.forge))),
        // Partial: some hosts cleared, some remain — say so instead of claiming success.
        (false, false) => Err(format!(
            "Signed out of {}, but {} still signed in{}.",
            join_hosts(&ok_hosts),
            join_hosts(&failed_hosts),
            last_err.map(|e| format!(" ({e})")).unwrap_or_default(),
        )),
    }
}

fn join_hosts(hosts: &[&String]) -> String {
    hosts
        .iter()
        .map(|h| h.as_str())
        .collect::<Vec<_>>()
        .join(", ")
}

/// The hosts a CLI reports as signed in, parsed from its `status` output. glab
/// prints `auth status` to stderr with each host un-indented and that host's
/// details indented beneath, so a host line is a bare authority with no leading
/// whitespace.
fn logged_in_hosts(cli: &str, status_args: &[&str]) -> Vec<String> {
    let Some(out) = run_bounded_with_stderr(cli, status_args) else {
        return Vec::new();
    };
    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
    text.push('\n');
    text.push_str(&String::from_utf8_lossy(&out.stderr));
    parse_status_hosts(&text)
}

fn parse_status_hosts(text: &str) -> Vec<String> {
    let mut hosts: Vec<String> = Vec::new();
    for line in text.lines() {
        // Detail lines are indented; only the bare host lines start at column 0.
        if line.is_empty() || line.starts_with(char::is_whitespace) {
            continue;
        }
        let host = line.trim();
        if looks_like_host(host) && !hosts.iter().any(|h| h == host) {
            hosts.push(host.to_string());
        }
    }
    hosts
}

/// A conservative authority shape (`host` or `host:port`) — enough to reject the
/// glyph/prose lines in status output while accepting real GitLab hostnames.
fn looks_like_host(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 253
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':'))
}

// NOTE: the set of providers handled here must stay in sync with `FORGE_WHOAMI`
// in `src/store/accounts.ts`, which decides which providers the UI resolves an
// identity for. Adding a case here without updating that set means the identity
// never loads in the panel.
fn fetch_account(provider: &str) -> Option<ForgeAccount> {
    match provider {
        "gitlab" => {
            let out = run_bounded("glab", &["api", "user"])?;
            out.status.success().then_some(())?;
            parse_gitlab_user(&String::from_utf8_lossy(&out.stdout))
        }
        ForgeKind::CURSOR_ORIGIN_KEY => crate::git::forge::origin_account(),
        "azure-devops" => {
            let out = run_bounded("az", &["account", "show", "--output", "json"])?;
            out.status.success().then_some(())?;
            parse_azure_account(&String::from_utf8_lossy(&out.stdout))
        }
        // Gitea/Forgejo (`tea`) have no whoami that exposes the username without
        // reading tea's token-bearing config, which we won't do. They fall back
        // to a provider-level "signed in" label. Bitbucket has no CLI.
        _ => None,
    }
}

#[derive(Deserialize)]
struct GitlabUser {
    username: String,
    #[serde(default)]
    name: Option<String>,
}

/// Parse `glab api user` JSON into a `ForgeAccount`. The endpoint returns the
/// GitLab `/user` object; we keep only the username and display name.
fn parse_gitlab_user(json: &str) -> Option<ForgeAccount> {
    let user: GitlabUser = serde_json::from_str(json).ok()?;
    if user.username.is_empty() {
        return None;
    }
    Some(ForgeAccount {
        username: user.username,
        name: user.name.filter(|s| !s.is_empty()),
    })
}

#[derive(Deserialize)]
struct AzAccount {
    user: AzUser,
}
#[derive(Deserialize)]
struct AzUser {
    name: String,
}

/// Parse `az account show` JSON into a `ForgeAccount`. `user.name` is the signed
/// in Azure (AAD) identity — an email / UPN rather than a handle.
fn parse_azure_account(json: &str) -> Option<ForgeAccount> {
    let account: AzAccount = serde_json::from_str(json).ok()?;
    if account.user.name.is_empty() {
        return None;
    }
    Some(ForgeAccount {
        username: account.user.name,
        name: None,
    })
}

/// Build a probe subprocess: no stdin, piped stdout, and the augmented `PATH` a
/// macOS GUI app needs to find a Homebrew CLI. `stderr` is the only axis callers
/// differ on — discarded for a whoami, piped when the caller reports the failure.
fn probe_cmd(cli: &str, args: &[&str], stderr: Stdio) -> Command {
    let mut cmd = Command::new(cli);
    cmd.args(args)
        .env("PATH", crate::shell::path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(stderr);
    crate::shell::hide_console(&mut cmd);
    cmd
}

/// Poll a spawned child until it exits or `deadline` passes; on timeout it is
/// killed and reaped. Returns whether it exited within the budget — callers map
/// a miss onto their own "unverified" value.
fn wait_bounded_child(child: &mut Child, deadline: Instant) -> bool {
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return true,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return false;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(_) => return false,
        }
    }
}

/// Run a CLI bounded by `PROBE_TIMEOUT`, returning its output or `None` on
/// spawn failure / timeout. A whoami can hit the network (`glab api user`), so a
/// slow/offline host must not block the Settings probe forever.
fn run_bounded(cli: &str, args: &[&str]) -> Option<Output> {
    wait_bounded(probe_cmd(cli, args, Stdio::null()))
}

fn run_bounded_with_stderr(cli: &str, args: &[&str]) -> Option<Output> {
    wait_bounded(probe_cmd(cli, args, Stdio::piped()))
}

fn wait_bounded(mut cmd: Command) -> Option<Output> {
    let mut child = cmd.spawn().ok()?;
    wait_bounded_child(&mut child, Instant::now() + PROBE_TIMEOUT).then_some(())?;
    child.wait_with_output().ok()
}

fn probe_cli(cli: &str, args: &[&str], require_output: bool) -> (bool, Option<bool>) {
    let mut child = match probe_cmd(cli, args, Stdio::piped()).spawn() {
        Ok(child) => child,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return (false, None),
        Err(_) => return (true, Some(false)),
    };

    // Poll for completion so a hung CLI can't block the probe indefinitely. A
    // miss means the CLI exists but auth state is unverified — not signed in.
    if !wait_bounded_child(&mut child, Instant::now() + PROBE_TIMEOUT) {
        return (true, Some(false));
    }

    match child.wait_with_output() {
        Ok(output) => {
            // A login *listing* is on stdout; stderr (warnings/notices) must not
            // be read as evidence of an authenticated account.
            let has_listing = !output.stdout.is_empty();
            (
                true,
                Some(output.status.success() && (!require_output || has_listing)),
            )
        }
        Err(_) => (true, Some(false)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sign_out_rejects_a_provider_we_do_not_know() {
        // The provider name crosses IPC, so an unknown one must fail closed
        // rather than reaching a CLI spawn.
        let err = sign_out("not-a-forge").unwrap_err();

        assert!(err.contains("Unsupported provider"), "{err}");
        assert!(err.contains("not-a-forge"), "{err}");
    }

    #[test]
    fn sign_out_reports_providers_that_have_no_cli_sign_out_path() {
        // Every provider without a `cli` or `logout_args` must produce an
        // explanation rather than silently doing nothing.
        for spec in PROVIDERS {
            if spec.cli.is_some() && spec.logout_args.is_some() {
                continue;
            }
            let err = sign_out(spec.provider).unwrap_err();
            assert!(
                err.contains(spec.forge),
                "{}: message should name the forge, got {err}",
                spec.provider
            );
        }
    }

    #[test]
    fn every_provider_that_can_sign_out_names_a_cli() {
        // logout_args without a cli would be unreachable configuration.
        for spec in PROVIDERS {
            if spec.logout_args.is_some() {
                assert!(
                    spec.cli.is_some(),
                    "{} has logout args but no CLI",
                    spec.provider
                );
            }
        }
    }

    #[test]
    fn exposes_auth_only_provider_metadata() {
        let statuses = statuses();
        assert!(statuses.iter().any(|s| s.provider == "bitbucket"));
        assert!(statuses.iter().any(|s| s.provider == "gitlab"));
        assert!(statuses
            .iter()
            .any(|s| s.provider == ForgeKind::CURSOR_ORIGIN_KEY));
        assert!(statuses.iter().all(|s| !s.login_command.is_empty()));
        assert!(statuses.iter().all(|s| !s.docs_url.is_empty()));
    }

    #[test]
    fn gitlab_is_the_only_hostname_scoped_logout() {
        for spec in PROVIDERS {
            assert_eq!(
                spec.logout_needs_hostname,
                spec.provider == "gitlab",
                "{} hostname-scoped logout flag",
                spec.provider
            );
        }
    }

    #[test]
    fn parses_signed_in_hosts_from_glab_status() {
        // Real `glab auth status` shape: host un-indented, details indented.
        let out = "gitlab.com\n  ✓ Logged in to gitlab.com as siomkin (…)\n  ✓ Token found: ***\ngitlab.example.com:8443\n  ✓ Logged in as ada\n";
        assert_eq!(
            parse_status_hosts(out),
            vec![
                "gitlab.com".to_string(),
                "gitlab.example.com:8443".to_string()
            ]
        );
    }

    #[test]
    fn status_host_parsing_ignores_detail_and_prose_lines() {
        // Blank lines, indented detail, and glyph/prose lines are not hosts.
        assert!(parse_status_hosts("\n  ✓ Logged in\n  Not logged in\n").is_empty());
        // De-dupes a host repeated across the listing.
        assert_eq!(
            parse_status_hosts("gitlab.com\n  ✓ x\ngitlab.com\n  ✓ y\n"),
            vec!["gitlab.com".to_string()]
        );
        assert!(looks_like_host("gitlab.com"));
        assert!(looks_like_host("gitlab.example.com:8443"));
        assert!(!looks_like_host("✓ Logged in to gitlab.com"));
        assert!(!looks_like_host(""));
    }

    #[test]
    fn parses_glab_user_into_account() {
        let json = r#"{"id":42,"username":"ada","name":"Ada Lovelace","state":"active"}"#;
        let account = parse_gitlab_user(json).expect("account parsed");
        assert_eq!(account.username, "ada");
        assert_eq!(account.name.as_deref(), Some("Ada Lovelace"));

        // Username-only (no display name) still resolves; empty/garbage does not.
        let minimal = parse_gitlab_user(r#"{"username":"solo"}"#).expect("minimal");
        assert_eq!(minimal.username, "solo");
        assert_eq!(minimal.name, None);
        assert!(parse_gitlab_user(r#"{"username":""}"#).is_none());
        assert!(parse_gitlab_user("not json").is_none());
    }

    #[cfg(unix)]
    #[test]
    fn bounded_wait_kills_a_child_that_outlives_the_deadline() {
        // Well past the deadline: the helper must give up and reap it, not wait 30s.
        let mut slow = probe_cmd("/bin/sleep", &["30"], Stdio::null())
            .spawn()
            .expect("spawn sleep");
        let started = Instant::now();
        assert!(!wait_bounded_child(
            &mut slow,
            started + Duration::from_millis(150)
        ));
        assert!(started.elapsed() < Duration::from_secs(5));
        // Killed and reaped inside the helper, so it is already gone.
        assert!(matches!(slow.try_wait(), Ok(Some(_))));

        // A child that exits inside the budget is reported as a hit.
        let mut quick = probe_cmd("/usr/bin/true", &[], Stdio::null())
            .spawn()
            .expect("spawn true");
        assert!(wait_bounded_child(
            &mut quick,
            Instant::now() + PROBE_TIMEOUT
        ));
    }

    #[test]
    fn parses_az_account_user() {
        let json =
            r#"{"id":"sub-guid","name":"My Sub","user":{"name":"alex@contoso.com","type":"user"}}"#;
        let account = parse_azure_account(json).expect("account parsed");
        assert_eq!(account.username, "alex@contoso.com");
        assert_eq!(account.name, None);

        assert!(parse_azure_account(r#"{"user":{"name":""}}"#).is_none());
        assert!(parse_azure_account(r#"{"id":"x"}"#).is_none());
    }
}
