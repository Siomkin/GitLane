//! The prepared compare-and-swap deletion of one exact local branch ref,
//! driven over `git update-ref --stdin` so the ref lock is held between
//! `prepare` and `commit`.

use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, ChildStdout, Stdio};
use std::time::{Duration, Instant};

use super::super::cli::{finish, git_command};
use super::refs::{checked_branch_ref, ensure_canonical_object_id};

/// A prepared compare-and-swap deletion of one exact local branch ref.
///
/// `git update-ref --stdin` holds the ref lock between `prepare` and `commit`.
/// The combined worktree flow uses that window to prove the previewed tip is
/// still current *before* removing the checkout that owns it. Direct deletion
/// uses the same primitive so it can reject a same-target symbolic ref while
/// the ref is locked, rather than letting `--no-deref` delete a representation
/// the preview did not describe.
pub(in crate::git::write) struct PreparedBranchDeletion {
    child: Child,
    input: Option<ChildStdin>,
    output: BufReader<ChildStdout>,
    finished: bool,
}

impl PreparedBranchDeletion {
    fn send(&mut self, command: &str) -> Result<(), String> {
        let input = self
            .input
            .as_mut()
            .ok_or_else(|| "The branch deletion transaction is already closed.".to_string())?;
        input
            .write_all(command.as_bytes())
            .and_then(|_| input.flush())
            .map_err(|error| format!("Could not write the branch deletion transaction: {error}"))
    }

    fn expect(&mut self, expected: &str) -> Result<(), String> {
        let mut line = String::new();
        match self.output.read_line(&mut line) {
            Ok(0) => Err(self.closed_early(expected)),
            Ok(_) if line.trim_end() == expected => Ok(()),
            Ok(_) => Err(format!(
                "Git returned an unexpected branch deletion response: {}",
                line.trim_end()
            )),
            Err(error) => Err(format!(
                "Could not read the branch deletion transaction: {error}"
            )),
        }
    }

    fn closed_early(&mut self, expected: &str) -> String {
        self.input.take();
        let status = self.child.wait();
        let mut stderr = String::new();
        if let Some(mut pipe) = self.child.stderr.take() {
            let _ = pipe.read_to_string(&mut stderr);
        }
        self.finished = true;
        let detail = crate::redact::redact_secrets(stderr.trim());
        if detail.is_empty() {
            match status {
                Ok(status) => format!(
                    "Git closed the branch deletion transaction before {expected} ({status})."
                ),
                Err(error) => {
                    format!("Git closed the branch deletion transaction before {expected}: {error}")
                }
            }
        } else {
            detail
        }
    }

    fn finish(mut self, command: &'static str, response: &'static str) -> Result<(), String> {
        self.send(command)?;
        self.expect(response)?;
        self.input.take();

        let mut stdout = String::new();
        self.output.read_to_string(&mut stdout).map_err(|error| {
            format!("Could not finish the branch deletion transaction: {error}")
        })?;
        let mut stderr = String::new();
        if let Some(mut pipe) = self.child.stderr.take() {
            pipe.read_to_string(&mut stderr)
                .map_err(|error| format!("Could not read Git's branch deletion error: {error}"))?;
        }
        let status = self.child.wait().map_err(|error| {
            format!("Could not wait for the branch deletion transaction: {error}")
        })?;
        self.finished = true;
        finish(status, &stdout, &stderr, &["update-ref", "--stdin"]).map(|_| ())
    }

    pub(in crate::git::write) fn commit(self) -> Result<(), String> {
        self.finish("commit\n", "commit: ok")
    }

    pub(in crate::git::write) fn abort(self) -> Result<(), String> {
        self.finish("abort\n", "abort: ok")
    }
}

impl Drop for PreparedBranchDeletion {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        if let Some(mut input) = self.input.take() {
            let _ = input.write_all(b"abort\n");
            let _ = input.flush();
        }
        // Closing stdin lets update-ref consume the abort and remove its lock.
        // Give that graceful path a bounded window before killing a genuinely
        // stuck child; an immediate SIGKILL can win before Git unlinks the ref
        // lock it acquired during `prepare`.
        let deadline = Instant::now() + Duration::from_millis(250);
        loop {
            match self.child.try_wait() {
                Ok(Some(_)) => {
                    self.finished = true;
                    return;
                }
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(5));
                }
                Ok(None) | Err(_) => break,
            }
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
        self.finished = true;
    }
}

pub(in crate::git::write) fn prepare_branch_deletion(
    repo: &str,
    name: &str,
    expected_oid: &str,
) -> Result<PreparedBranchDeletion, String> {
    let branch_ref = checked_branch_ref(repo, name)?;
    ensure_canonical_object_id(repo, expected_oid)?;

    let mut command = git_command(repo)?;
    command
        .args([
            "update-ref",
            "-m",
            "delete branch with exact tip",
            "--stdin",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| format!("Could not start the branch deletion transaction: {error}"))?;
    let input = child
        .stdin
        .take()
        .ok_or_else(|| "Git did not open the branch deletion transaction input.".to_string())?;
    let output = child
        .stdout
        .take()
        .ok_or_else(|| "Git did not open the branch deletion transaction output.".to_string())?;
    let mut transaction = PreparedBranchDeletion {
        child,
        input: Some(input),
        output: BufReader::new(output),
        finished: false,
    };
    transaction.send("start\n")?;
    transaction.expect("start: ok")?;
    // In update-ref's stdin protocol `option no-deref` applies to the next ref
    // command only. Keep it adjacent to `delete`; a command-line `--no-deref`
    // does not express that per-command guarantee on every supported Git.
    transaction.send(&format!(
        "option no-deref\ndelete {branch_ref} {expected_oid}\nprepare\n"
    ))?;
    transaction.expect("prepare: ok")?;
    Ok(transaction)
}
