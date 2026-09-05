use super::probe::run_bounded_with_stderr;
use super::spec::{ProviderSpec, PROVIDERS};

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

pub(super) fn parse_status_hosts(text: &str) -> Vec<String> {
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
pub(super) fn looks_like_host(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 253
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':'))
}
