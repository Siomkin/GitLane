//! Mutating git operations.
//!
//! These intentionally shell out to the user's real `git` binary rather than
//! using libgit2. The CLI honours hooks, credential helpers, `.gitconfig`,
//! signing, and the full conflict machinery — all of which libgit2 wrappers
//! reimplement only partially. These back the drag-and-drop branch actions.

use crate::git::types::{StashContextCommit, StashEntry, WorktreeInfo};
use std::collections::HashMap;
use std::process::Command;

const STASH_CONTEXT_LIMIT: usize = 8;

/// Run `git -C <repo> <args...>`, returning combined stdout/stderr on success
/// or the error output on a non-zero exit.
fn run_git(repo: &str, args: &[&str]) -> Result<String, String> {
    run_git_env(repo, args, &[])
}

/// Like [`run_git`] but with extra environment variables — used to pass a
/// bound account's `GH_TOKEN` through git's credential helper on push.
fn run_git_env(repo: &str, args: &[&str], envs: &[(&str, &str)]) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(repo).args(args);
    // macOS GUI apps launch with a minimal PATH; use the augmented one so a
    // Homebrew git (and any credential helpers/signing tools it invokes) is found.
    cmd.env("PATH", crate::shell::path());
    for (k, v) in envs {
        cmd.env(k, v);
    }

    let output = cmd
        .output()
        .map_err(|e| format!("failed to launch git: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if output.status.success() {
        Ok(format!("{stdout}{stderr}").trim().to_string())
    } else {
        Err(format!("{stdout}{stderr}").trim().to_string())
    }
}

/// Reject a user-supplied ref/branch/tag/commit/path operand that git would
/// otherwise parse as an option because it begins with `-` (e.g. a ref literally
/// named `--upload-pack=…` or `--exec=…`, which can turn `git fetch`/`rebase`
/// into arbitrary command execution). git itself forbids ref names starting with
/// `-`, so this rejects nothing a legitimate operation produces. We use this
/// rather than a `--` end-of-options separator because for several of these
/// subcommands (`checkout`, `merge`, `reset`) `--` switches to *pathspec*
/// semantics and would change the meaning of the argument.
fn ensure_operand(value: &str) -> Result<(), String> {
    if value.starts_with('-') {
        return Err(format!(
            "Refusing unsafe git argument that begins with '-': {value:?}"
        ));
    }
    Ok(())
}

/// [`ensure_operand`] for an optional operand.
fn ensure_opt(value: Option<&str>) -> Result<(), String> {
    if let Some(v) = value {
        ensure_operand(v)?;
    }
    Ok(())
}

