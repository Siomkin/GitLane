use std::process::Command;
use std::time::Duration;

use crate::git::forge::{capture_probe, probe_glab, probe_origin, BoundedOutput, CaptureError};

/// Upper bound on a single auth probe. Some CLIs (`glab auth status`) validate
/// the token against the remote API and can hang on a slow/offline network; a
/// timed-out probe is reported as "CLI present, auth unverified" rather than
/// blocking the Settings panel forever.
pub(super) const PROBE_TIMEOUT: Duration = Duration::from_secs(4);

/// The CLIs whose subprocess is built at their own forge boundary (`glab` in
/// `git/forge/gitlab/transport.rs`, `origin` in `git/forge/origin/command.rs`),
/// so the probes share that site's environment scrubbing. Everything else
/// (`az`, `tea`) is built here.
pub(super) const BOUNDARY_CLIS: &[&str] = &["glab", "origin"];

/// Build a probe subprocess for a CLI with no forge boundary of its own: the
/// augmented `PATH` a macOS GUI app needs to find a Homebrew CLI. Stdio is set
/// by the bounded capture.
pub(super) fn probe_cmd(cli: &str, args: &[&str]) -> Command {
    debug_assert!(
        !BOUNDARY_CLIS.contains(&cli),
        "{cli} has its own subprocess site"
    );
    let mut cmd = Command::new(cli);
    cmd.args(args).env("PATH", crate::shell::path());
    crate::shell::hide_console(&mut cmd);
    cmd
}

/// Run a CLI probe bounded by `PROBE_TIMEOUT` and the provider output limits,
/// through the CLI's own subprocess site when it has one.
fn run_probe(cli: &str, args: &[&str]) -> Result<BoundedOutput, CaptureError> {
    match cli {
        "glab" => probe_glab(args, PROBE_TIMEOUT),
        "origin" => probe_origin(args, PROBE_TIMEOUT),
        _ => capture_probe(&mut probe_cmd(cli, args), PROBE_TIMEOUT),
    }
}

/// Run a CLI bounded by `PROBE_TIMEOUT`, returning its output or `None` on
/// spawn failure / timeout. A whoami can hit the network (`glab api user`), so a
/// slow/offline host must not block the Settings probe forever. Both streams
/// are drained concurrently, so a chatty CLI cannot stall on a full pipe.
pub(super) fn run_bounded(cli: &str, args: &[&str]) -> Option<BoundedOutput> {
    run_probe(cli, args).ok()
}

pub(super) fn probe_cli(cli: &str, args: &[&str], require_output: bool) -> (bool, Option<bool>) {
    match run_probe(cli, args) {
        Err(CaptureError::Spawn(e)) if e.kind() == std::io::ErrorKind::NotFound => (false, None),
        // A timeout or capture failure means the CLI exists but auth state is
        // unverified — not signed in.
        Err(_) => (true, Some(false)),
        // A login *listing* is on stdout; stderr (warnings/notices) must not be
        // read as evidence of an authenticated account.
        Ok(output) => (
            true,
            Some(output.status.success() && (!require_output || !output.stdout.is_empty())),
        ),
    }
}
