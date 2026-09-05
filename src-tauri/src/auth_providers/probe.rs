use std::process::{Child, Command, Output, Stdio};
use std::time::{Duration, Instant};

/// Upper bound on a single auth probe. Some CLIs (`glab auth status`) validate
/// the token against the remote API and can hang on a slow/offline network; a
/// timed-out probe is reported as "CLI present, auth unverified" rather than
/// blocking the Settings panel forever.
pub(super) const PROBE_TIMEOUT: Duration = Duration::from_secs(4);

/// Build a probe subprocess: no stdin, piped stdout, and the augmented `PATH` a
/// macOS GUI app needs to find a Homebrew CLI. `stderr` is the only axis callers
/// differ on — discarded for a whoami, piped when the caller reports the failure.
pub(super) fn probe_cmd(cli: &str, args: &[&str], stderr: Stdio) -> Command {
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
pub(super) fn wait_bounded_child(child: &mut Child, deadline: Instant) -> bool {
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
pub(super) fn run_bounded(cli: &str, args: &[&str]) -> Option<Output> {
    wait_bounded(probe_cmd(cli, args, Stdio::null()))
}

pub(super) fn run_bounded_with_stderr(cli: &str, args: &[&str]) -> Option<Output> {
    wait_bounded(probe_cmd(cli, args, Stdio::piped()))
}

fn wait_bounded(mut cmd: Command) -> Option<Output> {
    let mut child = cmd.spawn().ok()?;
    wait_bounded_child(&mut child, Instant::now() + PROBE_TIMEOUT).then_some(())?;
    child.wait_with_output().ok()
}

pub(super) fn probe_cli(cli: &str, args: &[&str], require_output: bool) -> (bool, Option<bool>) {
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