/// Check out an existing branch, tag, or commit.
pub fn checkout(repo: &str, target: &str) -> Result<String, String> {
    ensure_operand(target)?;
    run_git(repo, &["checkout", target])
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

/// Merge `branch` into the current HEAD.
pub fn merge(repo: &str, branch: &str) -> Result<String, String> {
    ensure_operand(branch)?;
    run_git(repo, &["merge", branch])
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
    run_git(repo, &["rebase", onto])
}

/// Cherry-pick `commit` onto the current HEAD.
pub fn cherry_pick(repo: &str, commit: &str) -> Result<String, String> {
    ensure_operand(commit)?;
    run_git(repo, &["cherry-pick", commit])
}

/// Cherry-pick several commits onto the current HEAD in one atomic invocation
/// (`git cherry-pick A B C…`). Unlike a client-side loop, a single invocation
/// applies them in order with proper conflict handling — and stops cleanly on
/// the first conflict instead of leaving a half-applied mess mid-loop.
pub fn cherry_pick_many(repo: &str, commits: &[String]) -> Result<String, String> {
    if commits.is_empty() {
        return Err("no commits to cherry-pick".to_string());
    }
    for c in commits {
        ensure_operand(c)?;
    }
    let mut args: Vec<&str> = Vec::with_capacity(commits.len() + 1);
    args.push("cherry-pick");
    for c in commits {
        args.push(c.as_str());
    }
    run_git(repo, &args)
}

/// Revert `commit`, creating a new commit that undoes it.
pub fn revert(repo: &str, commit: &str) -> Result<String, String> {
    ensure_operand(commit)?;
    run_git(repo, &["revert", "--no-edit", commit])
}

/// Revert several commits in one atomic invocation (`git revert --no-edit A B…`).
/// Reverts in the given order; stops on the first conflict.
pub fn revert_many(repo: &str, commits: &[String]) -> Result<String, String> {
    if commits.is_empty() {
        return Err("no commits to revert".to_string());
    }
    for c in commits {
        ensure_operand(c)?;
    }
    let mut args: Vec<&str> = Vec::with_capacity(commits.len() + 2);
    args.push("revert");
    args.push("--no-edit");
    for c in commits {
        args.push(c.as_str());
    }
    run_git(repo, &args)
}

// ---- Conflict resolution (merge / rebase / cherry-pick / revert) ----
//
// `merge`/`rebase`/`cherry_pick`/`revert` above can stop on conflicts; these
// resolve the conflicted state and drive the operation to completion. The
// *detection* side (which operation, which files) is a libgit2 read in
// `git::conflicts`; everything here shells out to real `git` so hooks, rerere,
// signing, and the sequencer's own state machine all behave exactly as the CLI.

/// Resolve a conflicted file by taking one whole side. `side` is "ours"
/// (current branch) or "theirs" (incoming). Checks that stage's content into the
/// worktree and stages it; when the chosen side *deleted* the file (so it has no
/// stage to check out) the file is removed instead — covering modify/delete and
/// add/add conflicts with one path.
pub fn accept_conflict_side(repo: &str, file: &str, side: &str) -> Result<String, String> {
    // No `ensure_operand` on `file`: every git call below passes it after `--`
    // (pathspec), so a legitimately conflicted file named e.g. `-foo` is safe and
    // must not be rejected. `ensure_conflicted` already gates it to the index
    // conflict set.
    ensure_conflicted(repo, file)?;
    let (flag, stage) = match side {
        "ours" => ("--ours", "2"),
        "theirs" => ("--theirs", "3"),
        _ => return Err(format!("unknown conflict side {side:?}")),
    };
    match run_git(repo, &["checkout", flag, "--", file]) {
        Ok(_) => {
            run_git(repo, &["add", "-A", "--", file])?;
        }
        // A failed checkout means "accept the deletion" ONLY when the chosen side
        // genuinely has no staged version — a modify/delete conflict. For any
        // other failure (a lock, a permission error, a corrupt index) we must
        // surface the error rather than force-deleting the user's file.
        Err(e) => {
            if conflict_stage_absent(repo, file, stage) {
                run_git(repo, &["rm", "-f", "--", file])?;
            } else {
                return Err(e);
            }
        }
    }
    Ok(format!("Resolved {file} ({side})"))
}

/// True when unmerged `stage` (2 = ours, 3 = theirs) is absent for `file` in the
/// index — i.e. that side deleted the file. Parses `git ls-files -u` lines
/// (`<mode> <oid> <stage>\t<path>`). A read failure returns false so we never
/// delete on an indeterminate state.
fn conflict_stage_absent(repo: &str, file: &str, stage: &str) -> bool {
    match run_git(repo, &["ls-files", "-u", "--", file]) {
        Ok(out) => !out.lines().any(|line| {
            line.split('\t')
                .next()
                .and_then(|meta| meta.split_whitespace().nth(2))
                == Some(stage)
        }),
        Err(_) => false,
    }
}

/// True when `file` has unmerged (conflict) index entries — i.e. it is a path the
/// active operation actually left conflicted. The per-file resolution commands
/// require this so a renderer-supplied path can only touch files genuinely in the
/// conflict set, not an arbitrary (even repo-relative) file.
fn is_unmerged(repo: &str, file: &str) -> bool {
    run_git(repo, &["ls-files", "-u", "--", file])
        .map(|out| !out.trim().is_empty())
        .unwrap_or(false)
}

/// Reject a resolution targeting a path that isn't currently conflicted.
fn ensure_conflicted(repo: &str, file: &str) -> Result<(), String> {
    if is_unmerged(repo, file) {
        Ok(())
    } else {
        Err(format!("{file:?} is not a conflicted path"))
    }
}

/// True when a merge/rebase/cherry-pick/revert is underway — i.e. git still holds
/// the state needed to recreate a conflict. `git checkout --merge` is only
/// meaningful then; outside an operation it would instead overwrite the worktree
/// copy with the staged version, silently discarding the user's edits.
fn operation_in_progress(repo: &str) -> bool {
    let Ok(git_dir) = run_git(repo, &["rev-parse", "--absolute-git-dir"]) else {
        return false;
    };
    let git_dir = std::path::Path::new(git_dir.trim());
    [
        "MERGE_HEAD",
        "CHERRY_PICK_HEAD",
        "REVERT_HEAD",
        "rebase-merge",
        "rebase-apply",
    ]
    .iter()
    .any(|name| git_dir.join(name).exists())
}

/// Resolve a repo-relative `file` to an absolute path under the worktree `root`,
/// rejecting absolute paths and `..`/prefix components so a caller-supplied path
/// can never escape the repository. Conflicted paths come from git's index
/// (which already forbids these), but this write crosses the IPC boundary, so we
/// validate defensively before touching the filesystem.
fn worktree_path(root: &str, file: &str) -> Result<std::path::PathBuf, String> {
    let rel = std::path::Path::new(file);
    if rel.is_absolute()
        || rel.components().any(|c| {
            matches!(
                c,
                std::path::Component::ParentDir | std::path::Component::Prefix(_)
            )
        })
    {
        return Err(format!("refusing unsafe path outside the worktree: {file:?}"));
    }
    Ok(std::path::Path::new(root.trim()).join(rel))
}

/// Write the merged `content` to a conflicted file and stage it — backs the
/// in-app hunk editor, which reconstructs the resolved text from the user's
/// per-hunk choices. The path is resolved against the worktree root (and checked
/// to stay inside it) so it is correct for linked worktrees and never escapes.
pub fn resolve_conflict_file(repo: &str, file: &str, content: &str) -> Result<String, String> {
    // `file` is staged after `--` and resolved through `worktree_path` (which
    // rejects traversal), so no `ensure_operand` dash-guard is needed — and it
    // would wrongly block a conflicted file named `-foo`.
    ensure_conflicted(repo, file)?;
    let root = run_git(repo, &["rev-parse", "--show-toplevel"])?;
    let full = worktree_path(&root, file)?;
    std::fs::write(&full, content).map_err(|e| format!("write {file}: {e}"))?;
    run_git(repo, &["add", "--", file])?;
    Ok(format!("Resolved {file}"))
}

/// Mark a conflicted file resolved by staging it as it currently sits on disk
/// (after the user edited it in their own editor). `-A` also stages a deletion.
pub fn mark_conflict_resolved(repo: &str, file: &str) -> Result<String, String> {
    // `file` passed after `--`; gated by `ensure_conflicted`. No dash-guard (see
    // `accept_conflict_side`) so a conflicted `-foo` can be staged.
    ensure_conflicted(repo, file)?;
    run_git(repo, &["add", "-A", "--", file])?;
    Ok(format!("Staged {file}"))
}

/// Restore the conflict markers for a file that was already resolved/staged so
/// it can be re-resolved (`git checkout --merge`) — the inverse of staging a
/// resolution, exposed as the per-file "Unstage" affordance.
pub fn reconflict_file(repo: &str, file: &str) -> Result<String, String> {
    // `file` is passed after `--`, so no dash-guard is needed (it would block a
    // conflicted `-foo`).
    // Guard against clobbering: outside an active operation `git checkout
    // --merge` has no conflict to recreate and would just overwrite the worktree
    // file with the index copy, discarding any edits. Only allow it mid-operation
    // (the intended inverse of staging a resolution).
    if !operation_in_progress(repo) {
        return Err(format!(
            "no merge in progress — cannot restore the conflict in {file:?}"
        ));
    }
    run_git(repo, &["checkout", "--merge", "--", file])?;
    Ok(format!("Restored conflict in {file}"))
}

/// Recognise the state git reports when a cherry-pick/revert patch becomes
/// **empty** after conflict resolution — git prints "The previous cherry-pick
/// (or revert) is now empty…" and stops, asking for `--skip` or `git commit
/// --allow-empty`. Matched on the specific "is now empty" phrase so unrelated
/// `--continue` failures (e.g. a hook rejecting an otherwise non-empty commit)
/// are NOT mistaken for empty and silently skipped.
fn is_empty_after_resolution(msg: &str) -> bool {
    msg.to_lowercase().contains("is now empty")
}

/// Continue the active operation once its conflicts are resolved and staged.
/// `kind` is the operation key from `git::conflicts::operation_status`. `GIT_EDITOR=true`
/// keeps the prepared message (MERGE_MSG / the replayed commit) without opening
/// an editor, and the bound identity is pinned with `-c user.*` exactly as
/// [`commit`] does so the resulting commit carries the repo's account identity.
///
/// If a cherry-pick/revert patch resolved to an empty change, git refuses to
/// `--continue` and asks for `--skip`; we do exactly that — the change is already
/// present, so the now-empty patch is skipped and the operation advances. This
/// keeps "Continue" working instead of surfacing a raw git error.
pub fn continue_operation(
    repo: &str,
    kind: &str,
    name: Option<&str>,
    email: Option<&str>,
) -> Result<String, String> {
    let mut pre: Vec<String> = Vec::new();
    if let (Some(n), Some(e)) = (name, email) {
        if !n.is_empty() && !e.is_empty() {
            pre.push("-c".into());
            pre.push(format!("user.name={n}"));
            pre.push("-c".into());
            pre.push(format!("user.email={e}"));
        }
    }
    let sub: &[&str] = match kind {
        "merge" => &["merge", "--continue"],
        "rebase" => &["rebase", "--continue"],
        "cherry-pick" => &["cherry-pick", "--continue"],
        "revert" => &["revert", "--continue"],
        _ => return Err(format!("no active operation to continue ({kind})")),
    };
    let mut args: Vec<&str> = pre.iter().map(String::as_str).collect();
    args.extend_from_slice(sub);
    match run_git_env(repo, &args, &[("GIT_EDITOR", "true")]) {
        Ok(out) => Ok(out),
        Err(e)
            if matches!(kind, "cherry-pick" | "revert") && is_empty_after_resolution(&e) =>
        {
            run_git_env(repo, &[kind, "--skip"], &[("GIT_EDITOR", "true")])
        }
        Err(e) => Err(e),
    }
}

/// Abort the active operation, restoring the pre-operation state. `kind` is the
/// operation key from `git::conflicts::operation_status`.
pub fn abort_operation(repo: &str, kind: &str) -> Result<String, String> {
    let sub: &[&str] = match kind {
        "merge" => &["merge", "--abort"],
        "rebase" => &["rebase", "--abort"],
        "cherry-pick" => &["cherry-pick", "--abort"],
        "revert" => &["revert", "--abort"],
        _ => return Err(format!("no active operation to abort ({kind})")),
    };
    run_git(repo, sub)?;
    Ok(format!("Aborted {kind}"))
}

/// Skip the current commit in a sequencer operation (rebase/cherry-pick/revert).
/// Merge has no skip and is rejected. `kind` is the operation key.
pub fn skip_operation(repo: &str, kind: &str) -> Result<String, String> {
    let sub: &[&str] = match kind {
        "rebase" => &["rebase", "--skip"],
        "cherry-pick" => &["cherry-pick", "--skip"],
        "revert" => &["revert", "--skip"],
        _ => return Err(format!("cannot skip a {kind} operation")),
    };
    run_git_env(repo, sub, &[("GIT_EDITOR", "true")])
}

/// Create a lightweight tag `name` at `sha` (defaults to HEAD). Reads back as a
/// `RefLabel` of kind "tag" on the graph.
pub fn create_tag(repo: &str, name: &str, sha: Option<&str>) -> Result<String, String> {
    ensure_operand(name)?;
    ensure_opt(sha)?;
    match sha {
        Some(s) => run_git(repo, &["tag", name, s]),
        None => run_git(repo, &["tag", name]),
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

/// List linked worktrees via `git worktree list --porcelain`. This is a read,
/// but uses the CLI's stable porcelain output rather than libgit2's awkward
/// worktree API. The first entry is always the primary (main) worktree.
pub fn worktrees(repo: &str) -> Result<Vec<WorktreeInfo>, String> {
    let raw = run_git(repo, &["worktree", "list", "--porcelain"])?;
    let mut out = Vec::new();
    let mut path: Option<String> = None;
    let mut branch: Option<String> = None;
    let mut first = true;

    let mut flush = |path: &mut Option<String>, branch: &mut Option<String>, first: &mut bool| {
        if let Some(p) = path.take() {
            let name = p.rsplit('/').next().unwrap_or(&p).to_string();
            out.push(WorktreeInfo {
                name,
                path: p,
                branch: branch.take(),
                is_main: std::mem::replace(first, false),
            });
        } else {
            *branch = None;
        }
    };

    for line in raw.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            flush(&mut path, &mut branch, &mut first);
            path = Some(p.trim().to_string());
        } else if let Some(b) = line.strip_prefix("branch ") {
            branch = Some(b.trim().trim_start_matches("refs/heads/").to_string());
        }
    }
    flush(&mut path, &mut branch, &mut first);
    Ok(out)
}

/// Create a new linked worktree at `worktree_path`, checked out to `reference`
/// (a branch, tag, or commit; defaults to HEAD). When `reference` is a commit or
/// a tag the new worktree is detached; an existing branch is checked out there
/// (git refuses if it's already checked out elsewhere, surfacing its own error).
pub fn add_worktree(
    repo: &str,
    worktree_path: &str,
    reference: Option<&str>,
) -> Result<String, String> {
    ensure_operand(worktree_path)?;
    ensure_opt(reference)?;
    match reference {
        Some(r) => run_git(repo, &["worktree", "add", worktree_path, r]),
        None => run_git(repo, &["worktree", "add", worktree_path]),
    }
}

/// List stashes via `git stash list`. Each line is
/// `<oid>\x1f<parents>\x1f<committer-time>\x1f<subject>`; the line index is the
/// stash index (0 = most recent). A stash commit's first parent is the base commit.
pub fn stash_list(repo: &str) -> Result<Vec<StashEntry>, String> {
    let raw = run_git(repo, &["stash", "list", "--format=%H%x1f%P%x1f%ct%x1f%s"])?;
    let mut parsed = Vec::new();
    let mut base_oids = Vec::new();
    for (index, line) in raw.lines().enumerate() {
        if line.is_empty() {
            continue;
        }
        let mut parts = line.splitn(4, '\u{1f}');
        let oid = parts.next().unwrap_or("").to_string();
        let parents = parts.next().unwrap_or("");
        let base_oid = parents.split_whitespace().next().map(str::to_string);
        // Keep this `None` on a malformed `%ct` so the mapping below can fall
        // back to the base commit's time rather than 0 (which would sort a real
        // stash below every commit and risk pushing it to the fallback row).
        let timestamp = parts.next().and_then(|value| value.parse::<i64>().ok());
        let message = parts.next().unwrap_or("").to_string();
        if let Some(base) = &base_oid {
            base_oids.push(base.clone());
        }
        parsed.push((index, message, oid, timestamp, base_oid));
    }

    let base_timestamps = stash_base_timestamps(repo, &base_oids);
    let mut context_by_base: HashMap<String, Vec<StashContextCommit>> = HashMap::new();
    for base in &base_oids {
        context_by_base
            .entry(base.clone())
            .or_insert_with(|| stash_context_commits(repo, base));
    }
    Ok(parsed
        .into_iter()
        .map(|(index, message, oid, timestamp, base_oid)| {
            let base_timestamp = base_oid
                .as_ref()
                .and_then(|base| base_timestamps.get(base).copied());
            let context = base_oid
                .as_ref()
                .and_then(|base| context_by_base.get(base))
                .cloned()
                .unwrap_or_default();
            StashEntry {
                index,
                message,
                oid,
                // A stash commit is always created on top of its base, so the
                // base time is the safest stand-in if `%ct` somehow didn't parse.
                timestamp: timestamp.or(base_timestamp).unwrap_or(0),
                base_oid,
                base_timestamp,
                context,
            }
        })
        .collect())
}

fn stash_base_timestamps(repo: &str, base_oids: &[String]) -> HashMap<String, i64> {
    if base_oids.is_empty() {
        return HashMap::new();
    }
    let mut args = vec![
        "show".to_string(),
        "-s".to_string(),
        "--format=%H%x1f%ct".to_string(),
    ];
    args.extend(base_oids.iter().cloned());
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let Ok(raw) = run_git(repo, &arg_refs) else {
        return HashMap::new();
    };

    raw.lines()
        .filter_map(|line| {
            let (oid, timestamp) = line.split_once('\u{1f}')?;
            Some((oid.to_string(), timestamp.parse().ok()?))
        })
        .collect()
}

fn stash_context_commits(repo: &str, base_oid: &str) -> Vec<StashContextCommit> {
    let limit = STASH_CONTEXT_LIMIT.to_string();
    let raw = run_git(
        repo,
        &[
            "log",
            "--first-parent",
            &format!("--max-count={limit}"),
            "--format=%H%x1f%P%x1f%ct%x1f%an%x1f%ae%x1f%s",
            base_oid,
        ],
    );
    let Ok(raw) = raw else {
        return Vec::new();
    };

    raw.lines()
        .filter_map(|line| {
            let mut parts = line.splitn(6, '\u{1f}');
            let id = parts.next()?.to_string();
            let parents = parts
                .next()
                .unwrap_or("")
                .split_whitespace()
                .map(str::to_string)
                .collect();
            let timestamp = parts.next().and_then(|value| value.parse().ok())?;
            let author_name = parts.next().unwrap_or("").to_string();
            let author_email = parts.next().unwrap_or("").to_string();
            let summary = parts.next().unwrap_or("").to_string();
            Some(StashContextCommit {
                short_id: id.chars().take(7).collect(),
                id,
                summary,
                author_name,
                author_email,
                timestamp,
                parents,
            })
        })
        .collect()
}

/// Apply stash `stash@{index}` without dropping it.
pub fn stash_apply(repo: &str, index: usize) -> Result<String, String> {
    run_git(repo, &["stash", "apply", &format!("stash@{{{index}}}")])
}

/// Apply stash `stash@{index}` restoring the staged (index) state too (`--index`).
/// Without `--index` everything lands in the working tree unstaged.
pub fn stash_apply_index(repo: &str, index: usize) -> Result<String, String> {
    run_git(
        repo,
        &["stash", "apply", "--index", &format!("stash@{{{index}}}")],
    )
}

/// Check out `branch` at the stash's original parent commit and apply the stash
/// there (`git stash branch <branch> <stash>`). Useful when the stash no longer
/// applies cleanly on the current branch because history has diverged. Creates
/// the branch if it doesn't exist.
pub fn stash_branch(repo: &str, branch: &str, index: usize) -> Result<String, String> {
    ensure_operand(branch)?;
    run_git(
        repo,
        &["stash", "branch", branch, &format!("stash@{{{index}}}")],
    )
}

/// Apply and drop stash `stash@{index}`.
pub fn stash_pop(repo: &str, index: usize) -> Result<String, String> {
    run_git(repo, &["stash", "pop", &format!("stash@{{{index}}}")])
}

/// Drop stash `stash@{index}`.
pub fn stash_drop(repo: &str, index: usize) -> Result<String, String> {
    run_git(repo, &["stash", "drop", &format!("stash@{{{index}}}")])
}

/// Stage a single file (also stages deletions).
pub fn stage_file(repo: &str, file: &str) -> Result<String, String> {
    run_git(repo, &["add", "-A", "--", file])
}

/// Unstage a single file, restoring it to its HEAD state in the index.
pub fn unstage_file(repo: &str, file: &str) -> Result<String, String> {
    run_git(repo, &["restore", "--staged", "--", file])
}

/// Unstage several files in one atomic invocation (`git restore --staged -- A B…`)
/// so a partial failure can't leave some of the set staged. Paths follow `--`, so
/// a dash-prefixed path cannot be parsed as a flag.
pub fn unstage_files(repo: &str, files: &[String]) -> Result<String, String> {
    if files.is_empty() {
        return Ok(String::new());
    }
    let mut args: Vec<&str> = vec!["restore", "--staged", "--"];
    args.extend(files.iter().map(String::as_str));
    run_git(repo, &args)
}

/// Discard a single file's working-tree changes, reverting it to its HEAD/index
/// state. When `staged` is set the file is unstaged first, then its worktree
/// copy is restored — so "discard" works whether the change is staged or not.
///
/// Whether the file exists in HEAD decides how it's discarded: a file present in
/// HEAD is restored from it; a *new* file (untracked, or staged but never
/// committed — and every file in an unborn repo) has nothing to restore *to*, so
/// its worktree copy is removed with `git clean` instead. This branch is decided
/// up front from `cat-file`, rather than by catching a `git restore` error — so a
/// genuine restore failure on a committed file (a lock, a permission error)
/// surfaces as an error instead of being silently swallowed by the clean
/// fallback and reported as success.
pub fn discard_file(repo: &str, file: &str, staged: bool) -> Result<String, String> {
    // `cat-file -e HEAD:<path>` exits 0 only when the path resolves in HEAD; it
    // fails for a new path and for an unborn repo (no HEAD at all).
    let in_head = run_git(repo, &["cat-file", "-e", &format!("HEAD:{file}")]).is_ok();

    if staged {
        run_git(repo, &["restore", "--staged", "--", file])?;
    }

    if in_head {
        run_git(repo, &["restore", "--worktree", "--", file])?;
        Ok(format!("Discarded changes in {file}"))
    } else {
        // New file: remove the worktree copy (and any untracked dir it created).
        run_git(repo, &["clean", "-f", "-d", "--", file])?;
        Ok(format!("Discarded {file}"))
    }
}

/// Stage every change in the working tree.
pub fn stage_all(repo: &str) -> Result<String, String> {
    run_git(repo, &["add", "-A"])
}

/// Unstage everything, resetting the index to HEAD.
pub fn unstage_all(repo: &str) -> Result<String, String> {
    run_git(repo, &["reset", "-q", "HEAD"])
}

/// Create a commit. `description` (when non-empty) becomes a second message
/// paragraph; `amend` rewrites the previous commit instead.
///
/// When `name`/`email` are given they are pinned via `-c user.name`/
/// `-c user.email`, which sets **both author and committer** for this one
/// invocation — so a GitLane commit always uses the repo's bound identity
/// regardless of what global/local git config (or another tool) has set.
pub fn commit(
    repo: &str,
    summary: &str,
    description: &str,
    amend: bool,
    name: Option<&str>,
    email: Option<&str>,
) -> Result<String, String> {
    let mut args: Vec<String> = Vec::new();
    if let (Some(n), Some(e)) = (name, email) {
        if !n.is_empty() && !e.is_empty() {
            args.push("-c".into());
            args.push(format!("user.name={n}"));
            args.push("-c".into());
            args.push(format!("user.email={e}"));
        }
    }
    args.push("commit".into());
    if amend {
        args.push("--amend".into());
    }
    args.push("-m".into());
    args.push(summary.into());
    if !description.is_empty() {
        args.push("-m".into());
        args.push(description.into());
    }
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run_git(repo, &arg_refs)
}

/// Stash the working tree and index.
pub fn stash(repo: &str) -> Result<String, String> {
    run_git(repo, &["stash", "push"])
}

/// Pull from the upstream remote without creating a merge commit. Divergence
/// fails explicitly so the user can choose merge or rebase from the graph.
pub fn pull(repo: &str) -> Result<String, String> {
    run_git(repo, &["pull", "--ff-only"])
}

/// Push to the upstream remote (shells out — libgit2 has no network here).
///
/// When `token` is set (the repo is bound to an account), it is exported as
/// `GH_TOKEN` and `gh`'s git-credential helper is wired in inline, so the push
/// authenticates as that specific account regardless of the global git
/// credential helper.
pub fn push(repo: &str, auth: Option<(&str, &str)>) -> Result<String, String> {
    match auth {
        Some((host, token)) => {
            let args = credential_args(host, &["push"]);
            let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
            run_git_env(repo, &arg_refs, &[("GH_TOKEN", token)])
        }
        None => run_git(repo, &["push"]),
    }
}

/// Push a specific `branch` without checking it out first (shells out — libgit2
/// has no network here). Pushes to the branch's configured remote
/// (`branch.<name>.remote`), falling back to `origin` when none is set, and
/// honours a divergent upstream branch name (`branch.<name>.merge`) so a local
/// branch tracking a differently-named remote branch still lands on the right
/// ref. Does **not** set upstream — use [`set_upstream`] for that. `token` is
/// wired in exactly as [`push`] does, so it authenticates as the bound account.
pub fn push_branch(repo: &str, branch: &str, auth: Option<(&str, &str)>) -> Result<String, String> {
    // `branch` becomes a positional refspec in `git push <remote> <refspec>`, so
    // guard it against option injection (e.g. --receive-pack=…) like the others.
    ensure_operand(branch)?;
    let (remote, refspec) = push_target(repo, branch);
    match auth {
        Some((host, token)) => {
            let args = credential_args(host, &["push", &remote, &refspec]);
            let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
            run_git_env(repo, &arg_refs, &[("GH_TOKEN", token)])
        }
        None => run_git(repo, &["push", &remote, &refspec]),
    }
}

/// Resolve where `branch` pushes: its configured remote (`branch.<name>.remote`,
/// falling back to `origin`) and refspec (honouring a divergent upstream branch
/// name via `branch.<name>.merge`, else a plain `<branch>`). Shared by
/// [`push_branch`] and [`force_push`] so both target exactly one ref rather than
/// deferring to `push.default`. Both config reads exit non-zero when unset, which
/// `.ok()` turns into the fallback.
fn push_target(repo: &str, branch: &str) -> (String, String) {
    let remote = run_git(repo, &["config", &format!("branch.{branch}.remote")])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "origin".to_string());
    let refspec = run_git(repo, &["config", &format!("branch.{branch}.merge")])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(|merge| format!("{branch}:{merge}"))
        .unwrap_or_else(|| branch.to_string());
    (remote, refspec)
}

