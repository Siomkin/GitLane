//! Branch, tag, patch, sequencer, and reset operations.

use super::cli::{run_git, run_git_env_stable_diagnostics, run_git_with_input};
use super::head::{
    checkout_expected_branch, current_branch, ensure_commit_exists, ensure_expected_branch_tip,
    ensure_expected_head, ensure_revision_at,
};
use super::operands::{ensure_operand, ensure_opt};

/// Check out an existing branch, tag, or commit.
///
/// The bare `target` is intentional even when a branch and tag share the name:
/// `git checkout <name>` DWIMs to the *branch* (git's own precedence for
/// checkout), whereas `git checkout refs/heads/<name>` would *detach* HEAD. So
/// unlike merge/rebase below, checkout needs no `refs/heads/` qualification —
/// adding it would regress the common "switch to branch" case.
pub fn checkout(repo: &str, target: &str) -> Result<String, String> {
    ensure_operand(target)?;
    run_git(repo, &["checkout", target])
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
        checkout(repo, branch)?;
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
        run_git(repo, &["checkout", "--track", "-b", branch, &remote_ref])
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

/// Delete a local branch. `force` maps to `-D` (drops the merged-safety check).
pub fn delete_branch(repo: &str, name: &str, force: bool) -> Result<String, String> {
    ensure_operand(name)?;
    let flag = if force { "-D" } else { "-d" };
    run_git(repo, &["branch", flag, name])
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
pub fn merge(repo: &str, branch: &str) -> Result<String, String> {
    ensure_operand(branch)?;
    let target = qualify_branch_if_ambiguous(repo, branch);
    run_git_env_stable_diagnostics(repo, &["merge", "--no-ff", "--no-edit", &target], &[])
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
    ensure_revision_at(repo, source, expected_source_oid)?;
    match destination {
        Some(branch) => checkout_expected_branch(repo, branch, expected_destination_oid)?,
        None => ensure_expected_head(repo, None, Some(expected_destination_oid))?,
    }
    ensure_revision_at(repo, source, expected_source_oid)?;
    merge(repo, &merge_source_operand(repo, source))
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
    ensure_commit_exists(repo, onto_oid)?;
    if source == "HEAD" {
        ensure_expected_head(repo, None, Some(expected_source_oid))?;
    } else {
        ensure_expected_branch_tip(repo, source, expected_source_oid)?;
    }
    run_git(repo, &["rebase", onto_oid, source])
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
pub fn cherry_pick(repo: &str, commit: &str) -> Result<String, String> {
    ensure_operand(commit)?;
    if is_merge_commit(repo, commit)? {
        run_git(repo, &["cherry-pick", "-m", "1", commit])
    } else {
        run_git(repo, &["cherry-pick", commit])
    }
}

pub fn cherry_pick_onto(
    repo: &str,
    expected_branch: Option<&str>,
    expected_oid: &str,
    commit: &str,
) -> Result<String, String> {
    ensure_expected_head(repo, expected_branch, Some(expected_oid))?;
    cherry_pick(repo, commit)
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
pub fn cherry_pick_many(repo: &str, commits: &[String]) -> Result<String, String> {
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
        outputs.push(run_git(repo, &args)?);
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
    ensure_expected_head(repo, expected_branch, Some(expected_oid))?;
    cherry_pick_many(repo, commits)
}

/// Revert `commit`, creating a new commit that undoes it. Merge commits get
/// `-m 1`: the revert undoes what the merge brought in relative to its first
/// parent — the branch merged *into*, matching the graph's first-parent lane
/// semantics.
pub fn revert(repo: &str, commit: &str) -> Result<String, String> {
    ensure_operand(commit)?;
    if is_merge_commit(repo, commit)? {
        run_git(repo, &["revert", "--no-edit", "-m", "1", commit])
    } else {
        run_git(repo, &["revert", "--no-edit", commit])
    }
}

pub fn revert_onto(
    repo: &str,
    expected_branch: Option<&str>,
    expected_oid: &str,
    commit: &str,
) -> Result<String, String> {
    ensure_expected_head(repo, expected_branch, Some(expected_oid))?;
    revert(repo, commit)
}

/// Revert several commits in order (`git revert --no-edit A B…`); stops on the
/// first conflict. Same split as [`cherry_pick_many`]: merge commits need
/// `-m 1` and non-merges reject it, so mixed selections run as consecutive
/// same-kind invocations, and a conflict leaves earlier runs applied without
/// queueing the later ones.
pub fn revert_many(repo: &str, commits: &[String]) -> Result<String, String> {
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
        outputs.push(run_git(repo, &args)?);
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
    ensure_expected_head(repo, expected_branch, Some(expected_oid))?;
    revert_many(repo, commits)
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
    let mut args = vec!["tag", "-a", name, "-m", message];
    if let Some(s) = sha {
        args.push(s);
    }
    run_git(repo, &args)
}

/// Write a patch file for the single commit `sha` into the worktree via
/// `git format-patch -1`. Git names the file `NNNN-<subject>.patch` and prints
/// the path it created, which we return as the success message.
pub fn create_patch(repo: &str, sha: &str) -> Result<String, String> {
    ensure_operand(sha)?;
    run_git(repo, &["format-patch", "-1", sha])
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

/// Delete a local tag (`git tag -d <name>`). The tag ref is removed locally
/// only; the remote copy (if any) is untouched — that's
/// [`super::delete_remote_tag`], and while the tag still exists on a remote the
/// next Fetch's `refs/tags/*` import brings it back.
pub fn delete_tag(repo: &str, name: &str) -> Result<String, String> {
    ensure_operand(name)?;
    run_git(repo, &["tag", "-d", name])?;
    Ok(format!("Deleted tag {name}"))
}
