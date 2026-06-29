//! Auth-only status probes for non-GitHub forge providers.
//!
//! These probes deliberately do not read, store, or return tokens. They only
//! report whether a local CLI/auth path appears usable so Settings can guide
//! users before real provider-specific PR integrations exist.

use std::collections::HashMap;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::git::types::ForgeAuthStatus;

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
        docs_url: "https://gitlab.com/gitlab-org/cli",
        notes: "Auth status only. Pull-request features are not implemented for GitLab.",
        require_output: false,
    },
    ProviderSpec {
        provider: "bitbucket",
        forge: "Bitbucket",
        cli: None,
        status_args: &[],
        auth_method: "API token or git credential helper",
        login_command: "Create a Bitbucket API token and let git store it through your credential helper.",
        // Atlassian deprecated Bitbucket app passwords; the app-passwords doc now
        // redirects here, and API tokens are the supported replacement.
        docs_url: "https://support.atlassian.com/bitbucket-cloud/docs/api-tokens/",
        notes: "Bitbucket has no bundled CLI probe in GitLane yet. Auth metadata only; PR features are not implemented.",
        require_output: false,
    },
    ProviderSpec {
        provider: "azure-devops",
        forge: "Azure DevOps",
        cli: Some("az"),
        status_args: &["account", "show", "--output", "none"],
        auth_method: "Azure CLI",
        login_command: "az login && az devops login",
        // The connect path's first step is installing `az`, so point at the
        // Azure CLI install guide rather than the Azure DevOps CLI extension docs.
        // Locale-less URL — Learn redirects to the visitor's locale.
        docs_url: "https://learn.microsoft.com/cli/azure/install-azure-cli?view=azure-cli-latest",
        notes: "Uses Azure CLI sign-in as the auth signal. Azure DevOps PR features are not implemented.",
        require_output: false,
    },
    ProviderSpec {
        provider: "gitea",
        forge: "Gitea",
        cli: Some("tea"),
        status_args: &["login", "list"],
        auth_method: "tea CLI",
        login_command: "tea login add",
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
    }
}

fn probe_cli(cli: &str, args: &[&str], require_output: bool) -> (bool, Option<bool>) {
    let mut cmd = Command::new(cli);
    cmd.args(args)
        .env("PATH", crate::shell::path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return (false, None),
        Err(_) => return (true, Some(false)),
    };

    // Poll for completion so a hung CLI can't block the probe indefinitely.
    let deadline = Instant::now() + PROBE_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    // CLI exists but auth state is unverified — treat as not signed in.
                    return (true, Some(false));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(_) => return (true, Some(false)),
        }
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
    fn exposes_auth_only_provider_metadata() {
        let statuses = statuses();
        assert!(statuses.iter().any(|s| s.provider == "bitbucket"));
        assert!(statuses.iter().any(|s| s.provider == "gitlab"));
        assert!(statuses.iter().all(|s| !s.login_command.is_empty()));
        assert!(statuses.iter().all(|s| !s.docs_url.is_empty()));
    }
}