/// Fetch from all remotes and prune deleted upstream refs (shells out — libgit2
/// has no network here). When `token` is set (the repo is bound to an account)
/// it authenticates as that account via the same inline `gh` git-credential
/// wiring as [`push`], so private remotes resolve under the right identity.
pub fn fetch(repo: &str, auth: Option<(&str, &str)>) -> Result<String, String> {
    match auth {
        Some((host, token)) => {
            let args = credential_args(host, &["fetch", "--all", "--prune"]);
            let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
            run_git_env(repo, &arg_refs, &[("GH_TOKEN", token)])
        }
        None => run_git(repo, &["fetch", "--all", "--prune"]),
    }
}

/// Delete a local tag (`git tag -d <name>`). The tag ref is removed locally
/// only; the remote copy (if any) is untouched — use [`push_tag`] semantics in
/// reverse via the CLI for that.
pub fn delete_tag(repo: &str, name: &str) -> Result<String, String> {
    ensure_operand(name)?;
    run_git(repo, &["tag", "-d", name])?;
    Ok(format!("Deleted tag {name}"))
}

/// Push a tag to `remote` (`git push <remote> refs/tags/<name>`). The explicit
/// `refs/tags/` refspec avoids any ambiguity with a same-named branch. `auth` is
/// wired in exactly as [`push`] does, so it authenticates as the bound account.
pub fn push_tag(
    repo: &str,
    name: &str,
    remote: &str,
    auth: Option<(&str, &str)>,
) -> Result<String, String> {
    ensure_operand(name)?;
    ensure_operand(remote)?;
    let refspec = format!("refs/tags/{name}");
    match auth {
        Some((host, token)) => {
            let args = credential_args(host, &["push", remote, &refspec]);
            let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
            run_git_env(repo, &arg_refs, &[("GH_TOKEN", token)])
        }
        None => run_git(repo, &["push", remote, &refspec]),
    }
}

