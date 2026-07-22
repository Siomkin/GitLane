//! Local branch creation, deletion, and tracking writes.

use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, ChildStdout, Stdio};
use std::time::{Duration, Instant};

use super::cli::{finish, git_command, run_git, run_git_allow_exit_codes};
use super::head::ensure_revision_at;
use super::operands::ensure_operand;

/// Disambiguate a bare ref that is *both* a local branch and a tag toward the
/// branch by returning `refs/heads/<name>`; otherwise return `name` unchanged.
///
/// Git's rev resolution gives a **tag** precedence over a same-named branch
/// (`gitrevisions`), so `git merge feature` / `git rebase feature` silently
/// operate on the tag when both exist. Those callers take a branch, so qualify
/// to `refs/heads/` in exactly that ambiguous case — matching how the tag
/// operations already fully-qualify `refs/tags/`. The qualification is skipped
/// when no clashing tag exists, so the ordinary case keeps its clean bare name
/// (and merge keeps its "Merge branch 'feature'" message).
///
/// Reset qualifies in `recovery::preview_reset` only: the preview resolves the
/// name to an oid and the write executes that oid, so applying this to a write
/// operand would turn an exact target back into a movable ref (GL-302).
pub(super) fn qualify_branch_if_ambiguous(repo: &str, name: &str) -> String {
    if ref_exists(repo, &format!("refs/heads/{name}"))
        && ref_exists(repo, &format!("refs/tags/{name}"))
    {
        format!("refs/heads/{name}")
    } else {
        name.to_string()
    }
}

/// Whether `reference` resolves to an existing ref (`git rev-parse --verify
/// --quiet` exits non-zero when it doesn't).
pub(super) fn ref_exists(repo: &str, reference: &str) -> bool {
    run_git(repo, &["rev-parse", "--verify", "--quiet", reference])
        .map(|out| !out.trim().is_empty())
        .unwrap_or(false)
}

/// Resolve a rev to the oid printed by `git rev-parse --verify`. `--verify`
/// exits non-zero for an unresolvable ref, so `run_git` already yields `Err`
/// before we get here; an *empty* success line is therefore a broken invariant,
/// not "no match", and we surface it rather than let two empty strings compare
/// equal and masquerade as an already-up-to-date no-op in `fast_forward_branch`.
pub(super) fn resolve_rev(repo: &str, reference: &str) -> Result<String, String> {
    let oid = run_git(repo, &["rev-parse", "--verify", reference])?
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    if oid.is_empty() {
        return Err(format!("could not resolve {reference}"));
    }
    Ok(oid)
}

/// Create a branch `name` at the validated `start_point`, pinned to the
/// `expected_oid` the user saw. The start point is handed to git as the ref
/// the user picked rather than its resolved oid, so branching from a
/// remote-tracking ref keeps git's automatic upstream setup
/// (`branch.autoSetupMerge`).
pub fn create_branch(
    repo: &str,
    name: &str,
    start_point: &str,
    expected_oid: &str,
) -> Result<String, String> {
    ensure_operand(name)?;
    ensure_revision_at(repo, start_point, expected_oid)?;
    run_git(repo, &["branch", name, start_point])
}

/// A prepared compare-and-swap deletion of one exact local branch ref.
///
/// `git update-ref --stdin` holds the ref lock between `prepare` and `commit`.
/// The combined worktree flow uses that window to prove the previewed tip is
/// still current *before* removing the checkout that owns it. Direct deletion
/// uses the same primitive so it can reject a same-target symbolic ref while
/// the ref is locked, rather than letting `--no-deref` delete a representation
/// the preview did not describe.
pub(super) struct PreparedBranchDeletion {
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

    pub(super) fn commit(self) -> Result<(), String> {
        self.finish("commit\n", "commit: ok")
    }

