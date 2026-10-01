use std::collections::HashMap;

use serde::Deserialize;

use super::probe::{probe_cli, run_bounded};
use super::spec::{ProviderSpec, PROVIDERS};
use crate::git::forge::ForgeKind;
use crate::git::types::{ForgeAccount, ForgeAuthStatus};

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
/// Best-effort and provider-specific (GitLab, Cursor Origin and Azure today);
/// `None` means we can't resolve it, and the UI falls back to a provider-level
/// "signed in" label. This is the slow, network-touching part — kept out of
/// `statuses()`, and bounded by `PROBE_TIMEOUT` like every probe.
pub fn account(provider: &str) -> Option<ForgeAccount> {
    fetch_account(provider)
}

// NOTE: the set of providers handled here must stay in sync with
// `FORGE_WHOAMI_PROVIDERS` in `src/lib/forgeHelp.ts`, which decides which providers the UI resolves an
// identity for. Adding a case here without updating that set means the identity
// never loads in the panel.
fn fetch_account(provider: &str) -> Option<ForgeAccount> {
    match provider {
        "gitlab" => {
            let out = run_bounded("glab", &["api", "user"]).ok()?;
            out.status.success().then_some(())?;
            gitlab_account(&String::from_utf8_lossy(&out.stdout))
        }
        // The Origin CLI does not run on native Windows; never spawn it there.
        ForgeKind::CURSOR_ORIGIN_KEY if cfg!(windows) => None,
        ForgeKind::CURSOR_ORIGIN_KEY => {
            let out = run_bounded("origin", &["auth", "status"]).ok()?;
            out.status.success().then_some(())?;
            crate::git::forge::parse_origin_auth_status(&String::from_utf8_lossy(&out.stdout))
        }
        "azure-devops" => {
            let out = run_bounded("az", &["account", "show", "--output", "json"]).ok()?;
            out.status.success().then_some(())?;
            parse_azure_account(&String::from_utf8_lossy(&out.stdout))
        }
        // Gitea/Forgejo (`tea`) have no whoami that exposes the username without
        // reading tea's token-bearing config, which we won't do. They fall back
        // to a provider-level "signed in" label. Bitbucket has no CLI.
        _ => None,
    }
}

/// `glab api user` JSON (GitLab's `/user` object) as a `ForgeAccount`, parsed
/// by the same parser the native OAuth whoami uses.
pub(super) fn gitlab_account(json: &str) -> Option<ForgeAccount> {
    let user = crate::git::oauth::identity::parse_gitlab_user(json).ok()?;
    Some(ForgeAccount {
        username: user.login,
        name: user.name,
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
pub(super) fn parse_azure_account(json: &str) -> Option<ForgeAccount> {
    let account: AzAccount = serde_json::from_str(json).ok()?;
    if account.user.name.is_empty() {
        return None;
    }
    Some(ForgeAccount {
        username: account.user.name,
        name: None,
    })
}