/// Remove a linked worktree (`git worktree remove <path>`). `force` adds
/// `--force`, dropping git's dirty/locked safety check. Git refuses to remove the
/// main worktree, surfacing its own error; the frontend also hides the action there.
pub fn remove_worktree(repo: &str, worktree_path: &str, force: bool) -> Result<String, String> {
    ensure_operand(worktree_path)?;
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(worktree_path);
    run_git(repo, &args)?;
    Ok(format!("Removed worktree {worktree_path}"))
}

/// Delete a branch on `remote` (`git push <remote> --delete <branch>`). `branch`
/// is the short name on the remote (e.g. `feature/x`, not `origin/feature/x`).
/// `auth` authenticates as the bound account, like [`push`].
pub fn delete_remote_branch(
    repo: &str,
    remote: &str,
    branch: &str,
    auth: Option<(&str, &str)>,
) -> Result<String, String> {
    ensure_operand(remote)?;
    ensure_operand(branch)?;
    match auth {
        Some((host, token)) => {
            let args = credential_args(host, &["push", remote, "--delete", branch]);
            let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
            run_git_env(repo, &arg_refs, &[("GH_TOKEN", token)])
        }
        None => run_git(repo, &["push", remote, "--delete", branch]),
    }
}

/// Force-push a single `branch` with `--force-with-lease` — the *safe* force:
/// git refuses if the remote advanced since our last fetch, so a teammate's push
/// is never silently clobbered. Used after history is rewritten (amend, reset,
/// rebase) on an already-pushed branch.
///
/// An explicit `<remote> <refspec>` is always supplied (via [`push_target`]) so
/// the force applies to **only** the selected branch. A bare `git push
/// --force-with-lease` would defer to `push.default`/configured refspecs and
/// could rewrite several remote branches at once. `auth` is wired in as
/// [`push`] does.
pub fn force_push(repo: &str, branch: &str, auth: Option<(&str, &str)>) -> Result<String, String> {
    ensure_operand(branch)?;
    let (remote, refspec) = push_target(repo, branch);
    match auth {
        Some((host, token)) => {
            let args = credential_args(host, &["push", "--force-with-lease", &remote, &refspec]);
            let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
            run_git_env(repo, &arg_refs, &[("GH_TOKEN", token)])
        }
        None => run_git(repo, &["push", "--force-with-lease", &remote, &refspec]),
    }
}

