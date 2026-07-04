//! Branch, tag, patch, sequencer, and reset operations.

use super::cli::{run_git, run_git_env_stable_diagnostics};
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

/// Disambiguate a bare ref that is *both* a local branch and a tag toward the
/// branch by returning `refs/heads/<name>`; otherwise return `name` unchanged.
///
/// Git's rev resolution gives a **tag** precedence over a same-named branch
/// (`gitrevisions`), so `git merge feature` / `git rebase feature` silently
/// operate on the tag when both exist. Merge/rebase take a branch here, so
/// qualify to `refs/heads/` in exactly that ambiguous case — matching how the
/// tag operations already fully-qualify `refs/tags/`. The qualification is
/// skipped when no clashing tag exists, so the ordinary case keeps its clean
/// bare name (and merge keeps its "Merge branch 'feature'" message).
fn qualify_branch_if_ambiguous(repo: &str, name: &str) -> String {
    if ref_exists(repo, &format!("refs/heads/{name}")) && ref_exists(repo, &format!("refs/tags/{name}"))
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

/// Create a branch `name` at `start_point` (defaults to HEAD).
pub fn create_branch(repo: &str, name: &str, start_point: Option<&str>) -> Result<String, String> {
    ensure_operand(name)?;
    ensure_opt(start_point)?;
    match start_point {
        Some(sp) => run_git(repo, &["branch", name, sp]),
        None => run_git(repo, &["branch", name]),
    }
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

/// Fast-forward the current HEAD to `target`. Fails (no merge commit) if the
/// move isn't a fast-forward — callers should only offer this when it is.
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
pub fn fast_forward_branch(repo: &str, branch: &str, target: &str) -> Result<String, String> {
    // `git fetch . <target>:<branch>` has no `--` end-of-options guard, so a
    // dash-prefixed target/branch (e.g. `--upload-pack=…`) would be parsed as an
    // option and reach command execution. Reject those operands outright.
    ensure_operand(branch)?;
    ensure_operand(target)?;
    run_git(repo, &["fetch", ".", &format!("{target}:{branch}")])
}

/// Rebase the current HEAD onto `onto`.
pub fn rebase(repo: &str, onto: &str) -> Result<String, String> {
    ensure_operand(onto)?;
    let target = qualify_branch_if_ambiguous(repo, onto);
    run_git(repo, &["rebase", &target])
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
pub fn reset(repo: &str, target: &str, mode: &str) -> Result<String, String> {
    ensure_operand(target)?;
    let flag = match mode {
        "soft" => "--soft",
        "hard" => "--hard",
        _ => "--mixed",
    };
    run_git(repo, &["reset", flag, target])
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
