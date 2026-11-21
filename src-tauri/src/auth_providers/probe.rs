use std::process::Command;
use std::time::Duration;

use crate::git::forge::{BoundedOutput, CaptureError, capture_probe, probe_glab, probe_origin};

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

/// Run a CLI bounded by `PROBE_TIMEOUT`, returning its output or the capture
/// failure (spawn error, timeout) so a caller can say which. A whoami can hit
/// the network (`glab api user`), so a slow/offline host must not block the
/// Settings probe forever. Both streams are drained concurrently, so a chatty
/// CLI cannot stall on a full pipe.
pub(super) fn run_bounded(cli: &str, args: &[&str]) -> Result<BoundedOutput, CaptureError> {
    run_probe(cli, args)
}

/// What an auth probe found. The two `ForgeAuthStatus` fields it feeds,
/// `available` and `authenticated`, are derived from it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum CliProbe {
    /// The CLI is not installed.
    Missing,
    /// The CLI exists, but the probe timed out or could not be captured, so
    /// auth state is unverified. It reports the same as [`Self::SignedOut`];
    /// it is kept apart so the code names why the account reads as signed out.
    Unverified,
    SignedIn,
    SignedOut,
}

impl CliProbe {
    pub(super) fn available(self) -> bool {
        self != Self::Missing
    }

    pub(super) fn authenticated(self) -> Option<bool> {
        match self {
            Self::Missing => None,
            Self::SignedIn => Some(true),
            Self::Unverified | Self::SignedOut => Some(false),
        }
    }

    /// A probe that could not run: a missing binary, or a timeout or capture
    /// failure of one that exists.
    fn from_error(error: &CaptureError) -> Self {
        match error {
            CaptureError::Spawn(e) if e.kind() == std::io::ErrorKind::NotFound => Self::Missing,
            _ => Self::Unverified,
        }
    }

    /// A probe that ran. A login *listing* is on stdout; stderr
    /// (warnings/notices) must not be read as evidence of an authenticated
    /// account.
    fn from_exit(success: bool, stdout: &[u8], require_output: bool) -> Self {
        if success && (!require_output || !stdout.is_empty()) {
            Self::SignedIn
        } else {
            Self::SignedOut
        }
    }
}

pub(super) fn probe_cli(cli: &str, args: &[&str], require_output: bool) -> CliProbe {
    match run_probe(cli, args) {
        Err(error) => CliProbe::from_error(&error),
        Ok(output) => CliProbe::from_exit(output.status.success(), &output.stdout, require_output),
    }
}

#[cfg(test)]
mod tests {
    use super::{CaptureError, CliProbe};
    use std::io::{Error, ErrorKind};

    #[test]
    fn each_probe_outcome_maps_to_the_status_fields_it_always_had() {
        for (probe, available, authenticated) in [
            (CliProbe::Missing, false, None),
            (CliProbe::Unverified, true, Some(false)),
            (CliProbe::SignedIn, true, Some(true)),
            (CliProbe::SignedOut, true, Some(false)),
        ] {
            assert_eq!(probe.available(), available, "{probe:?}");
            assert_eq!(probe.authenticated(), authenticated, "{probe:?}");
        }
    }

    #[test]
    fn a_probe_that_could_not_run_is_missing_only_when_the_binary_is() {
        let missing = CaptureError::Spawn(Error::from(ErrorKind::NotFound));
        let denied = CaptureError::Spawn(Error::from(ErrorKind::PermissionDenied));
        assert_eq!(CliProbe::from_error(&missing), CliProbe::Missing);
        assert_eq!(CliProbe::from_error(&denied), CliProbe::Unverified);
    }

    #[test]
    fn a_probe_that_ran_is_signed_in_only_on_success_with_any_required_listing() {
        for (success, stdout, require_output, expected) in [
            (true, &b""[..], false, CliProbe::SignedIn),
            (true, &b"user@host"[..], true, CliProbe::SignedIn),
            (true, &b""[..], true, CliProbe::SignedOut),
            (false, &b"user@host"[..], false, CliProbe::SignedOut),
            (false, &b"user@host"[..], true, CliProbe::SignedOut),
        ] {
            assert_eq!(
                CliProbe::from_exit(success, stdout, require_output),
                expected,
                "success={success} stdout={stdout:?} require_output={require_output}"
            );
        }
    }
}