/// Discard *all* uncommitted changes: reset tracked files to HEAD and remove
/// untracked files/directories (`git reset --hard HEAD` + `git clean -fd`).
/// Irreversible — the frontend gates this behind a confirmation.
///
/// An unborn repo (no HEAD yet) has no commit to reset to, but staged "added"
/// files are tracked in the *index*, so `git clean` alone would leave them
/// behind. Empty the index first (`git read-tree --empty`) so those files become
/// untracked and get cleaned with everything else.
pub fn discard_all(repo: &str) -> Result<String, String> {
    let has_head = run_git(repo, &["rev-parse", "--verify", "--quiet", "HEAD"]).is_ok();
    if has_head {
        run_git(repo, &["reset", "--hard", "HEAD"])?;
    } else {
        run_git(repo, &["read-tree", "--empty"])?;
    }
    run_git(repo, &["clean", "-f", "-d"])?;
    Ok("Discarded all changes".to_string())
}

fn credential_args(host: &str, command: &[&str]) -> Vec<String> {
    let mut args = vec![
        "-c".to_string(),
        format!("credential.https://{host}.helper="),
        "-c".to_string(),
        format!("credential.https://{host}.helper=!gh auth git-credential"),
    ];
    args.extend(command.iter().map(|arg| (*arg).to_string()));
    args
}

