//! Branch, tag, patch, sequencer, and reset operations.

use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Stdio};
use std::time::{Duration, Instant};

use super::cli::{
    finish, git_command, run_git, run_git_allow_exit_codes, run_git_env_stable_diagnostics,
    run_git_with_input,
};
use super::head::{
    checkout_expected_branch, current_branch, ensure_commit_exists, ensure_expected_branch_tip,
    ensure_expected_head, ensure_revision_at, switch_branch, switch_detached,
};
use super::operands::{ensure_operand, ensure_opt};

/// Switch to an existing local branch or detach at an explicit revision.
/// `detached` is part of the IPC intent: one-argument `git checkout <target>` is
/// deliberately forbidden because a stale branch can be reinterpreted as a
/// pathspec and silently restore a same-named tracked file.
pub fn checkout(repo: &str, target: &str, detached: bool) -> Result<String, String> {
    if detached {
        switch_detached(repo, target)
    } else {
        switch_branch(repo, target)
    }
}

/// Check out the local counterpart of an existing remote-tracking ref. Create
/// it with tracking when missing; when it already exists, check it out and
/// fast-forward it to the remote tip. Patch-equivalent sibling commits (same
/// parents and tree) are aligned atomically; all other divergence is refused.
/// Active merge/sequencer operations are rejected before checkout can disturb
/// their state.
pub fn checkout_remote_branch(repo: &str, remote: &str, branch: &str) -> Result<String, String> {
    ensure_operand(remote)?;
    ensure_operand(branch)?;
    ensure_no_operation_in_progress(repo)?;
    let remote_ref = format!("refs/remotes/{remote}/{branch}");
    let local_ref = format!("refs/heads/{branch}");
    if ref_exists(repo, &local_ref) {
        // Keep the first classification as a no-switch preflight: genuine
        // divergence must not change HEAD. Reclassify after checkout because
        // either ref may move while the subprocess runs.
        classify_remote_checkout(repo, &local_ref, &remote_ref)?;
        switch_branch(repo, branch)?;
        match classify_remote_checkout(repo, &local_ref, &remote_ref).map_err(|error| {
            format!(
                "{branch} is checked out, but it couldn't be updated to {remote_ref}: {error}"
            )
        })? {
            RemoteCheckoutUpdate::FastForward => {
                let local_oid = resolve_rev(repo, &local_ref)?;
                let target_oid = resolve_rev(repo, &remote_ref)?;
                fast_forward_branch_at(repo, branch, &local_oid, &target_oid).map_err(|error| {
                    format!(
                        "{branch} is checked out, but it couldn't be fast-forwarded to {remote_ref}: {error}"
                    )
                })
            }
            RemoteCheckoutUpdate::AlignEquivalentSibling {
                local_oid,
                target_oid,
            } => align_equivalent_sibling(
                repo,
                &local_ref,
                &remote_ref,
                &local_oid,
                &target_oid,
            )
            .map_err(|error| {
                    format!(
                        "{branch} is checked out, but it couldn't be aligned to {remote_ref}: {error}"
                    )
                }),
        }
    } else {
        run_git(
            repo,
            &["switch", "--track", "-c", branch, "--", &remote_ref],
        )
    }
}

fn ensure_no_operation_in_progress(repo: &str) -> Result<(), String> {
    let status = crate::git::conflicts::operation_status(repo)
        .map_err(|error| format!("Cannot inspect the repository operation state: {error}"))?;
    let active = if status.kind != "none" {
        Some(status.kind.as_str())
    } else if !status.advisory.is_empty() {
        Some(status.advisory.as_str())
    } else {
        None
    };
    if let Some(kind) = active {
        return Err(format!(
            "Cannot check out a remote branch while a {kind} operation is in progress. Finish or abort it first."
        ));
    }
    Ok(())
}

enum RemoteCheckoutUpdate {
    FastForward,
    AlignEquivalentSibling {
        local_oid: String,
        target_oid: String,
    },
}