    pub(super) fn abort(self) -> Result<(), String> {
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

pub(super) fn checked_branch_ref(repo: &str, name: &str) -> Result<String, String> {
    ensure_operand(name)?;
    let branch_ref = format!("refs/heads/{name}");
    // The transaction protocol is line-delimited. Validate the fully-qualified
    // ref before interpolation so control characters and invalid ref syntax can
    // never become a second update-ref command.
    run_git(repo, &["check-ref-format", "--branch", name])?;
    run_git(repo, &["check-ref-format", &branch_ref])?;
    Ok(branch_ref)
}

fn ensure_canonical_object_id(repo: &str, oid: &str) -> Result<(), String> {
    let format = run_git(repo, &["rev-parse", "--show-object-format"])?;
    let length = match format.lines().next().unwrap_or("").trim() {
        "sha1" => 40,
        "sha256" => 64,
        other => return Err(format!("Unsupported Git object format {other:?}.")),
    };
    if oid.len() != length
        || !oid
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(
            "The expected branch oid is not a canonical full object id. Refresh and try again."
                .to_string(),
        );
    }
    // A canonical-looking but nonexistent object is not a preview lease.
    run_git(repo, &["cat-file", "-e", &format!("{oid}^{{object}}")]).map(|_| ())
}

pub(super) fn prepare_branch_deletion(
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

pub(super) fn ensure_branch_ref_is_direct(repo: &str, name: &str) -> Result<(), String> {
    let branch_ref = checked_branch_ref(repo, name)?;
    let symbolic_target =
        run_git_allow_exit_codes(repo, &["symbolic-ref", "--quiet", &branch_ref], &[1])?;
    if symbolic_target.trim().is_empty() {
        Ok(())
    } else {
        Err(format!(
            "{branch_ref} became a symbolic ref. Refresh and preview the deletion again."
        ))
    }
}

pub(super) fn ensure_branch_not_checked_out(repo: &str, name: &str) -> Result<(), String> {
    if let Some(owner) = super::worktrees::worktrees(repo)?
        .into_iter()
        .find(|worktree| worktree.branch.as_deref() == Some(name))
    {
        return Err(format!(
            "Cannot delete branch {name}: it is checked out at {}.",
            owner.path
        ));
    }
    Ok(())
}

fn ensure_branch_merged(repo: &str, name: &str, expected_oid: &str) -> Result<(), String> {
    let branch_ref = format!("refs/heads/{name}");
    let upstream = run_git(
        repo,
        &[
            "for-each-ref",
            "--format=%(upstream)",
            "--count=1",
            &branch_ref,
        ],
    )?;
    let destination = upstream.lines().next().unwrap_or("").trim();
    let destination = if destination.is_empty() {
        "HEAD"
    } else {
        destination
    };
    if run_git(
        repo,
        &["merge-base", "--is-ancestor", expected_oid, destination],
    )
    .is_err()
    {
        return Err(format!(
            "The branch {name} is not fully merged into {destination}. Use force delete to remove it."
        ));
    }
    Ok(())
}

pub(super) fn cleanup_deleted_branch_config(repo: &str, name: &str) -> Result<(), String> {
    ensure_operand(name)?;
    run_git_allow_exit_codes(
        repo,
        &[
            "config",
            "--local",
            "--remove-section",
            &format!("branch.{name}"),
        ],
        &[128],
    )
    .map(|_| ())
}

pub(super) fn deleted_branch_message(repo: &str, name: &str) -> String {
    match cleanup_deleted_branch_config(repo, name) {
        Ok(()) => format!("Deleted {name}"),
        Err(error) => {
            format!("Deleted {name}, but its local branch settings could not be removed: {error}")
        }
    }
}

/// Delete the exact local branch ref the caller previewed. `force=false`
/// preserves `git branch -d`'s merged-safety check; either mode refuses a
/// checked-out branch and uses a prepared compare-and-swap ref transaction.
pub fn delete_branch(
    repo: &str,
    name: &str,
    expected_oid: &str,
    force: bool,
) -> Result<String, String> {
    checked_branch_ref(repo, name)?;
    ensure_canonical_object_id(repo, expected_oid)?;
    if !force {
        ensure_branch_merged(repo, name, expected_oid)?;
    }

    let deletion = prepare_branch_deletion(repo, name, expected_oid)?;
    ensure_branch_ref_is_direct(repo, name)?;
    ensure_branch_not_checked_out(repo, name)?;
    deletion.commit()?;
    // The ref commit is authoritative. Config cleanup is a secondary hygiene
    // step and must not turn a completed destructive mutation into a reported
    // total failure; preserve the success while surfacing a qualified warning.
    Ok(deleted_branch_message(repo, name))
}

/// Rename a branch.
///
/// `-m` (not `-M`) is deliberate: the lowercase form refuses to overwrite an
/// existing branch at `new`, so a rename can never silently clobber another
/// branch's ref. `-M` would force that overwrite — a data-loss risk we don't
/// want behind a plain rename. Callers that need to reuse a name must delete the
/// target branch first.
pub fn rename_branch(repo: &str, old: &str, new: &str) -> Result<String, String> {
    ensure_operand(old)?;
    ensure_operand(new)?;
    run_git(repo, &["branch", "-m", old, new])
}

/// Set the upstream tracking ref for `branch` (`git branch --set-upstream-to`).
/// `upstream` is a remote-tracking ref like `origin/main`; it must already exist.
pub fn set_upstream(repo: &str, branch: &str, upstream: &str) -> Result<String, String> {
    ensure_operand(branch)?;
    ensure_operand(upstream)?;
    let arg = format!("--set-upstream-to={upstream}");
    run_git(repo, &["branch", &arg, branch])
}
