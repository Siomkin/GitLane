//! Running a child under a deadline: the watchdog that kills it, the reap that
//! collects it, and [`output_within`] for one-shot commands built on both.

use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Run `cmd` in its own process group under a watchdog and reap, keeping at
/// most `max_stdout` bytes. `None` when it could not start, failed, overflowed,
/// or outlived `timeout` — a hung child must not hold a blocking-pool thread.
pub(crate) fn output_within(
    mut cmd: Command,
    timeout: Duration,
    max_stdout: usize,
) -> Option<Vec<u8>> {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut cmd, 0);
    let mut child = cmd.spawn().ok()?;
    let stdout = child.stdout.take()?;
    let child = Arc::new(Mutex::new(child));
    let finished = Arc::new(AtomicBool::new(false));
    watchdog(Arc::clone(&child), Arc::clone(&finished), timeout);
    let mut bytes = Vec::new();
    let read = stdout.take(max_stdout as u64 + 1).read_to_end(&mut bytes);
    let status = if read.is_err() || bytes.len() > max_stdout {
        None
    } else {
        // stdout closed, so the command is exiting (or the watchdog killed it).
        // Poll instead of blocking in `wait` while holding the lock, so one that
        // closed stdout and then hung is still the watchdog's to kill.
        loop {
            match child.lock().ok().map(|mut child| child.try_wait()) {
                Some(Ok(Some(status))) => break Some(status),
                Some(Ok(None)) => std::thread::sleep(Duration::from_millis(20)),
                _ => break None,
            }
        }
    };
    finished.store(true, Ordering::Relaxed);
    reap(&child);
    status.filter(|status| status.success()).map(|_| bytes)
}

/// Kill the child if it outlives `timeout`. Killing it closes stdout, which
/// ends the caller's read loop — no separate cancellation path needed.
pub(crate) fn watchdog(child: Arc<Mutex<Child>>, finished: Arc<AtomicBool>, timeout: Duration) {
    std::thread::spawn(move || {
        let tick = Duration::from_millis(250);
        let mut waited = Duration::ZERO;
        while waited < timeout {
            if finished.load(Ordering::Relaxed) {
                return;
            }
            std::thread::sleep(tick);
            waited += tick;
        }
        if !finished.load(Ordering::Relaxed) {
            reap(&child);
        }
    });
}

/// Stop the child and collect it, so it never leaves a zombie or a stray
/// grandchild behind.
pub(crate) fn reap(child: &Arc<Mutex<Child>>) {
    if let Ok(mut child) = child.lock() {
        kill_group(child.id());
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// Signal the child's whole process group (callers spawn with
/// `process_group(0)`). `Child::kill` only reaches the launcher, which on
/// `npx`-based adapters is not the agent.
#[cfg(unix)]
fn kill_group(pid: u32) {
    // ponytail: shells out to `kill` rather than taking a `libc` dependency for
    // one `killpg`. Swap it for `libc::killpg` if this tree ever needs libc.
    let mut kill = Command::new("kill");
    kill.arg("-TERM").arg(format!("-{pid}"));
    super::hide_console(&mut kill);
    let _ = kill.stderr(Stdio::null()).status();
}

#[cfg(not(unix))]
fn kill_group(_pid: u32) {
    // Windows has no process groups here — `Child::kill` on the launcher is all
    // this does, matching the behaviour before process groups existed.
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    #[test]
    fn a_hanging_command_is_killed_at_its_timeout() {
        let mut cmd = std::process::Command::new("sh");
        cmd.args(["-c", "echo partial; sleep 30"]);
        let started = std::time::Instant::now();
        let out = super::output_within(cmd, std::time::Duration::from_millis(300), 1024);
        assert_eq!(out, None);
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
    }

    #[cfg(unix)]
    #[test]
    fn a_command_that_finishes_returns_its_stdout() {
        let mut cmd = std::process::Command::new("sh");
        cmd.args(["-c", "echo ok"]);
        let out = super::output_within(cmd, std::time::Duration::from_secs(5), 1024);
        assert_eq!(out.as_deref(), Some(&b"ok\n"[..]));
    }
}