/// Disambiguate a bare ref that is *both* a local branch and a tag toward the
/// branch by returning `refs/heads/<name>`; otherwise return `name` unchanged.
///
/// Git's rev resolution gives a **tag** precedence over a same-named branch
/// (`gitrevisions`), so `git merge feature` / `git rebase feature` / `git reset
/// feature` silently operate on the tag when both exist. Those callers take a
/// branch, so qualify to `refs/heads/` in exactly that ambiguous case — matching
/// how the tag operations already fully-qualify `refs/tags/`. The qualification
/// is skipped when no clashing tag exists, so the ordinary case keeps its clean
/// bare name (and merge keeps its "Merge branch 'feature'" message). Shared with
/// `recovery::preview_reset` so the preview and the write agree on the ref.
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
fn ref_exists(repo: &str, reference: &str) -> bool {
    run_git(repo, &["rev-parse", "--verify", "--quiet", reference])
        .map(|out| !out.trim().is_empty())
        .unwrap_or(false)
}

/// Resolve a rev to the oid printed by `git rev-parse --verify`. `--verify`
/// exits non-zero for an unresolvable ref, so `run_git` already yields `Err`
/// before we get here; an *empty* success line is therefore a broken invariant,
/// not "no match", and we surface it rather than let two empty strings compare
/// equal and masquerade as an already-up-to-date no-op in `fast_forward_branch`.
fn resolve_rev(repo: &str, reference: &str) -> Result<String, String> {
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

/// Classify the safe updates before checkout changes HEAD. Besides ordinary
/// ancestry, two sibling commits with the same parents and tree are equivalent:
/// GitHub squash-merging a one-commit branch commonly rewrites only its commit
/// message and metadata. All other divergence remains a hard stop.
fn classify_remote_checkout(
    repo: &str,
    local_ref: &str,
    target: &str,
) -> Result<RemoteCheckoutUpdate, String> {
    let local_oid = resolve_rev(repo, local_ref)?;
    let target_oid = resolve_rev(repo, target)?;
    if local_oid == target_oid {
        return Ok(RemoteCheckoutUpdate::FastForward);
    }
    let merge_base = run_git(repo, &["merge-base", local_ref, target])?
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    // Either ancestry direction is safe for checkout: local-behind moves
    // forward, while local-ahead makes `merge --ff-only` an up-to-date no-op.
    if merge_base == local_oid || merge_base == target_oid {
        return Ok(RemoteCheckoutUpdate::FastForward);
    }

    let local_parents = commit_parents(repo, &local_oid)?;
    let target_parents = commit_parents(repo, &target_oid)?;
    let local_tree = resolve_rev(repo, &format!("{local_oid}^{{tree}}"))?;
    let target_tree = resolve_rev(repo, &format!("{target_oid}^{{tree}}"))?;
    if local_parents == target_parents && local_tree == target_tree {
        return Ok(RemoteCheckoutUpdate::AlignEquivalentSibling {
            local_oid,
            target_oid,
        });
    }

    Err(format!(
        "Cannot update {local_ref} from {target}: the local and remote branches have diverged."
    ))
}

fn commit_parents(repo: &str, oid: &str) -> Result<Vec<String>, String> {
    let out = run_git(repo, &["rev-list", "--parents", "-n", "1", oid])?;
    let mut fields = out.lines().next().unwrap_or("").split_whitespace();
    if fields.next().is_none() {
        return Err(format!("could not read parents for {oid}"));
    }
    Ok(fields.map(str::to_string).collect())
}

/// Move the checked-out symbolic branch without touching the index or working
/// tree. The transaction verifies both the local and remote oids under lock, so
/// a concurrent checkout or fetch cannot align to a stale classification.
pub(super) fn align_equivalent_sibling(
    repo: &str,
    local_ref: &str,
    target_ref: &str,
    local_oid: &str,
    target_oid: &str,
) -> Result<String, String> {
    let transaction = format!(
        "start\nupdate {local_ref} {target_oid} {local_oid}\nverify {target_ref} {target_oid}\ncommit\n"
    );
    run_git_with_input(
        repo,
        &[
            "update-ref",
            "-m",
            "checkout remote branch: align equivalent commit",
            "--stdin",
        ],
        &transaction,
    )?;
    Ok(format!("Aligned {local_ref} to {target_oid}"))
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

/// Merge `branch` into the current HEAD, always creating a merge commit.
///
/// The UI offers Fast-forward as a separate, explicit action and labels this
/// operation "Create a merge commit" (`src/lib/graphActions.ts`), so `--no-ff`
/// pins that outcome against the user's `merge.ff` config: default `--ff` would
/// silently fast-forward (no merge commit, contradicting the label) whenever the
/// move was a fast-forward, and `merge.ff=only` would fail an otherwise-mergeable
/// branch. `--no-edit` keeps git from ever launching an editor for the merge
/// message inside this GUI subprocess (there is no TTY to drive it).
///
/// Even under `--no-ff`, merging a branch whose tip is already reachable from
/// HEAD (equal tips included) creates nothing — git exits 0 with "Already up to
/// date." The store keys its toast off that phrase (`src/lib/mergeOutcome.ts`),
/// so diagnostics are pinned to `LC_ALL=C` to keep it locale-stable, same as
/// the tag-clobber detection in `remotes.rs`.
#[cfg(test)]
pub fn merge(repo: &str, branch: &str) -> Result<String, String> {
    ensure_operand(branch)?;
    let _identity_guard = super::identity::lock_identity_config(repo)?;
    let identity_args = super::identity::pinned_commit_args(repo)?;
    merge_locked(repo, branch, &identity_args)
}

fn merge_locked(repo: &str, branch: &str, identity_args: &[String]) -> Result<String, String> {
    let target = qualify_branch_if_ambiguous(repo, branch);
    run_commit_git_stable_locked(
        repo,
        identity_args,
        &["merge", "--no-ff", "--no-edit", &target],
    )
}

fn run_commit_git_locked(
    repo: &str,
    identity_args: &[String],
    command: &[&str],
) -> Result<String, String> {
    let mut args = identity_args.to_vec();
    args.extend(command.iter().map(|arg| (*arg).to_string()));
    let refs = args.iter().map(String::as_str).collect::<Vec<_>>();
    run_git(repo, &refs)
}

fn run_commit_git_stable_locked(
    repo: &str,
    identity_args: &[String],
    command: &[&str],
) -> Result<String, String> {
    let mut args = identity_args.to_vec();
    args.extend(command.iter().map(|arg| (*arg).to_string()));
    let refs = args.iter().map(String::as_str).collect::<Vec<_>>();
    run_git_env_stable_diagnostics(repo, &refs, &[])
}

/// Check out the explicit destination branch at the oid the user saw, verify
/// the source revision has not moved, then merge. The destination is carried
/// through one backend call instead of being an implicit frontend checkout.
pub fn merge_into(
    repo: &str,
    source: &str,
    expected_source_oid: &str,
    destination: Option<&str>,
    expected_destination_oid: &str,
) -> Result<String, String> {
    let _identity_guard = super::identity::lock_identity_config(repo)?;
    let identity_args = super::identity::pinned_commit_args(repo)?;
    ensure_revision_at(repo, source, expected_source_oid)?;
    match destination {
        Some(branch) => checkout_expected_branch(repo, branch, expected_destination_oid)?,
        None => ensure_expected_head(repo, None, Some(expected_destination_oid))?,
    }
    ensure_revision_at(repo, source, expected_source_oid)?;
    merge_locked(repo, &merge_source_operand(repo, source), &identity_args)
}

/// The operand handed to `git merge` for a validated fully-qualified `source`.
/// Git copies the operand verbatim into the generated merge subject, so the
/// qualified form would leave "Merge branch 'refs/heads/feature'" in history.
/// Use the short human name whenever git would resolve it (and any
/// re-qualification in [`merge`]) to the exact validated commit; every other
/// case keeps the unambiguous qualified form — an accurate if uglier subject.
fn merge_source_operand(repo: &str, source: &str) -> String {
    let Some(short) = source
        .strip_prefix("refs/heads/")
        .or_else(|| source.strip_prefix("refs/remotes/"))
    else {
        return source.to_string();
    };
    let resolves_identically = ensure_operand(short).is_ok()
        && qualify_branch_if_ambiguous(repo, short) == short
        && matches!(
            (resolve_rev(repo, short), resolve_rev(repo, source)),
            (Ok(via_short), Ok(via_source)) if via_short == via_source
        );
    if resolves_identically {
        short.to_string()
    } else {
        source.to_string()
    }
}

/// Fast-forward the current HEAD to `target`. Fails (no merge commit) if the
/// move isn't a fast-forward — callers should only offer this when it is.
#[cfg(test)]
pub fn fast_forward(repo: &str, target: &str) -> Result<String, String> {
    ensure_operand(target)?;
    run_git(repo, &["merge", "--ff-only", target])
}

/// Fast-forward a branch that is **not** checked out to `target`, in place,
/// without switching the working tree. `git fetch . <target>:<branch>` updates
/// the local branch ref and — unlike `update-ref` — refuses a non-fast-forward
/// move (no `+` prefix), so it keeps the same FF-only safety as `fast_forward`.
/// Git rejects this on the currently checked-out branch; callers must route the
/// current branch through `fast_forward` instead.
#[cfg(test)]
pub fn fast_forward_branch(repo: &str, branch: &str, target: &str) -> Result<String, String> {
    // `git fetch . <target>:<branch>` has no `--` end-of-options guard, so a
    // dash-prefixed target/branch (e.g. `--upload-pack=…`) would be parsed as an
    // option and reach command execution. Reject those operands outright.
    ensure_operand(branch)?;
    ensure_operand(target)?;
    let branch_ref = format!("refs/heads/{branch}");
    if resolve_rev(repo, &branch_ref)? == resolve_rev(repo, target)? {
        return Ok("Already up to date.".to_string());
    }
    run_git(repo, &["fetch", ".", &format!("{target}:{branch}")])
}

/// Fast-forward the explicit local branch from the oid the user saw to a
/// captured target oid. The backend chooses the checked-out/non-checked-out
/// mechanism from live Git state, never from a stale frontend HEAD snapshot.
pub fn fast_forward_branch_at(
    repo: &str,
    branch: &str,
    expected_branch_oid: &str,
    target_oid: &str,
) -> Result<String, String> {
    ensure_expected_branch_tip(repo, branch, expected_branch_oid)?;
    ensure_commit_exists(repo, target_oid)?;
    if current_branch(repo).as_deref() == Some(branch) {
        ensure_expected_head(repo, Some(branch), Some(expected_branch_oid))?;
        return run_git(repo, &["merge", "--ff-only", target_oid]);
    }

    // A branch checked out in a linked worktree cannot be moved as a bare ref:
    // doing so leaves that worktree's index and files at the old commit, which
    // immediately appears as staged changes. Advance it inside its owning
    // worktree so Git updates HEAD, index, and files together (and preserves
    // Git's dirty-worktree refusal).
    if let Some(owner) = super::worktrees::worktrees(repo)?
        .into_iter()
        .find(|worktree| {
            worktree.branch.as_deref() == Some(branch) && !worktree.bare && !worktree.prunable
        })
    {
        ensure_expected_head(&owner.path, Some(branch), Some(expected_branch_oid))?;
        return run_git(&owner.path, &["merge", "--ff-only", target_oid]);
    }

    let destination = format!("refs/heads/{branch}");
    if resolve_rev(repo, &destination)? == resolve_rev(repo, target_oid)? {
        return Ok("Already up to date.".to_string());
    }
    if run_git(
        repo,
        &[
            "merge-base",
            "--is-ancestor",
            expected_branch_oid,
            target_oid,
        ],
    )
    .is_err()
    {
        return Err(format!(
            "Cannot fast-forward {branch}: the target is not a descendant of its expected tip."
        ));
    }
    // Compare-and-swap the ref so even a branch move between the precondition
    // check and this write cannot be overwritten.
    run_git(
        repo,
        &["update-ref", &destination, target_oid, expected_branch_oid],
    )
}

/// Rebase `source` onto `onto`.
///
/// Passing both operands to one `git rebase <onto> <source>` process is
/// deliberate: the source branch is part of the write contract instead of
/// depending on whichever branch happens to be checked out when the command
/// starts. Git performs the source checkout itself before replaying commits.
pub fn rebase(
    repo: &str,
    source: &str,
    expected_source_oid: &str,
    onto_oid: &str,
) -> Result<String, String> {
    ensure_operand(source)?;
    let _identity_guard = super::identity::lock_identity_config(repo)?;
    let identity_args = super::identity::pinned_commit_args(repo)?;
    ensure_commit_exists(repo, onto_oid)?;
    if source == "HEAD" {
        ensure_expected_head(repo, None, Some(expected_source_oid))?;
    } else {
        ensure_expected_branch_tip(repo, source, expected_source_oid)?;
    }
    run_commit_git_locked(repo, &identity_args, &["rebase", onto_oid, source])
}

/// Whether `commit` is a merge commit (more than one parent). Git refuses to
/// cherry-pick or revert a merge without `-m <parent>`, so those callers probe
/// this first and pass `-m 1`. Uses `git rev-list --parents -n 1`, whose first
/// output line is `<sha> <parent>…` — it fails loudly on an unresolvable
/// commit instead of silently reading "not a merge".
fn is_merge_commit(repo: &str, commit: &str) -> Result<bool, String> {
    let out = run_git(repo, &["rev-list", "--parents", "-n", "1", commit])?;
    // run_git returns stdout followed by stderr; the commit line is first, any
    // stderr warnings (e.g. an ambiguous refname) land on later lines.
    let parents = out
        .lines()
        .next()
        .unwrap_or("")
        .split_whitespace()
        .count()
        .saturating_sub(1);
    Ok(parents > 1)
}

/// Partition `commits` into runs of consecutive commits that agree on
/// merge-ness, preserving order. `git cherry-pick`/`git revert` accept `-m 1`
/// only when *every* named commit is a merge, so a mixed selection has to be
/// split into per-kind invocations.
fn group_by_mergeness<'a>(
    repo: &str,
    commits: &'a [String],
) -> Result<Vec<(bool, Vec<&'a str>)>, String> {
    let mut runs: Vec<(bool, Vec<&str>)> = Vec::new();
    for c in commits {
        let merge = is_merge_commit(repo, c)?;
        match runs.last_mut() {
            Some((kind, run)) if *kind == merge => run.push(c.as_str()),
            _ => runs.push((merge, vec![c.as_str()])),
        }
    }
    Ok(runs)
}

/// Cherry-pick `commit` onto the current HEAD. Merge commits get `-m 1`, so
/// the applied delta is against the first parent — the branch merged *into*,
/// matching the graph's first-parent lane semantics.
#[cfg(test)]
pub fn cherry_pick(repo: &str, commit: &str) -> Result<String, String> {
    ensure_operand(commit)?;
    let _identity_guard = super::identity::lock_identity_config(repo)?;
    let identity_args = super::identity::pinned_commit_args(repo)?;
    cherry_pick_locked(repo, commit, &identity_args)
}

fn cherry_pick_locked(
    repo: &str,
    commit: &str,
    identity_args: &[String],
) -> Result<String, String> {
    if is_merge_commit(repo, commit)? {
        run_commit_git_locked(repo, identity_args, &["cherry-pick", "-m", "1", commit])
    } else {
        run_commit_git_locked(repo, identity_args, &["cherry-pick", commit])
    }
}

pub fn cherry_pick_onto(
    repo: &str,
    expected_branch: Option<&str>,
    expected_oid: &str,
    commit: &str,
) -> Result<String, String> {
    ensure_operand(commit)?;
    let _identity_guard = super::identity::lock_identity_config(repo)?;
    let identity_args = super::identity::pinned_commit_args(repo)?;
    ensure_expected_head(repo, expected_branch, Some(expected_oid))?;
    cherry_pick_locked(repo, commit, &identity_args)
}

/// Cherry-pick several commits onto the current HEAD in order (`git
/// cherry-pick A B C…`). Unlike a client-side loop, batched invocations apply
/// them with proper conflict handling — and stop cleanly on the first conflict
/// instead of leaving a half-applied mess mid-loop.
///
/// Merge commits need `-m 1` and non-merges reject it, so a mixed selection is
/// split into consecutive same-kind runs, one invocation each. A conflict
/// stops at the failing run: earlier runs stay applied (exactly like git's own
/// sequencer stopping mid-batch), but commits after the failing run are not
/// queued in the sequencer — continue finishes only the current run.
#[cfg(test)]
pub fn cherry_pick_many(repo: &str, commits: &[String]) -> Result<String, String> {
    let _identity_guard = super::identity::lock_identity_config(repo)?;
    let identity_args = super::identity::pinned_commit_args(repo)?;
    cherry_pick_many_locked(repo, commits, &identity_args)
}

fn cherry_pick_many_locked(
    repo: &str,
    commits: &[String],
    identity_args: &[String],
) -> Result<String, String> {
    if commits.is_empty() {
        return Err("no commits to cherry-pick".to_string());
    }
    for c in commits {
        ensure_operand(c)?;
    }
    let mut outputs: Vec<String> = Vec::new();
    for (merge, run) in group_by_mergeness(repo, commits)? {
        let mut args: Vec<&str> = Vec::with_capacity(run.len() + 3);
        args.push("cherry-pick");
        if merge {
            args.extend(["-m", "1"]);
        }
        args.extend(run);
        outputs.push(run_commit_git_locked(repo, identity_args, &args)?);
    }
    outputs.retain(|o| !o.is_empty());
    Ok(outputs.join("\n"))
}

pub fn cherry_pick_many_onto(
    repo: &str,
    expected_branch: Option<&str>,
    expected_oid: &str,
    commits: &[String],
) -> Result<String, String> {
    let _identity_guard = super::identity::lock_identity_config(repo)?;
    let identity_args = super::identity::pinned_commit_args(repo)?;
    ensure_expected_head(repo, expected_branch, Some(expected_oid))?;
    cherry_pick_many_locked(repo, commits, &identity_args)
}

/// Revert `commit`, creating a new commit that undoes it. Merge commits get
/// `-m 1`: the revert undoes what the merge brought in relative to its first
/// parent — the branch merged *into*, matching the graph's first-parent lane
/// semantics.
#[cfg(test)]
pub fn revert(repo: &str, commit: &str) -> Result<String, String> {
    ensure_operand(commit)?;
    let _identity_guard = super::identity::lock_identity_config(repo)?;
    let identity_args = super::identity::pinned_commit_args(repo)?;
    revert_locked(repo, commit, &identity_args)
}

fn revert_locked(repo: &str, commit: &str, identity_args: &[String]) -> Result<String, String> {
    if is_merge_commit(repo, commit)? {
        run_commit_git_locked(
            repo,
            identity_args,
            &["revert", "--no-edit", "-m", "1", commit],
        )
    } else {
        run_commit_git_locked(repo, identity_args, &["revert", "--no-edit", commit])
    }
}

pub fn revert_onto(
    repo: &str,
    expected_branch: Option<&str>,
    expected_oid: &str,
    commit: &str,
) -> Result<String, String> {
    ensure_operand(commit)?;
    let _identity_guard = super::identity::lock_identity_config(repo)?;
    let identity_args = super::identity::pinned_commit_args(repo)?;
    ensure_expected_head(repo, expected_branch, Some(expected_oid))?;
    revert_locked(repo, commit, &identity_args)
}

/// Revert several commits in order (`git revert --no-edit A B…`); stops on the
/// first conflict. Same split as [`cherry_pick_many`]: merge commits need
/// `-m 1` and non-merges reject it, so mixed selections run as consecutive
/// same-kind invocations, and a conflict leaves earlier runs applied without
/// queueing the later ones.
#[cfg(test)]
pub fn revert_many(repo: &str, commits: &[String]) -> Result<String, String> {
    let _identity_guard = super::identity::lock_identity_config(repo)?;
    let identity_args = super::identity::pinned_commit_args(repo)?;
    revert_many_locked(repo, commits, &identity_args)
}

fn revert_many_locked(
    repo: &str,
    commits: &[String],
    identity_args: &[String],
) -> Result<String, String> {
    if commits.is_empty() {
        return Err("no commits to revert".to_string());
    }
    for c in commits {
        ensure_operand(c)?;
    }
    let mut outputs: Vec<String> = Vec::new();
    for (merge, run) in group_by_mergeness(repo, commits)? {
        let mut args: Vec<&str> = Vec::with_capacity(run.len() + 4);
        args.push("revert");
        args.push("--no-edit");
        if merge {
            args.extend(["-m", "1"]);
        }
        args.extend(run);
        outputs.push(run_commit_git_locked(repo, identity_args, &args)?);
    }
    outputs.retain(|o| !o.is_empty());
    Ok(outputs.join("\n"))
}

pub fn revert_many_onto(
    repo: &str,
    expected_branch: Option<&str>,
    expected_oid: &str,
    commits: &[String],
) -> Result<String, String> {
    let _identity_guard = super::identity::lock_identity_config(repo)?;
    let identity_args = super::identity::pinned_commit_args(repo)?;
    ensure_expected_head(repo, expected_branch, Some(expected_oid))?;
    revert_many_locked(repo, commits, &identity_args)
}

/// Create a lightweight tag `name` at `sha` (defaults to HEAD). Reads back as a
/// `RefLabel` of kind "tag" on the graph.
///
/// `--no-sign` overrides `tag.gpgsign=true`, which would otherwise upgrade the
/// plain `git tag` to a *signed* (annotated) tag — and, with no `-m`, make git
/// launch an editor for the message inside this GUI subprocess and fail. A
/// lightweight tag carries no message or tagger, so there is nothing to sign.
/// (`--no-sign` needs git ≥ 2.23, well below the 2.43+ this app already
/// assumes elsewhere.)
pub fn create_tag(repo: &str, name: &str, sha: Option<&str>) -> Result<String, String> {
    ensure_operand(name)?;
    ensure_opt(sha)?;
    match sha {
        Some(s) => run_git(repo, &["tag", "--no-sign", name, s]),
        None => run_git(repo, &["tag", "--no-sign", name]),
    }
}

/// Create an annotated tag `name` carrying `message` at `sha` (defaults to HEAD).
/// Unlike a lightweight tag this stores a tagger + message, so it shows up in
/// `git tag -n` and can be GPG-signed by the user's config.
pub fn create_annotated_tag(
    repo: &str,
    name: &str,
    message: &str,
    sha: Option<&str>,
) -> Result<String, String> {
    ensure_operand(name)?;
    ensure_opt(sha)?;
    let _identity_guard = super::identity::lock_identity_config(repo)?;
    let mut args = super::identity::pinned_tag_args(repo)?;
    args.extend([
        "tag".to_string(),
        "-a".to_string(),
        name.to_string(),
        "-m".to_string(),
        message.to_string(),
    ]);
    if let Some(s) = sha {
        args.push(s.to_string());
    }
    let refs = args.iter().map(String::as_str).collect::<Vec<_>>();
    run_git(repo, &refs)
}

/// Write a patch for one non-merge commit into the worktree without allowing
/// git's generated filename to overwrite an existing file. `format-patch -1`
/// silently skips merge commits and selects a nearby non-merge ancestor, so
/// merges are rejected until the UI exposes an explicit first-parent policy.
pub fn create_patch(repo: &str, sha: &str) -> Result<String, String> {
    ensure_operand(sha)?;
    if is_merge_commit(repo, sha)? {
        return Err(
            "Merge commits do not have a single email-patch delta. Review a parent diff or choose a non-merge commit."
                .to_string(),
        );
    }

    let patch = super::cli::run_git_stdout_raw(repo, &["format-patch", "--stdout", "-1", sha])?;
    let subject = run_git(
        repo,
        &["show", "-s", "--no-show-signature", "--format=%f", sha],
    )?;
    let fallback: String = sha.chars().take(12).collect();
    let safe_subject: String = subject.trim().chars().take(96).collect();
    let safe_subject = if safe_subject.is_empty() {
        fallback.as_str()
    } else {
        safe_subject.as_str()
    };

    let worktree_raw = super::cli::run_git_stdout_raw(repo, &["rev-parse", "--show-toplevel"])?;
    let worktree = String::from_utf8(worktree_raw)
        .map_err(|_| "The repository worktree path is not valid UTF-8.".to_string())?;
    let worktree = PathBuf::from(worktree.trim_end_matches(['\r', '\n']));

    for collision in 0..10_000 {
        let filename = if collision == 0 {
            format!("0001-{safe_subject}.patch")
        } else {
            format!("0001-{safe_subject}-{}.patch", collision + 1)
        };
        let path = worktree.join(&filename);
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                if let Err(error) = file.write_all(&patch) {
                    let _ = std::fs::remove_file(&path);
                    return Err(format!("Couldn't write patch {filename}: {error}"));
                }
                return Ok(filename);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("Couldn't create patch {filename}: {error}")),
        }
    }

    Err("Couldn't choose an unused patch filename in the worktree.".to_string())
}

