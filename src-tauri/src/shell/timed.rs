//! Running a child under a deadline: the watchdog that kills it, the reap that
//! collects it, and [`output_within`] for one-shot commands built on both.

use std::io::Read;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// A child that is stopped and collected exactly once: [`reap`] takes it out,
/// so every later reap of the same slot (a Stop, the watchdog, the normal end)
/// finds it empty and signals nothing.
pub(crate) type ChildSlot = Arc<Mutex<Option<Child>>>;

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
    let child: ChildSlot = Arc::new(Mutex::new(Some(child)));
    let finished = Arc::new(AtomicBool::new(false));
    watchdog(Arc::clone(&child), Arc::clone(&finished), timeout);
    let mut bytes = Vec::new();
    let read = stdout.take(max_stdout as u64 + 1).read_to_end(&mut bytes);
    let exited = if read.is_err() || bytes.len() > max_stdout {
        false
    } else {
        // stdout closed, so the command is exiting (or the watchdog killed it).
        // Poll instead of blocking in `wait` while holding the lock, so one that
        // closed stdout and then hung is still the watchdog's to kill. An empty
        // slot means the watchdog already reaped it.
        loop {
            match child.lock().ok().map(|mut c| c.as_mut().map(has_exited)) {
                Some(Some(Ok(true))) => break true,
                Some(Some(Ok(false))) => std::thread::sleep(Duration::from_millis(20)),
                _ => break false,
            }
        }
    };
    finished.store(true, Ordering::Relaxed);
    let status = reap(&child);
    status
        .filter(|status| exited && status.success())
        .map(|_| bytes)
}

/// Kill the child if it outlives `timeout`. Killing it closes stdout, which
/// ends the caller's read loop — no separate cancellation path needed.
pub(crate) fn watchdog(child: ChildSlot, finished: Arc<AtomicBool>, timeout: Duration) {
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
/// grandchild behind. Returns its exit status; `None` when the slot was
/// already reaped, which then signals nothing.
pub(crate) fn reap(child: &ChildSlot) -> Option<ExitStatus> {
    let mut child = child
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take()?;
    kill_group(child.id());
    let _ = child.kill();
    child.wait().ok()
}

/// Whether the child has exited, without collecting it: the leader must stay
/// unreaped until [`reap`] has signalled its group.
#[cfg(unix)]
fn has_exited(child: &mut Child) -> std::io::Result<bool> {
    // SAFETY: an all-zero `siginfo_t` is a valid out-parameter, and `WNOWAIT`
    // leaves the child waitable, so nothing is collected here.
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    let flags = libc::WEXITED | libc::WNOHANG | libc::WNOWAIT;
    if unsafe { libc::waitid(libc::P_PID, child.id(), &mut info, flags) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    // With `WNOHANG` and nothing to report, `si_pid` stays zero.
    // SAFETY: `waitid` succeeded, so `info` holds a child-status record.
    Ok(unsafe { info.si_pid() } != 0)
}

#[cfg(not(unix))]
fn has_exited(child: &mut Child) -> std::io::Result<bool> {
    // No process groups here (see `kill_group`), so collecting it now is fine.
    child.try_wait().map(|status| status.is_some())
}

/// Signal the child's whole process group (callers spawn with
/// `process_group(0)`). `Child::kill` only reaches the launcher, which on
/// `npx`-based adapters is not the agent.
///
/// A direct `killpg`, never the `kill` binary: on the hosted Ubuntu runner
/// `kill -TERM -<pgid>` issued `kill(-1, SIGTERM)` — every process the user
/// owns, the CI runner included.
#[cfg(unix)]
fn kill_group(pid: u32) {
    let Ok(pgid) = libc::pid_t::try_from(pid) else {
        return;
    };
    // SAFETY: a plain syscall with no memory arguments. Only `reap` collects
    // the leader, and it signals first, so the unreaped leader still pins
    // `pgid` — it cannot have been reused.
    unsafe { libc::killpg(pgid, libc::SIGTERM) };
}

#[cfg(not(unix))]
fn kill_group(_pid: u32) {
    // Windows has no process groups here — `Child::kill` on the launcher is all
    // this does, matching the behaviour before process groups existed.
}

#[cfg(test)]
mod tests;