/// Bind a repo's commit identity by writing `user.name`/`user.email` into its
/// local git config, so commits are authored as the associated account.
pub fn set_repo_identity(repo: &str, name: &str, email: &str) -> Result<String, String> {
    run_git(repo, &["config", "--local", "user.name", name])?;
    run_git(repo, &["config", "--local", "user.email", email])?;
    Ok(format!("Identity set to {name} <{email}>"))
}

/// Remove the pinned commit identity from a repo's local git config so it
/// defers to global config again (the "No identity" choice). Best-effort:
/// `--unset` on an already-absent key exits non-zero, which is the desired end
/// state, so unset failures aren't surfaced as errors.
pub fn clear_repo_identity(repo: &str) -> Result<String, String> {
    let _ = run_git(repo, &["config", "--local", "--unset", "user.name"]);
    let _ = run_git(repo, &["config", "--local", "--unset", "user.email"]);
    Ok("Identity cleared".into())
}

#[cfg(test)]
mod tests {
    use super::{
        abort_operation, accept_conflict_side, conflict_stage_absent, continue_operation,
        discard_all, ensure_operand, is_empty_after_resolution, mark_conflict_resolved,
        reconflict_file, resolve_conflict_file, skip_operation, worktree_path,
    };
    use std::path::PathBuf;
    use std::process::Command;
    use std::sync::atomic::{AtomicU32, Ordering};

    #[test]
    fn rejects_dash_prefixed_operands() {
        // Option-injection vectors a malicious ref / raw input could carry into git.
        assert!(ensure_operand("--upload-pack=touch /tmp/x").is_err());
        assert!(ensure_operand("--exec=rm -rf /").is_err());
        assert!(ensure_operand("-D").is_err());
    }

    #[test]
    fn allows_legitimate_refs_and_oids() {
        for ok in ["main", "feature/GP-3-foo", "origin/main", "2fe77a5abf25", "v1.2.3"] {
            assert!(ensure_operand(ok).is_ok(), "{ok} should be allowed");
        }
    }