/// Reset the current branch to `target`. `mode` is one of soft|mixed|hard.
///
/// Like [`merge`]/[`rebase`], a bare `target` that is both a branch and a tag is
/// qualified to `refs/heads/` so the reset lands on the branch rather than the
/// tag git's rev resolution would otherwise pick first.
pub fn reset(repo: &str, target: &str, mode: &str) -> Result<String, String> {
    ensure_operand(target)?;
    let flag = match mode {
        "soft" => "--soft",
        "hard" => "--hard",
        _ => "--mixed",
    };
    let target = qualify_branch_if_ambiguous(repo, target);
    run_git(repo, &["reset", flag, &target])
}

/// Reset the explicit source branch/HEAD snapshot to a captured target oid.
/// Named branches are checked out and revalidated inside this backend call.
pub fn reset_branch(
    repo: &str,
    source: Option<&str>,
    expected_source_oid: Option<&str>,
    target_oid: &str,
    mode: &str,
) -> Result<String, String> {
    match (source, expected_source_oid) {
        (Some(branch), Some(oid)) => checkout_expected_branch(repo, branch, oid)?,
        (None, oid) => ensure_expected_head(repo, None, oid)?,
        (Some(_), None) => {
            return Err("The branch has no expected commit. Refresh and try again.".to_string())
        }
    }
    ensure_commit_exists(repo, target_oid)?;
    reset(repo, target_oid, mode)
}

/// Delete a local tag only when it still points at `expected_oid`. `update-ref`
/// performs the comparison and deletion atomically, so a tag moved after the
/// UI opened its confirmation cannot be erased accidentally. The tag ref is
/// removed locally only; the remote copy (if any) is untouched — that's
/// [`super::delete_remote_tag`], and while the tag still exists on a remote the
/// next Fetch's `refs/tags/*` import brings it back.
pub fn delete_tag(repo: &str, name: &str, expected_oid: &str) -> Result<String, String> {
    ensure_operand(name)?;
    ensure_operand(expected_oid)?;
    let reference = format!("refs/tags/{name}");
    run_git(repo, &["update-ref", "-d", &reference, expected_oid])?;
    Ok(format!("Deleted tag {name}"))
}