    /// A throwaway temp directory that cleans itself up on drop — keeps the test
    /// dependency-free (no `tempfile` dev-dep) while never leaking dirs.
    struct TempRepo(PathBuf);
    impl TempRepo {
        fn new(tag: &str) -> Self {
            static SEQ: AtomicU32 = AtomicU32::new(0);
            let n = SEQ.fetch_add(1, Ordering::Relaxed);
            let dir = std::env::temp_dir().join(format!("gitlane-{tag}-{}-{n}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            TempRepo(dir)
        }
        fn path(&self) -> &str {
            self.0.to_str().unwrap()
        }
        fn git(&self, args: &[&str]) -> std::process::Output {
            Command::new("git")
                .arg("-C")
                .arg(&self.0)
                .args(args)
                .output()
                .expect("git launches in tests")
        }
    }
    impl Drop for TempRepo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn discard_all_clears_staged_files_in_unborn_repo() {
        let repo = TempRepo::new("discard");
        repo.git(&["init", "-q"]);
        // Stage a file *before any commit* — the regression case: with no HEAD,
        // `reset --hard` is skipped, and the file is tracked in the index so a
        // plain `git clean` would leave it behind.
        std::fs::write(repo.0.join("staged.txt"), b"hello").unwrap();
        repo.git(&["add", "staged.txt"]);

        let result = discard_all(repo.path());
        assert!(result.is_ok(), "discard_all failed: {result:?}");

        // Both the worktree copy and the index entry must be gone.
        assert!(!repo.0.join("staged.txt").exists(), "worktree file survived discard");
        let status = repo.git(&["status", "--porcelain"]);
        let out = String::from_utf8_lossy(&status.stdout);
        assert!(out.trim().is_empty(), "repo not clean after discard: {out:?}");
    }

    #[test]
    fn empty_after_resolution_matches_only_the_empty_phrase() {
        // git's actual empty-patch message — must match.
        assert!(is_empty_after_resolution(
            "The previous cherry-pick is now empty, possibly due to conflict resolution."
        ));
        assert!(is_empty_after_resolution("The previous revert is now empty."));
        // Unrelated --continue failures must NOT be mistaken for "empty" (which
        // would silently --skip a patch the user wanted to keep).
        assert!(!is_empty_after_resolution(
            "error: Committing is not possible because you have unmerged files."
        ));
        assert!(!is_empty_after_resolution("nothing to commit, working tree clean"));
        assert!(!is_empty_after_resolution("hook rejected the commit"));
    }

    #[test]
    fn worktree_path_rejects_escapes_and_accepts_relative() {
        let root = "/tmp/repo";
        assert!(worktree_path(root, "src/a.ts").is_ok());
        assert!(worktree_path(root, "nested/dir/file.txt").is_ok());
        assert!(worktree_path(root, "../escape.txt").is_err());
        assert!(worktree_path(root, "a/../../escape.txt").is_err());
        assert!(worktree_path(root, "/etc/passwd").is_err());
    }

    /// Build a modify/delete conflict: `base` committed, then HEAD modifies the
    /// file while the merged branch deletes it. Returns the repo with the merge
    /// stopped on the conflict (stage 2 = ours present, stage 3 = theirs absent).
    fn modify_delete_repo(tag: &str) -> TempRepo {
        let repo = TempRepo::new(tag);
        repo.git(&["init", "-q", "-b", "main"]);
        repo.git(&["config", "user.email", "t@t.t"]);
        repo.git(&["config", "user.name", "T"]);
        repo.git(&["config", "commit.gpgsign", "false"]);
        std::fs::write(repo.0.join("f.txt"), b"base\n").unwrap();
        repo.git(&["add", "f.txt"]);
        repo.git(&["commit", "-qm", "base"]);
        repo.git(&["checkout", "-q", "-b", "other"]);
        repo.git(&["rm", "-q", "f.txt"]);
        repo.git(&["commit", "-qm", "delete"]);
        repo.git(&["checkout", "-q", "main"]);
        std::fs::write(repo.0.join("f.txt"), b"ours-modified\n").unwrap();
        repo.git(&["commit", "-qam", "modify"]);
        // Merge stops on the modify/delete conflict.
        let _ = repo.git(&["merge", "other"]);
        repo
    }

    #[test]
    fn conflict_stage_absent_reflects_the_deleted_side() {
        let repo = modify_delete_repo("stage-absent");
        // Ours (stage 2) is present (we modified); theirs (stage 3) is absent
        // (they deleted). The guard must report exactly that, so a checkout
        // failure on the *present* side never falls through to `git rm`.
        assert!(!conflict_stage_absent(repo.path(), "f.txt", "2"), "ours stage should be present");
        assert!(conflict_stage_absent(repo.path(), "f.txt", "3"), "theirs stage should be absent");
    }

    #[test]
    fn accept_conflict_side_keeps_modified_side() {
        let repo = modify_delete_repo("keep-ours");
        // Accept ours: the modified version is checked out and staged, file kept.
        let result = accept_conflict_side(repo.path(), "f.txt", "ours");
        assert!(result.is_ok(), "accept ours failed: {result:?}");
        assert_eq!(std::fs::read_to_string(repo.0.join("f.txt")).unwrap(), "ours-modified\n");
        // No unmerged entries remain for the file.
        let unmerged = repo.git(&["ls-files", "-u", "--", "f.txt"]);
        assert!(String::from_utf8_lossy(&unmerged.stdout).trim().is_empty());
    }

    #[test]
    fn accept_conflict_side_takes_deletion_when_stage_absent() {
        let repo = modify_delete_repo("take-theirs");
        // Accept theirs (the deletion): checkout --theirs fails because stage 3
        // is absent, and ONLY then do we fall back to `git rm`.
        let result = accept_conflict_side(repo.path(), "f.txt", "theirs");
        assert!(result.is_ok(), "accept theirs failed: {result:?}");
        assert!(!repo.0.join("f.txt").exists(), "file should be removed");
    }

    #[test]
    fn resolution_commands_reject_non_conflicted_paths() {
        // A normal committed file is a perfectly safe relative path, but it is
        // NOT in the conflict set — the resolution commands must refuse it so a
        // renderer can only act on genuinely-conflicted files.
        let repo = TempRepo::new("not-conflicted");
        repo.git(&["init", "-q", "-b", "main"]);
        repo.git(&["config", "user.email", "t@t.t"]);
        repo.git(&["config", "user.name", "T"]);
        repo.git(&["config", "commit.gpgsign", "false"]);
        std::fs::write(repo.0.join("clean.txt"), b"hi\n").unwrap();
        repo.git(&["add", "clean.txt"]);
        repo.git(&["commit", "-qm", "init"]);

        assert!(accept_conflict_side(repo.path(), "clean.txt", "ours").is_err());
        assert!(resolve_conflict_file(repo.path(), "clean.txt", "x\n").is_err());
        assert!(mark_conflict_resolved(repo.path(), "clean.txt").is_err());
        // The clean file must be untouched by the rejected write.
        assert_eq!(std::fs::read_to_string(repo.0.join("clean.txt")).unwrap(), "hi\n");
    }

    /// Build a content conflict: `base` committed, then `other` and `main` change
    /// the same line. Returns the repo with the merge stopped on the conflict.
    fn merge_conflict_repo(tag: &str) -> TempRepo {
        let repo = TempRepo::new(tag);
        repo.git(&["init", "-q", "-b", "main"]);
        repo.git(&["config", "user.email", "t@t.t"]);
        repo.git(&["config", "user.name", "T"]);
        repo.git(&["config", "commit.gpgsign", "false"]);
        std::fs::write(repo.0.join("f.txt"), b"line1\nbase\nline3\n").unwrap();
        repo.git(&["add", "f.txt"]);
        repo.git(&["commit", "-qm", "base"]);
        repo.git(&["checkout", "-q", "-b", "other"]);
        std::fs::write(repo.0.join("f.txt"), b"line1\ntheirs\nline3\n").unwrap();
        repo.git(&["commit", "-qam", "theirs"]);
        repo.git(&["checkout", "-q", "main"]);
        std::fs::write(repo.0.join("f.txt"), b"line1\nours\nline3\n").unwrap();
        repo.git(&["commit", "-qam", "ours"]);
        // Merge stops on the content conflict in f.txt.
        let _ = repo.git(&["merge", "other"]);
        repo
    }

    #[test]
    fn continue_operation_completes_a_resolved_merge() {
        let repo = merge_conflict_repo("continue");
        // Resolve + stage via the in-app write path, then continue.
        resolve_conflict_file(repo.path(), "f.txt", "line1\nmerged\nline3\n").unwrap();
        let result = continue_operation(repo.path(), "merge", Some("T"), Some("t@t.t"));
        assert!(result.is_ok(), "continue failed: {result:?}");
        // No conflicts remain and HEAD is a merge commit (two parents).
        let unmerged = repo.git(&["ls-files", "-u"]);
        assert!(String::from_utf8_lossy(&unmerged.stdout).trim().is_empty());
        let parents = repo.git(&["rev-list", "--parents", "-n", "1", "HEAD"]);
        let line = String::from_utf8_lossy(&parents.stdout);
        // "<commit> <parent1> <parent2>" → 3 hashes for a merge commit.
        assert_eq!(line.split_whitespace().count(), 3, "expected a merge commit: {line:?}");
    }

    #[test]
    fn abort_operation_restores_pre_merge_state() {
        let repo = merge_conflict_repo("abort");
        let result = abort_operation(repo.path(), "merge");
        assert!(result.is_ok(), "abort failed: {result:?}");
        // Worktree returns to our pre-merge content and the tree is clean.
        assert_eq!(
            std::fs::read_to_string(repo.0.join("f.txt")).unwrap(),
            "line1\nours\nline3\n"
        );
        let status = repo.git(&["status", "--porcelain"]);
        assert!(String::from_utf8_lossy(&status.stdout).trim().is_empty());
    }

    #[test]
    fn skip_operation_rejects_merge() {
        // Merge has no `--skip`; only sequencer ops do. The path is never touched.
        assert!(skip_operation("/tmp", "merge").is_err());
        assert!(skip_operation("/tmp", "nonsense").is_err());
    }

    #[test]
    fn reconflict_file_restores_markers_after_staging() {
        let repo = merge_conflict_repo("reconflict");
        // Stage a resolution — the path is now merged (stage 0), not unmerged.
        resolve_conflict_file(repo.path(), "f.txt", "line1\nmerged\nline3\n").unwrap();
        let staged = repo.git(&["ls-files", "-u", "--", "f.txt"]);
        assert!(String::from_utf8_lossy(&staged.stdout).trim().is_empty());
        // Unstage: `git checkout --merge` recreates the conflict even after add.
        let result = reconflict_file(repo.path(), "f.txt");
        assert!(result.is_ok(), "reconflict failed: {result:?}");
        let unmerged = repo.git(&["ls-files", "-u", "--", "f.txt"]);
        assert!(!String::from_utf8_lossy(&unmerged.stdout).trim().is_empty());
        let body = std::fs::read_to_string(repo.0.join("f.txt")).unwrap();
        assert!(body.contains("<<<<<<<") && body.contains(">>>>>>>"));
    }

    #[test]
    fn reconflict_file_rejected_outside_an_operation() {
        // With no merge/rebase/etc. underway there is no conflict to recreate;
        // `git checkout --merge` would just overwrite the worktree file with the
        // index copy, so the guard must refuse rather than risk clobbering edits.
        let repo = TempRepo::new("reconflict-clean");
        repo.git(&["init", "-q", "-b", "main"]);
        repo.git(&["config", "user.email", "t@t.t"]);
        repo.git(&["config", "user.name", "T"]);
        repo.git(&["config", "commit.gpgsign", "false"]);
        std::fs::write(repo.0.join("f.txt"), b"hi\n").unwrap();
        repo.git(&["add", "f.txt"]);
        repo.git(&["commit", "-qm", "init"]);
        let result = reconflict_file(repo.path(), "f.txt");
        assert!(result.is_err(), "expected refusal outside an operation: {result:?}");
    }

    #[test]
    fn resolves_a_dash_prefixed_conflicted_path() {
        // A tracked file named `-foo` can legitimately conflict. Every per-file
        // command passes the path after `--`, so it must resolve rather than be
        // rejected by the option-injection dash-guard.
        let repo = TempRepo::new("dash-conflict");
        repo.git(&["init", "-q", "-b", "main"]);
        repo.git(&["config", "user.email", "t@t.t"]);
        repo.git(&["config", "user.name", "T"]);
        repo.git(&["config", "commit.gpgsign", "false"]);
        std::fs::write(repo.0.join("-foo"), b"base\n").unwrap();
        repo.git(&["add", "--", "-foo"]);
        repo.git(&["commit", "-qm", "base"]);
        repo.git(&["checkout", "-q", "-b", "other"]);
        std::fs::write(repo.0.join("-foo"), b"theirs\n").unwrap();
        repo.git(&["commit", "-qam", "theirs"]);
        repo.git(&["checkout", "-q", "main"]);
        std::fs::write(repo.0.join("-foo"), b"ours\n").unwrap();
        repo.git(&["commit", "-qam", "ours"]);
        let _ = repo.git(&["merge", "other"]);
        let result = resolve_conflict_file(repo.path(), "-foo", "merged\n");
        assert!(result.is_ok(), "dash-prefixed path should resolve: {result:?}");
        let unmerged = repo.git(&["ls-files", "-u", "--", "-foo"]);
        assert!(String::from_utf8_lossy(&unmerged.stdout).trim().is_empty());
    }
}
