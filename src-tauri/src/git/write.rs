//! Mutating git operations.
//!
//! These intentionally shell out to the user's real `git` binary rather than
//! using libgit2. The CLI honours hooks, credential helpers, `.gitconfig`,
//! signing, and the full conflict machinery — all of which libgit2 wrappers
//! reimplement only partially. These back the drag-and-drop branch actions.

use crate::git::types::{
    DestructivePreview, ReflogEntry, StashContextCommit, StashEntry, WorktreeInfo,
};
use std::collections::{HashMap, HashSet};
use std::process::Command;

const STASH_CONTEXT_LIMIT: usize = 8;
const TAG_FETCH_REFSPEC: &str = "refs/tags/*:refs/tags/*";

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

fn run_git_env_stable_diagnostics(
    repo: &str,
    args: &[&str],
    envs: &[(&str, &str)],
) -> Result<String, String> {
    let mut stable_envs = Vec::with_capacity(envs.len() + 2);
    stable_envs.extend_from_slice(envs);
    stable_envs.push(("LC_ALL", "C"));
    stable_envs.push(("LANG", "C"));
    run_git_env(repo, args, &stable_envs)
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

/// True when `git checkout --merge` can actually recreate a conflict for `file`:
/// it is still unmerged, or git holds **resolve-undo** information for it from an
/// earlier resolution in the current operation. For any other tracked path
/// `checkout --merge` would silently overwrite the worktree with the index copy,
/// discarding unstaged edits — so those must be refused. `git ls-files
/// --resolve-undo` is git's own record of paths it can re-conflict.
fn can_reconflict(repo: &str, file: &str) -> bool {
    if is_unmerged(repo, file) {
        return true;
    }
    run_git(repo, &["ls-files", "--resolve-undo", "--", file])
        .map(|out| !out.trim().is_empty())
        .unwrap_or(false)
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
        return Err(format!(
            "refusing unsafe path outside the worktree: {file:?}"
        ));
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
    // Guard against clobbering: `git checkout --merge` on a path git can't
    // re-conflict (an unrelated tracked file) silently overwrites the worktree
    // with the index copy, discarding unstaged edits. Only allow it for paths
    // that are still unmerged or carry resolve-undo info (the inverse of staging
    // a resolution).
    if !can_reconflict(repo, file) {
        return Err(format!(
            "cannot restore the conflict in {file:?} — it is not an unresolved or just-resolved conflict path"
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
    match run_git_env_stable_diagnostics(repo, &args, &[("GIT_EDITOR", "true")]) {
        Ok(out) => Ok(out),
        Err(e) if matches!(kind, "cherry-pick" | "revert") && is_empty_after_resolution(&e) => {
            run_git_env_stable_diagnostics(repo, &[kind, "--skip"], &[("GIT_EDITOR", "true")])
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

/// Publish `branch` to `upstream` (`remote/branch`) and set it as the branch's
/// upstream in one git invocation. Used for first-push flows where the remote
/// tracking ref does not exist yet, so `set_upstream` alone would fail.
pub fn publish_branch(
    repo: &str,
    branch: &str,
    upstream: &str,
    auth: Option<(&str, &str)>,
) -> Result<String, String> {
    ensure_operand(branch)?;
    let (remote, remote_branch) = upstream.split_once('/').ok_or_else(|| {
        "Enter an upstream as remote/branch, for example origin/main.".to_string()
    })?;
    if remote.is_empty() || remote_branch.is_empty() {
        return Err("Enter an upstream as remote/branch, for example origin/main.".to_string());
    }
    ensure_operand(remote)?;
    ensure_operand(remote_branch)?;
    let refspec = format!("refs/heads/{branch}:refs/heads/{remote_branch}");
    match auth {
        Some((host, token)) => {
            let args = credential_args(host, &["push", "--set-upstream", remote, &refspec]);
            let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
            run_git_env(repo, &arg_refs, &[("GH_TOKEN", token)])
        }
        None => run_git(repo, &["push", "--set-upstream", remote, &refspec]),
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

/// Fetch from all remotes, prune deleted upstream refs, and import tags
/// (shells out — libgit2 has no network here). `--tags` is intentional: Git's
/// default tag auto-follow misses remote-only tags in some no-branch-update
/// refreshes, but the UI derives visible tags from local `refs/tags/*`.
///
/// Tags are fetched per remote through an explicit tag-only refspec after a
/// `--no-tags` branch/prune fetch. A remote tag that would clobber an existing
/// local tag is left alone and treated as non-fatal, so the UI still refreshes
/// branch updates and any tags that did import. Other tag-fetch failures still
/// fail the operation. Local-only tags and tags deleted upstream are
/// intentionally preserved unless the user deletes them explicitly: the
/// per-remote tag fetch passes `--no-prune` (its explicit `refs/tags/*` refspec
/// would otherwise prune local-only tags under `fetch.prune=true`), and the
/// branch fetch forces `--no-prune-tags` so a repo with `fetch.pruneTags=true`
/// (or `remote.<name>.pruneTags=true`) and a divergent local tag does not fail
/// the whole Fetch with "would clobber existing tag" before the per-remote
/// loop's clobber tolerance can run.
///
/// When `token` is set (the repo is bound to an account) it authenticates as
/// that account via the same inline `gh` git-credential wiring as [`push`], so
/// private remotes resolve under the right identity.
pub fn fetch(repo: &str, auth: Option<(&str, &str)>) -> Result<String, String> {
    match auth {
        Some((host, token)) => {
            let branch_args = credential_args(
                host,
                &["fetch", "--all", "--prune", "--no-tags", "--no-prune-tags"],
            );
            let branch_arg_refs: Vec<&str> = branch_args.iter().map(String::as_str).collect();
            fetch_with_tag_import(
                repo,
                &branch_arg_refs,
                Some((host, token)),
                &[("GH_TOKEN", token)],
            )
        }
        None => fetch_with_tag_import(
            repo,
            &["fetch", "--all", "--prune", "--no-tags", "--no-prune-tags"],
            None,
            &[],
        ),
    }
}

fn fetch_with_tag_import(
    repo: &str,
    branch_args: &[&str],
    auth: Option<(&str, &str)>,
    envs: &[(&str, &str)],
) -> Result<String, String> {
    let branch_output = run_git_env_stable_diagnostics(repo, branch_args, envs)?;
    let mut output = branch_output;
    for remote in fetch_remotes(repo)? {
        ensure_operand(&remote)?;
        // `--no-prune` is essential: the explicit `refs/tags/*` refspec makes a
        // repo with `fetch.prune=true` (or `remote.<name>.prune=true`) prune
        // local tags absent on this remote, silently deleting the very
        // local-only tags this loop promises to preserve.
        let tag_args = match auth {
            Some((host, _token)) => credential_args(
                host,
                &["fetch", &remote, "--no-tags", "--no-prune", TAG_FETCH_REFSPEC],
            ),
            None => vec![
                "fetch".to_string(),
                remote,
                "--no-tags".to_string(),
                "--no-prune".to_string(),
                TAG_FETCH_REFSPEC.to_string(),
            ],
        };
        let tag_arg_refs: Vec<&str> = tag_args.iter().map(String::as_str).collect();
        match run_git_env_stable_diagnostics(repo, &tag_arg_refs, envs) {
            Ok(tag_output) => output = join_git_outputs(&output, &tag_output),
            Err(e) if is_tag_clobber_rejection(&e) => output = join_git_outputs(&output, &e),
            Err(e) => return Err(e),
        }
    }
    Ok(output)
}

fn fetch_remotes(repo: &str) -> Result<Vec<String>, String> {
    let remotes = run_git(repo, &["remote"])?
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    let mut included = Vec::new();
    for remote in remotes {
        let skip = run_git(
            repo,
            &["config", "--bool", &format!("remote.{remote}.skipFetchAll")],
        )
        .ok()
        .map(|value| value.trim().eq_ignore_ascii_case("true"))
        .unwrap_or(false);
        if !skip {
            included.push(remote);
        }
    }
    Ok(included)
}

fn join_git_outputs(first: &str, second: &str) -> String {
    match (first.trim(), second.trim()) {
        ("", "") => String::new(),
        (a, "") => a.to_string(),
        ("", b) => b.to_string(),
        (a, b) => format!("{a}\n{b}"),
    }
}

fn is_tag_clobber_rejection(output: &str) -> bool {
    output.contains("would clobber existing tag")
        && !output.lines().any(|line| {
            let trimmed = line.trim_start();
            trimmed.starts_with("fatal:") || trimmed.starts_with("error:")
        })
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

/// Recent reflog entries for HEAD and local branches. Uses `git log -g` rather
/// than libgit2 because the CLI's reflog selectors (`HEAD@{1}`) are exactly what
/// users recognise when recovering from a bad reset/checkout.
pub fn reflog_entries(repo: &str, limit: usize) -> Result<Vec<ReflogEntry>, String> {
    // An unborn HEAD makes `git log -g HEAD …` fatal, so short-circuit to an
    // empty list — a repo with no commits has no recovery points to show.
    if run_git(repo, &["rev-parse", "--verify", "--quiet", "HEAD"]).is_err() {
        return Ok(Vec::new());
    }
    let max_count = format!("--max-count={}", limit.max(1));
    // Walk HEAD and local-branch reflogs explicitly instead of `--all`: the dialog
    // is "HEAD and branch movements", and scoping the walk means `--max-count` is
    // spent on recovery entries rather than being eaten by remote-tracking / tag /
    // stash reflogs that `--all` would include (which could starve the list in a
    // fetch-heavy repo). GL-42 review.
    let raw = run_git(
        repo,
        &[
            "log",
            "-g",
            "HEAD",
            "--branches",
            "--date=unix",
            &max_count,
            "--format=%H%x1f%gd%x1f%gD%x1f%gs%x1f%gn%x1f%ge%x1f%ct",
        ],
    )?;
    Ok(raw
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(7, '\u{1f}');
            let oid = parts.next()?.to_string();
            let short_selector = parts.next().unwrap_or("").to_string();
            let selector = parts.next().unwrap_or("").to_string();
            let subject = parts.next().unwrap_or("").to_string();
            let committer_name = parts.next().unwrap_or("").to_string();
            let committer_email = parts.next().unwrap_or("").to_string();
            let commit_timestamp = parts
                .next()
                .and_then(|value| value.parse().ok())
                .unwrap_or(0);
            let selector_for_ref = if selector.is_empty() {
                &short_selector
            } else {
                &selector
            };
            let timestamp =
                reflog_selector_timestamp(selector_for_ref).unwrap_or(commit_timestamp);
            let ref_name = selector_for_ref
                .split("@{")
                .next()
                .unwrap_or("")
                .trim_start_matches("refs/heads/")
                .to_string();
            Some(ReflogEntry {
                short_oid: short_oid(&oid),
                oid,
                selector,
                short_selector,
                ref_name,
                subject,
                committer_name,
                committer_email,
                timestamp,
            })
        })
        .collect())
}

/// Preview a reset of `source` (the ref that will be reset — `HEAD` for the
/// current branch, or a named branch when the caller checks it out first) back
/// to `target`. The impacted commits are those on `source` but not `target`, so
/// the range must be anchored on `source`, not always `HEAD`. GL-42 review.
pub fn preview_reset(
    repo: &str,
    target: &str,
    mode: &str,
    source: &str,
) -> Result<DestructivePreview, String> {
    ensure_operand(target)?;
    ensure_operand(source)?;
    let mode = match mode {
        "soft" | "mixed" | "hard" => mode,
        _ => "mixed",
    };
    // Validate both ends up front. The impact reads below tolerate git failures
    // with `unwrap_or_default()`, so an unresolvable target or source would
    // otherwise yield a confident-looking but empty preview ("No commits are
    // currently ahead of the target"). Fail loudly instead, routing the UI to its
    // error path. GL-42 review.
    run_git(repo, &["rev-parse", "--verify", &format!("{target}^{{commit}}")])?;
    // Qualify a local-branch source to refs/heads so a same-named tag can't shadow
    // it (git ref precedence resolves a bare name to the tag first); HEAD and
    // arbitrary commit-ish sources are validated and used as-is. GL-42 review.
    let source_ref = if source == "HEAD" {
        source.to_string()
    } else if run_git(
        repo,
        &["rev-parse", "--verify", &format!("refs/heads/{source}^{{commit}}")],
    )
    .is_ok()
    {
        format!("refs/heads/{source}")
    } else {
        run_git(repo, &["rev-parse", "--verify", &format!("{source}^{{commit}}")])?;
        source.to_string()
    };
    let target_short = rev_parse_short(repo, target).unwrap_or_else(|| target.to_string());
    let range = format!("{target}..{source_ref}");
    let commits = limited_lines(
        run_git(repo, &["log", "--oneline", "--max-count=8", &range]).unwrap_or_default(),
        8,
    );
    let files = limited_lines(
        run_git(repo, &["diff", "--name-status", &range]).unwrap_or_default(),
        12,
    );
    let mut details = Vec::new();
    // Name the ref that actually moves: HEAD for a current-branch reset, or the
    // specific branch when a non-current branch is being reset. GL-42 review.
    let mover = if source == "HEAD" {
        "Current branch/HEAD".to_string()
    } else {
        source.to_string()
    };
    details.push(format!("{mover} will move to {target_short}."));
    if commits.is_empty() {
        details.push("No commits are currently ahead of the target.".to_string());
    } else {
        details.push(format!(
            "Commits no longer on the branch tip: {}",
            commits.join("; ")
        ));
    }
    if !files.is_empty() {
        details.push(format!(
            "Files changed by those commits: {}",
            files.join("; ")
        ));
    }
    let mut warnings = Vec::new();
    match mode {
        "soft" => details.push("Soft reset keeps those commit changes staged.".to_string()),
        "mixed" => details.push(
            "Mixed reset keeps those commit changes in the working tree, unstaged.".to_string(),
        ),
        "hard" => {
            warnings.push("Hard reset also discards uncommitted tracked-file changes.".to_string());
            // Fail closed on a status read error (mirrors preview_discard_all):
            // silently dropping it could hide a dirty tree before a hard reset.
            // Ordinary untracked files stay put, but untracked files/directories
            // that obstruct tracked files in the target tree can be deleted by
            // `git reset --hard`, so report that narrower set separately.
            let tracked: Vec<String> =
                limited_lines(run_git(repo, &["status", "--porcelain=v1"])?, 16)
                    .into_iter()
                    .filter(|line| !line.starts_with("??"))
                    .collect();
            if !tracked.is_empty() {
                warnings.push(format!(
                    "Uncommitted tracked changes that will be lost: {}",
                    tracked.join("; ")
                ));
            }
            let obstructions = hard_reset_untracked_obstructions(repo, target)?;
            if !obstructions.is_empty() {
                warnings.push(format!(
                    "Untracked files or directories in the target's way that may be deleted: {}",
                    obstructions.join("; ")
                ));
            }
        }
        _ => {}
    }
    warnings.push(
        "The previous HEAD remains recoverable from the reflog while Git keeps it locally."
            .to_string(),
    );
    Ok(DestructivePreview {
        summary: format!("Reset {mode} to {target_short}"),
        details,
        warnings,
    })
}

pub fn preview_discard_all(repo: &str) -> Result<DestructivePreview, String> {
    // Fail closed: read status directly (not the lossy `status_lines`) so a stale
    // or inaccessible repo errors out instead of rendering a misleading "working
    // tree is already clean" before a discard. GL-42 review.
    let status = limited_lines(run_git(repo, &["status", "--porcelain=v1"])?, 16);
    let mut details = Vec::new();
    if status.is_empty() {
        details.push("The working tree is already clean.".to_string());
    } else {
        details.push(format!(
            "Files that will be reset or removed: {}",
            status.join("; ")
        ));
    }
    Ok(DestructivePreview {
        summary: "Discard every staged, unstaged, and untracked working-tree change".to_string(),
        details,
        warnings: vec![
            "Tracked edits may be recoverable only if they were previously committed or stashed."
                .to_string(),
            "Untracked files removed by git clean are not recoverable from the reflog.".to_string(),
        ],
    })
}

pub fn preview_delete_branch(repo: &str, branch: &str) -> Result<DestructivePreview, String> {
    ensure_operand(branch)?;
    // Fail closed on a missing branch (consistent with preview_reset): otherwise
    // the impact reads soft-fail to "unknown"/empty and the dialog looks fine for
    // a branch that doesn't exist. GL-42 review.
    // Use the fully-qualified ref for impact reads: a bare name resolves a same-
    // named tag before the branch (git ref precedence), so it could compute the
    // wrong impact while `git branch -D` deletes the branch. GL-42 review.
    let branch_ref = format!("refs/heads/{branch}");
    run_git(
        repo,
        &["rev-parse", "--verify", &format!("{branch_ref}^{{commit}}")],
    )?;
    let tip = rev_parse_short(repo, &branch_ref).unwrap_or_else(|| "unknown".to_string());
    let unmerged = limited_lines(
        run_git(
            repo,
            &[
                "log",
                "--oneline",
                "--max-count=8",
                &format!("HEAD..{branch_ref}"),
            ],
        )
        .unwrap_or_default(),
        8,
    );
    let mut details = vec![format!("Local branch {branch} points at {tip}.")];
    if unmerged.is_empty() {
        details.push("No commits are shown ahead of the current HEAD.".to_string());
    } else {
        details.push(format!(
            "Commits ahead of current HEAD: {}",
            unmerged.join("; ")
        ));
    }
    Ok(DestructivePreview {
        summary: format!("Delete local branch {branch}"),
        details,
        warnings: vec![
            "The branch ref is removed; commits survive only while another ref or the reflog keeps them reachable.".to_string(),
        ],
    })
}

pub fn preview_delete_remote_branch(
    repo: &str,
    remote: &str,
    branch: &str,
) -> Result<DestructivePreview, String> {
    ensure_operand(remote)?;
    ensure_operand(branch)?;
    let remote_short = format!("{remote}/{branch}");
    // Qualify to refs/remotes for the lookup so a same-named tag/branch can't be
    // resolved instead; keep the short form for display. GL-42 review.
    let remote_ref = format!("refs/remotes/{remote_short}");
    let tip = rev_parse_short(repo, &remote_ref).unwrap_or_else(|| "unknown locally".to_string());
    Ok(DestructivePreview {
        summary: format!("Delete {branch} on {remote}"),
        details: vec![
            format!("Remote-tracking ref {remote_short} currently points at {tip}."),
            "The server-side branch is deleted for everyone using that remote.".to_string(),
        ],
        warnings: vec!["GitLane cannot recover a deleted server-side branch unless its commit is still available locally or on another remote ref.".to_string()],
    })
}

pub fn preview_force_push(repo: &str, branch: &str) -> Result<DestructivePreview, String> {
    ensure_operand(branch)?;
    // Fail closed if the local branch is gone (stale menu / concurrent delete),
    // and use the qualified ref for rev reads so a same-named tag can't be
    // resolved instead. Config reads (push_target/branch_upstream) still take the
    // short branch name, since git config is keyed by it. GL-42 review.
    let branch_ref = format!("refs/heads/{branch}");
    run_git(
        repo,
        &["rev-parse", "--verify", &format!("{branch_ref}^{{commit}}")],
    )?;
    let (remote, refspec) = push_target(repo, branch);
    let upstream = branch_upstream(repo, branch).unwrap_or_else(|| {
        pushed_branch_name(&refspec)
            .map(|name| format!("refs/remotes/{remote}/{name}"))
            .unwrap_or_else(|| format!("refs/remotes/{remote}/{branch}"))
    });
    // `upstream` is derived from git config (remote name / `%(upstream)`), not from
    // a guarded UI operand, yet it flows unquoted into the `git log` rev-ranges
    // below. A config value beginning with `-` would be parsed as an option, so
    // apply the same dash-guard used for user operands. GL-42.
    ensure_operand(&upstream)?;
    // Short form for display only; reads/ranges use the fully-qualified ref so a
    // same-named local branch/tag can't shadow the remote-tracking ref. GL-42.
    let upstream_display = upstream
        .strip_prefix("refs/remotes/")
        .or_else(|| upstream.strip_prefix("refs/heads/"))
        .unwrap_or(upstream.as_str())
        .to_string();
    let local_tip = rev_parse_short(repo, &branch_ref).unwrap_or_else(|| "unknown".to_string());
    let remote_tip =
        rev_parse_short(repo, &upstream).unwrap_or_else(|| "unknown locally".to_string());
    let remote_only = limited_lines(
        run_git(
            repo,
            &[
                "log",
                "--oneline",
                "--max-count=8",
                &format!("{branch_ref}..{upstream}"),
            ],
        )
        .unwrap_or_default(),
        8,
    );
    let local_only = limited_lines(
        run_git(
            repo,
            &[
                "log",
                "--oneline",
                "--max-count=8",
                &format!("{upstream}..{branch_ref}"),
            ],
        )
        .unwrap_or_default(),
        8,
    );
    let mut details = vec![
        format!("Pushes local {branch} ({local_tip}) to {remote} using refspec {refspec}."),
        format!("Local tracking comparison target: {upstream_display} ({remote_tip})."),
    ];
    if !local_only.is_empty() {
        details.push(format!(
            "Local-only commits to publish: {}",
            local_only.join("; ")
        ));
    }
    let mut warnings = vec![
        "--force-with-lease aborts if the remote moved since the local tracking ref was updated."
            .to_string(),
    ];
    if remote_only.is_empty() {
        details.push("No remote-only commits are visible from the local tracking ref.".to_string());
    } else {
        warnings.push(format!(
            "Remote-only commits that may be replaced: {}",
            remote_only.join("; ")
        ));
    }
    Ok(DestructivePreview {
        summary: format!("Force-push {branch} with lease"),
        details,
        warnings,
    })
}

fn short_oid(oid: &str) -> String {
    oid.chars().take(7).collect()
}

fn rev_parse_short(repo: &str, rev: &str) -> Option<String> {
    ensure_operand(rev).ok()?;
    run_git(repo, &["rev-parse", "--short", rev])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn limited_lines(raw: String, limit: usize) -> Vec<String> {
    let mut lines: Vec<String> = raw
        .lines()
        .filter(|line| !line.trim().is_empty())
        .take(limit + 1)
        .map(|line| line.trim().to_string())
        .collect();
    if lines.len() > limit {
        lines.truncate(limit);
        lines.push("…".to_string());
    }
    lines
}

fn path_conflicts_with_reset_target(untracked: &str, target_path: &str) -> bool {
    untracked == target_path
        || untracked
            .strip_prefix(target_path)
            .is_some_and(|rest| rest.starts_with('/'))
        || target_path
            .strip_prefix(untracked)
            .is_some_and(|rest| rest.starts_with('/'))
}

fn hard_reset_untracked_obstructions(repo: &str, target: &str) -> Result<Vec<String>, String> {
    let target_tree = format!("{target}^{{tree}}");
    let target_paths: Vec<String> = run_git(repo, &["ls-tree", "-r", "--name-only", &target_tree])?
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(str::to_string)
        .collect();
    let untracked_paths: Vec<String> =
        run_git(repo, &["ls-files", "--others", "--exclude-standard"])?
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(str::to_string)
            .collect();

    let mut seen = HashSet::new();
    let mut obstructions = Vec::new();
    for untracked in untracked_paths {
        if target_paths
            .iter()
            .any(|target_path| path_conflicts_with_reset_target(&untracked, target_path))
            && seen.insert(untracked.clone())
        {
            obstructions.push(format!("?? {untracked}"));
        }
    }
    Ok(obstructions.into_iter().take(16).collect())
}

fn reflog_selector_timestamp(selector: &str) -> Option<i64> {
    let start = selector.rfind("@{")? + 2;
    let end = selector[start..].find('}')? + start;
    selector[start..end].parse().ok()
}

/// The fully-qualified upstream ref (e.g. `refs/remotes/origin/main`) of a local
/// branch, or `None` if it has no upstream. The full form (not `%(upstream:short)`)
/// is used so impact reads can't be shadowed by a same-named local branch/tag.
fn branch_upstream(repo: &str, branch: &str) -> Option<String> {
    run_git(
        repo,
        &[
            "for-each-ref",
            "--format=%(upstream)",
            &format!("refs/heads/{branch}"),
        ],
    )
    .ok()
    .map(|s| s.trim().to_string())
    .filter(|s| !s.is_empty())
}

fn pushed_branch_name(refspec: &str) -> Option<&str> {
    // The destination side of a `src:dst` refspec, or the whole spec when there's
    // no colon; with any `refs/heads/` prefix stripped.
    let dst = refspec.split(':').nth(1).unwrap_or(refspec);
    Some(dst.strip_prefix("refs/heads/").unwrap_or(dst))
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
        discard_all, ensure_operand, fetch, is_empty_after_resolution, is_tag_clobber_rejection,
        mark_conflict_resolved, preview_delete_branch, preview_delete_remote_branch,
        preview_discard_all, preview_force_push, preview_reset, publish_branch, reconflict_file,
        reflog_entries, resolve_conflict_file, set_upstream, skip_operation, worktree_path,
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
        for ok in [
            "main",
            "feature/GP-3-foo",
            "origin/main",
            "2fe77a5abf25",
            "v1.2.3",
        ] {
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
            let dir =
                std::env::temp_dir().join(format!("gitlane-{tag}-{}-{n}", std::process::id()));
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
        fn git_ok(&self, args: &[&str]) {
            let out = self.git(args);
            assert!(
                out.status.success(),
                "git {:?} failed\nstdout:\n{}\nstderr:\n{}",
                args,
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr),
            );
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
        assert!(
            !repo.0.join("staged.txt").exists(),
            "worktree file survived discard"
        );
        let status = repo.git(&["status", "--porcelain"]);
        let out = String::from_utf8_lossy(&status.stdout);
        assert!(
            out.trim().is_empty(),
            "repo not clean after discard: {out:?}"
        );
    }

    #[test]
    fn fetch_imports_remote_only_tags() {
        let root = TempRepo::new("fetch-tags-root");
        let origin = root.0.join("origin.git");
        let source = root.0.join("source");
        let clone = root.0.join("clone");

        Command::new("git")
            .args(["init", "--bare", "-q", origin.to_str().unwrap()])
            .output()
            .expect("git init bare launches");
        Command::new("git")
            .args(["init", "-q", source.to_str().unwrap()])
            .output()
            .expect("git init launches");

        let source_repo = TempRepo(source);
        source_repo.git_ok(&["config", "user.name", "GitLane Test"]);
        source_repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
        source_repo.git_ok(&["config", "commit.gpgsign", "false"]);
        std::fs::write(source_repo.0.join("file.txt"), b"v1\n").unwrap();
        source_repo.git_ok(&["add", "file.txt"]);
        source_repo.git_ok(&["commit", "-q", "-m", "initial"]);
        source_repo.git_ok(&["tag", "0.1.1"]);
        source_repo.git_ok(&["remote", "add", "origin", origin.to_str().unwrap()]);
        source_repo.git_ok(&["push", "-q", "origin", "HEAD:main"]);
        source_repo.git_ok(&["push", "-q", "origin", "refs/tags/0.1.1"]);
        let head_out = Command::new("git")
            .arg("-C")
            .arg(&origin)
            .args(["symbolic-ref", "HEAD", "refs/heads/main"])
            .output()
            .expect("git symbolic-ref launches");
        assert!(
            head_out.status.success(),
            "setting origin HEAD failed\nstdout:\n{}\nstderr:\n{}",
            String::from_utf8_lossy(&head_out.stdout),
            String::from_utf8_lossy(&head_out.stderr),
        );

        let clone_out = Command::new("git")
            .args([
                "clone",
                "--no-tags",
                "-q",
                origin.to_str().unwrap(),
                clone.to_str().unwrap(),
            ])
            .output()
            .expect("git clone launches");
        assert!(
            clone_out.status.success(),
            "clone failed\nstdout:\n{}\nstderr:\n{}",
            String::from_utf8_lossy(&clone_out.stdout),
            String::from_utf8_lossy(&clone_out.stderr),
        );
        let clone_repo = TempRepo(clone);
        let before = clone_repo.git(&["tag", "--list", "0.1.1"]);
        assert!(
            String::from_utf8_lossy(&before.stdout).trim().is_empty(),
            "test setup should start with the remote tag absent locally",
        );

        let result = fetch(clone_repo.path(), None);
        assert!(result.is_ok(), "fetch failed: {result:?}");

        let after = clone_repo.git(&["tag", "--list", "0.1.1"]);
        assert_eq!(String::from_utf8_lossy(&after.stdout).trim(), "0.1.1");
    }

    #[test]
    fn fetch_tag_import_honors_skip_fetch_all_remotes() {
        let root = TempRepo::new("fetch-skip-remote-root");
        let origin = root.0.join("origin.git");
        let source = root.0.join("source");
        let clone = root.0.join("clone");
        let unreachable = root.0.join("missing.git");

        Command::new("git")
            .args(["init", "--bare", "-q", origin.to_str().unwrap()])
            .output()
            .expect("git init bare launches");
        Command::new("git")
            .args(["init", "-q", source.to_str().unwrap()])
            .output()
            .expect("git init launches");

        let source_repo = TempRepo(source);
        source_repo.git_ok(&["config", "user.name", "GitLane Test"]);
        source_repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
        source_repo.git_ok(&["config", "commit.gpgsign", "false"]);
        std::fs::write(source_repo.0.join("file.txt"), b"v1\n").unwrap();
        source_repo.git_ok(&["add", "file.txt"]);
        source_repo.git_ok(&["commit", "-q", "-m", "initial"]);
        source_repo.git_ok(&["tag", "0.1.1"]);
        source_repo.git_ok(&["remote", "add", "origin", origin.to_str().unwrap()]);
        source_repo.git_ok(&["push", "-q", "origin", "HEAD:main"]);
        source_repo.git_ok(&["push", "-q", "origin", "refs/tags/0.1.1"]);
        let head_out = Command::new("git")
            .arg("-C")
            .arg(&origin)
            .args(["symbolic-ref", "HEAD", "refs/heads/main"])
            .output()
            .expect("git symbolic-ref launches");
        assert!(head_out.status.success(), "setting origin HEAD failed");

        let clone_out = Command::new("git")
            .args([
                "clone",
                "--no-tags",
                "-q",
                origin.to_str().unwrap(),
                clone.to_str().unwrap(),
            ])
            .output()
            .expect("git clone launches");
        assert!(clone_out.status.success(), "clone failed");
        let clone_repo = TempRepo(clone);
        clone_repo.git_ok(&["remote", "add", "backup", unreachable.to_str().unwrap()]);
        clone_repo.git_ok(&["config", "remote.backup.skipFetchAll", "true"]);

        let result = fetch(clone_repo.path(), None);
        assert!(
            result.is_ok(),
            "skipped unreachable remote should not fail tag import: {result:?}",
        );

        let after = clone_repo.git(&["tag", "--list", "0.1.1"]);
        assert_eq!(String::from_utf8_lossy(&after.stdout).trim(), "0.1.1");
    }

    #[test]
    fn fetch_preserves_local_only_tags_under_fetch_prune() {
        let root = TempRepo::new("fetch-prune-local-tag-root");
        let origin = root.0.join("origin.git");
        let source = root.0.join("source");
        let clone = root.0.join("clone");

        Command::new("git")
            .args(["init", "--bare", "-q", origin.to_str().unwrap()])
            .output()
            .expect("git init bare launches");
        Command::new("git")
            .args(["init", "-q", source.to_str().unwrap()])
            .output()
            .expect("git init launches");

        let source_repo = TempRepo(source);
        source_repo.git_ok(&["config", "user.name", "GitLane Test"]);
        source_repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
        source_repo.git_ok(&["config", "commit.gpgsign", "false"]);
        std::fs::write(source_repo.0.join("file.txt"), b"v1\n").unwrap();
        source_repo.git_ok(&["add", "file.txt"]);
        source_repo.git_ok(&["commit", "-q", "-m", "initial"]);
        source_repo.git_ok(&["tag", "0.1.1"]);
        source_repo.git_ok(&["remote", "add", "origin", origin.to_str().unwrap()]);
        source_repo.git_ok(&["push", "-q", "origin", "HEAD:main"]);
        source_repo.git_ok(&["push", "-q", "origin", "refs/tags/0.1.1"]);
        let head_out = Command::new("git")
            .arg("-C")
            .arg(&origin)
            .args(["symbolic-ref", "HEAD", "refs/heads/main"])
            .output()
            .expect("git symbolic-ref launches");
        assert!(head_out.status.success(), "setting origin HEAD failed");

        let clone_out = Command::new("git")
            .args([
                "clone",
                "--no-tags",
                "-q",
                origin.to_str().unwrap(),
                clone.to_str().unwrap(),
            ])
            .output()
            .expect("git clone launches");
        assert!(clone_out.status.success(), "clone failed");
        let clone_repo = TempRepo(clone);
        // Pruning on + a local-only tag is the exact combination that the
        // explicit tag refspec would delete without `--no-prune`.
        clone_repo.git_ok(&["config", "fetch.prune", "true"]);
        clone_repo.git_ok(&["tag", "keep-me", "HEAD"]);

        let result = fetch(clone_repo.path(), None);
        assert!(result.is_ok(), "fetch failed: {result:?}");

        let local_only = clone_repo.git(&["tag", "--list", "keep-me"]);
        assert_eq!(
            String::from_utf8_lossy(&local_only.stdout).trim(),
            "keep-me",
            "a local-only tag must survive Fetch under fetch.prune=true",
        );
        // The remote tag must still import — preservation can't come at the cost
        // of the feature.
        let imported = clone_repo.git(&["tag", "--list", "0.1.1"]);
        assert_eq!(String::from_utf8_lossy(&imported.stdout).trim(), "0.1.1");
    }

    #[test]
    fn fetch_ignores_tag_clobber_rejection_after_branch_updates() {
        let root = TempRepo::new("fetch-tag-clobber-root");
        let origin = root.0.join("origin.git");
        let source = root.0.join("source");
        let clone = root.0.join("clone");

        Command::new("git")
            .args(["init", "--bare", "-q", origin.to_str().unwrap()])
            .output()
            .expect("git init bare launches");
        Command::new("git")
            .args(["init", "-q", source.to_str().unwrap()])
            .output()
            .expect("git init launches");

        let source_repo = TempRepo(source);
        source_repo.git_ok(&["config", "user.name", "GitLane Test"]);
        source_repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
        source_repo.git_ok(&["config", "commit.gpgsign", "false"]);
        std::fs::write(source_repo.0.join("file.txt"), b"v1\n").unwrap();
        source_repo.git_ok(&["add", "file.txt"]);
        source_repo.git_ok(&["commit", "-q", "-m", "initial"]);
        source_repo.git_ok(&["tag", "0.1.1"]);
        source_repo.git_ok(&["remote", "add", "origin", origin.to_str().unwrap()]);
        source_repo.git_ok(&["push", "-q", "origin", "HEAD:main"]);
        source_repo.git_ok(&["push", "-q", "origin", "refs/tags/0.1.1"]);
        let head_out = Command::new("git")
            .arg("-C")
            .arg(&origin)
            .args(["symbolic-ref", "HEAD", "refs/heads/main"])
            .output()
            .expect("git symbolic-ref launches");
        assert!(head_out.status.success(), "setting origin HEAD failed");

        let clone_out = Command::new("git")
            .args([
                "clone",
                "--no-tags",
                "-q",
                origin.to_str().unwrap(),
                clone.to_str().unwrap(),
            ])
            .output()
            .expect("git clone launches");
        assert!(clone_out.status.success(), "clone failed");
        let clone_repo = TempRepo(clone);
        clone_repo.git_ok(&["config", "user.name", "GitLane Test"]);
        clone_repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
        clone_repo.git_ok(&["config", "commit.gpgsign", "false"]);
        std::fs::write(clone_repo.0.join("local.txt"), b"local\n").unwrap();
        clone_repo.git_ok(&["add", "local.txt"]);
        clone_repo.git_ok(&["commit", "-q", "-m", "local diverging tag target"]);
        clone_repo.git_ok(&["tag", "0.1.1"]);
        let local_tag = clone_repo.git(&["rev-parse", "refs/tags/0.1.1"]);
        let local_tag_oid = String::from_utf8_lossy(&local_tag.stdout)
            .trim()
            .to_string();

        std::fs::write(source_repo.0.join("file.txt"), b"v2\n").unwrap();
        source_repo.git_ok(&["commit", "-qam", "remote update"]);
        source_repo.git_ok(&["tag", "-f", "0.1.1"]);
        source_repo.git_ok(&["push", "-q", "origin", "HEAD:main"]);
        source_repo.git_ok(&["push", "-q", "--force", "origin", "refs/tags/0.1.1"]);
        let remote_tip = source_repo.git(&["rev-parse", "HEAD"]);
        let remote_tip_oid = String::from_utf8_lossy(&remote_tip.stdout)
            .trim()
            .to_string();

        let result = fetch(clone_repo.path(), None);
        assert!(
            result.is_ok(),
            "tag clobber rejection should not fail fetch: {result:?}"
        );

        let fetched_origin = clone_repo.git(&["rev-parse", "refs/remotes/origin/main"]);
        assert_eq!(
            String::from_utf8_lossy(&fetched_origin.stdout).trim(),
            remote_tip_oid,
            "branch updates should still be visible after the tolerated tag rejection",
        );
        let after_tag = clone_repo.git(&["rev-parse", "refs/tags/0.1.1"]);
        assert_eq!(
            String::from_utf8_lossy(&after_tag.stdout).trim(),
            local_tag_oid,
            "conflicting local tag should not be clobbered",
        );
    }

    #[test]
    fn tag_clobber_detection_does_not_mask_real_fetch_errors() {
        assert!(is_tag_clobber_rejection(
            "From /tmp/origin\n ! [rejected] 0.1.1 -> 0.1.1 (would clobber existing tag)"
        ));
        assert!(!is_tag_clobber_rejection(
            "fatal: unable to access remote\n ! [rejected] 0.1.1 -> 0.1.1 (would clobber existing tag)"
        ));
        assert!(!is_tag_clobber_rejection(
            "error: could not fetch origin\n ! [rejected] 0.1.1 -> 0.1.1 (would clobber existing tag)"
        ));
    }

    #[test]
    fn reflog_entries_expose_recovery_commits() {
        let repo = TempRepo::new("reflog");
        repo.git(&["init", "-q", "-b", "main"]);
        repo.git(&["config", "user.email", "t@t.t"]);
        repo.git(&["config", "user.name", "T"]);
        repo.git(&["config", "commit.gpgsign", "false"]);
        std::fs::write(repo.0.join("f.txt"), b"one\n").unwrap();
        repo.git(&["add", "f.txt"]);
        repo.git(&["commit", "-qm", "one"]);
        std::fs::write(repo.0.join("f.txt"), b"two\n").unwrap();
        repo.git(&["commit", "-qam", "two"]);
        repo.git(&["reset", "--hard", "HEAD~1"]);

        let entries = reflog_entries(repo.path(), 12).expect("reflog entries");
        assert!(entries.iter().any(|entry| entry.subject.contains("reset")));
        assert!(entries
            .iter()
            .any(|entry| entry.short_selector.contains("HEAD@{")));
    }

    #[test]
    fn reflog_entries_use_reflog_time_not_commit_time() {
        let repo = TempRepo::new("reflog-time");
        repo.git(&["init", "-q", "-b", "main"]);
        repo.git(&["config", "user.email", "t@t.t"]);
        repo.git(&["config", "user.name", "T"]);
        repo.git(&["config", "commit.gpgsign", "false"]);
        std::fs::write(repo.0.join("f.txt"), b"old\n").unwrap();
        repo.git(&["add", "f.txt"]);
        let old_timestamp = 946_684_800_i64;
        let out = Command::new("git")
            .arg("-C")
            .arg(&repo.0)
            .args(["commit", "-qm", "old"])
            .env("GIT_AUTHOR_DATE", format!("@{old_timestamp} +0000"))
            .env("GIT_COMMITTER_DATE", format!("@{old_timestamp} +0000"))
            .output()
            .expect("git launches in tests");
        assert!(
            out.status.success(),
            "old commit failed\nstdout:\n{}\nstderr:\n{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        std::fs::write(repo.0.join("f.txt"), b"new\n").unwrap();
        repo.git(&["commit", "-qam", "new"]);
        repo.git(&["reset", "--hard", "HEAD~1"]);

        let entries = reflog_entries(repo.path(), 12).expect("reflog entries");
        let reset = entries
            .iter()
            .find(|entry| entry.subject.contains("reset"))
            .expect("reset reflog entry");
        assert!(
            reset.timestamp > old_timestamp,
            "reset timestamp should be the reflog event time, not old commit time: {:?}",
            reset
        );
    }

    #[test]
    fn reflog_entries_scope_excludes_remote_and_stash() {
        let repo = TempRepo::new("reflog-scope");
        repo.git(&["init", "-q", "-b", "main"]);
        repo.git(&["config", "user.email", "t@t.t"]);
        repo.git(&["config", "user.name", "T"]);
        repo.git(&["config", "commit.gpgsign", "false"]);
        std::fs::write(repo.0.join("f.txt"), b"base\n").unwrap();
        repo.git(&["add", "f.txt"]);
        repo.git(&["commit", "-qm", "base"]);
        // A remote-tracking ref update and a stash both create reflog entries that
        // `git log -g --all` would surface but the recovery list must not.
        repo.git(&["update-ref", "refs/remotes/origin/main", "HEAD"]);
        std::fs::write(repo.0.join("f.txt"), b"dirty\n").unwrap();
        repo.git(&["stash", "-q"]);

        let entries = reflog_entries(repo.path(), 50).expect("reflog entries");
        assert!(!entries.is_empty(), "HEAD/branch entries should remain");
        assert!(
            entries
                .iter()
                .all(|e| !e.selector.contains("remotes") && !e.selector.contains("stash")),
            "remote-tracking and stash reflog entries must be excluded: {:?}",
            entries.iter().map(|e| &e.selector).collect::<Vec<_>>()
        );
    }

    #[test]
    fn reflog_entries_on_unborn_repo_is_empty_not_error() {
        // An unborn HEAD makes `git log -g HEAD …` fatal, so `reflog_entries`
        // short-circuits on the `rev-parse --verify HEAD` pre-check and returns an
        // empty list — the recovery dialog shows its "No reflog entries" state.
        let repo = TempRepo::new("reflog-empty");
        repo.git(&["init", "-q", "-b", "main"]);
        let entries = reflog_entries(repo.path(), 12).expect("reflog entries on empty repo");
        assert!(entries.is_empty());
    }

    #[test]
    fn reflog_entries_with_no_reflog_is_empty_not_error() {
        // A committed repo whose reflog was pruned/disabled: HEAD resolves, but
        // `git log -g HEAD --branches` exits 0 with no output (it does NOT error),
        // so the read yields an empty list rather than surfacing a git failure.
        let repo = TempRepo::new("reflog-pruned");
        repo.git(&["init", "-q", "-b", "main"]);
        repo.git(&["config", "user.email", "t@t.t"]);
        repo.git(&["config", "user.name", "T"]);
        repo.git(&["config", "commit.gpgsign", "false"]);
        std::fs::write(repo.0.join("f.txt"), b"base\n").unwrap();
        repo.git(&["add", "f.txt"]);
        repo.git(&["commit", "-qm", "base"]);
        std::fs::remove_dir_all(repo.0.join(".git/logs")).unwrap();

        let entries = reflog_entries(repo.path(), 12).expect("reflog entries with no reflog");
        assert!(entries.is_empty());
    }

    #[test]
    fn reset_preview_lists_commits_and_recovery_warning() {
        let repo = TempRepo::new("reset-preview");
        repo.git(&["init", "-q", "-b", "main"]);
        repo.git(&["config", "user.email", "t@t.t"]);
        repo.git(&["config", "user.name", "T"]);
        repo.git(&["config", "commit.gpgsign", "false"]);
        std::fs::write(repo.0.join("f.txt"), b"one\n").unwrap();
        repo.git(&["add", "f.txt"]);
        repo.git(&["commit", "-qm", "one"]);
        std::fs::write(repo.0.join("f.txt"), b"two\n").unwrap();
        repo.git(&["commit", "-qam", "two"]);

        let preview = preview_reset(repo.path(), "HEAD~1", "hard", "HEAD").expect("preview");
        assert!(preview.summary.contains("hard"));
        assert!(preview.details.iter().any(|line| line.contains("two")));
        assert!(preview.warnings.iter().any(|line| line.contains("reflog")));
    }

    #[test]
    fn reset_preview_anchors_on_the_source_ref_not_head() {
        // A reset of a *non-current* branch (drag a branch onto a commit) checks
        // that branch out first, so the impacted commits are `target..source`,
        // not `target..HEAD`. The preview must reflect the branch being reset.
        let repo = TempRepo::new("reset-source-ref");
        repo.git(&["init", "-q", "-b", "main"]);
        repo.git(&["config", "user.email", "t@t.t"]);
        repo.git(&["config", "user.name", "T"]);
        repo.git(&["config", "commit.gpgsign", "false"]);
        std::fs::write(repo.0.join("f.txt"), b"base\n").unwrap();
        repo.git(&["add", "f.txt"]);
        repo.git(&["commit", "-qm", "base"]);
        // A feature branch with a commit that HEAD (main) does not have.
        repo.git(&["checkout", "-q", "-b", "feature"]);
        std::fs::write(repo.0.join("f.txt"), b"feature\n").unwrap();
        repo.git(&["commit", "-qam", "feature-only"]);
        // Back on main so HEAD != the branch being reset.
        repo.git(&["checkout", "-q", "main"]);

        // Resetting `feature` to base must list feature-only, even though HEAD=main.
        let on_source =
            preview_reset(repo.path(), "main", "mixed", "feature").expect("preview source");
        assert!(on_source
            .details
            .iter()
            .any(|line| line.contains("feature-only")));
        // Anchored on HEAD (main) the same range is empty — proves the fix matters.
        let on_head = preview_reset(repo.path(), "main", "mixed", "HEAD").expect("preview head");
        assert!(!on_head
            .details
            .iter()
            .any(|line| line.contains("feature-only")));
    }

    #[test]
    fn reset_preview_source_uses_branch_not_same_named_tag() {
        let repo = TempRepo::new("reset-ambig");
        repo.git(&["init", "-q", "-b", "main"]);
        repo.git(&["config", "user.email", "t@t.t"]);
        repo.git(&["config", "user.name", "T"]);
        repo.git(&["config", "commit.gpgsign", "false"]);
        std::fs::write(repo.0.join("f.txt"), b"one\n").unwrap();
        repo.git(&["add", "f.txt"]);
        repo.git(&["commit", "-qm", "one"]);
        // Branch `dup` carries an extra commit; tag `dup` stays at base (== main).
        repo.git(&["branch", "dup"]);
        repo.git(&["checkout", "-q", "dup"]);
        std::fs::write(repo.0.join("f.txt"), b"two\n").unwrap();
        repo.git(&["commit", "-qam", "dup-only"]);
        repo.git(&["checkout", "-q", "main"]);
        repo.git(&["tag", "dup", "main"]);

        // Resetting branch `dup` to main: impact is main..refs/heads/dup = dup-only.
        // A bare `dup` would resolve to the tag (== main) and show nothing.
        let preview = preview_reset(repo.path(), "main", "mixed", "dup").expect("preview");
        assert!(
            preview.details.iter().any(|line| line.contains("dup-only")),
            "reset source must resolve to the branch, not the same-named tag: {:?}",
            preview.details
        );
    }

    #[test]
    fn reset_preview_fails_closed_on_unresolvable_refs() {
        let repo = TempRepo::new("reset-bad-refs");
        repo.git(&["init", "-q", "-b", "main"]);
        repo.git(&["config", "user.email", "t@t.t"]);
        repo.git(&["config", "user.name", "T"]);
        repo.git(&["config", "commit.gpgsign", "false"]);
        std::fs::write(repo.0.join("f.txt"), b"base\n").unwrap();
        repo.git(&["add", "f.txt"]);
        repo.git(&["commit", "-qm", "base"]);

        // A bogus target or source must error (fail closed) rather than render a
        // confident empty preview.
        assert!(preview_reset(repo.path(), "does-not-exist", "mixed", "HEAD").is_err());
        assert!(preview_reset(repo.path(), "HEAD", "mixed", "does-not-exist").is_err());
    }

    #[test]
    fn discard_all_preview_warns_about_untracked_limits() {
        let repo = TempRepo::new("discard-preview");
        repo.git(&["init", "-q", "-b", "main"]);
        repo.git(&["config", "user.email", "t@t.t"]);
        repo.git(&["config", "user.name", "T"]);
        repo.git(&["config", "commit.gpgsign", "false"]);
        std::fs::write(repo.0.join("tracked.txt"), b"one\n").unwrap();
        repo.git(&["add", "tracked.txt"]);
        repo.git(&["commit", "-qm", "one"]);
        std::fs::write(repo.0.join("tracked.txt"), b"two\n").unwrap();
        std::fs::write(repo.0.join("new.txt"), b"new\n").unwrap();

        let preview = preview_discard_all(repo.path()).expect("preview");
        assert!(preview
            .details
            .iter()
            .any(|line| line.contains("tracked.txt")));
        assert!(preview.details.iter().any(|line| line.contains("new.txt")));
        assert!(preview
            .warnings
            .iter()
            .any(|line| line.contains("Untracked files")));
    }

    #[test]
    fn discard_all_preview_fails_closed_on_non_repo() {
        // A path that isn't a git repo must error, not report "already clean".
        let dir = TempRepo::new("discard-non-repo");
        assert!(preview_discard_all(dir.path()).is_err());
    }

    #[test]
    fn delete_branch_preview_uses_branch_not_same_named_tag() {
        let repo = TempRepo::new("delete-ambig");
        repo.git(&["init", "-q", "-b", "main"]);
        repo.git(&["config", "user.email", "t@t.t"]);
        repo.git(&["config", "user.name", "T"]);
        repo.git(&["config", "commit.gpgsign", "false"]);
        std::fs::write(repo.0.join("f.txt"), b"one\n").unwrap();
        repo.git(&["add", "f.txt"]);
        repo.git(&["commit", "-qm", "one"]);
        std::fs::write(repo.0.join("f.txt"), b"two\n").unwrap();
        repo.git(&["commit", "-qam", "two"]);
        // Branch `dup` at the first commit, tag `dup` at HEAD. A bare `dup`
        // resolves to the tag (ref precedence); the preview must use the branch.
        repo.git(&["branch", "dup", "HEAD~1"]);
        repo.git(&["tag", "dup", "HEAD"]);
        let branch_tip = String::from_utf8(
            repo.git(&["rev-parse", "--short", "refs/heads/dup"]).stdout,
        )
        .unwrap();
        let branch_tip = branch_tip.trim();

        let preview = preview_delete_branch(repo.path(), "dup").expect("preview");
        assert!(
            preview.details.iter().any(|line| line.contains(branch_tip)),
            "preview must report the branch tip {branch_tip}, not the tag: {:?}",
            preview.details
        );
    }

    #[test]
    fn force_push_preview_fails_closed_for_missing_branch() {
        let (repo, _) = repo_with_base_commit("force-push-missing");
        assert!(preview_force_push(repo.path(), "no-such-branch").is_err());
    }

    #[test]
    fn reset_preview_hard_lists_tracked_and_untracked_obstructions_only() {
        let repo = TempRepo::new("reset-hard-untracked");
        repo.git(&["init", "-q", "-b", "main"]);
        repo.git(&["config", "user.email", "t@t.t"]);
        repo.git(&["config", "user.name", "T"]);
        repo.git(&["config", "commit.gpgsign", "false"]);
        std::fs::write(repo.0.join("tracked.txt"), b"one\n").unwrap();
        std::fs::write(repo.0.join("restored.txt"), b"target\n").unwrap();
        repo.git(&["add", "tracked.txt", "restored.txt"]);
        repo.git(&["commit", "-qm", "one"]);
        std::fs::write(repo.0.join("tracked.txt"), b"two\n").unwrap();
        repo.git(&["rm", "-q", "restored.txt"]);
        repo.git(&["commit", "-am", "two"]);
        // Dirty the tree: a tracked edit is lost by --hard, an ordinary untracked
        // file is left in place, and an untracked file that blocks a target-tree
        // tracked path can be overwritten/deleted by reset --hard.
        std::fs::write(repo.0.join("tracked.txt"), b"dirty\n").unwrap();
        std::fs::write(repo.0.join("untracked.txt"), b"keep\n").unwrap();
        std::fs::write(repo.0.join("restored.txt"), b"obstruct\n").unwrap();

        let preview = preview_reset(repo.path(), "HEAD~1", "hard", "HEAD").expect("preview");
        assert!(preview
            .warnings
            .iter()
            .any(|line| line.contains("tracked changes that will be lost")
                && line.contains("tracked.txt")));
        let full = format!(
            "{}{}",
            preview.details.join("\n"),
            preview.warnings.join("\n")
        );
        assert!(
            full.contains("restored.txt"),
            "hard-reset preview must list untracked target obstructions: {full}"
        );
        assert!(
            !full.contains("untracked.txt"),
            "hard-reset preview must not list ordinary untracked files: {full}"
        );
    }

    #[test]
    fn delete_branch_preview_lists_unmerged_commits() {
        let repo = TempRepo::new("delete-branch-preview");
        repo.git(&["init", "-q", "-b", "main"]);
        repo.git(&["config", "user.email", "t@t.t"]);
        repo.git(&["config", "user.name", "T"]);
        repo.git(&["config", "commit.gpgsign", "false"]);
        std::fs::write(repo.0.join("f.txt"), b"base\n").unwrap();
        repo.git(&["add", "f.txt"]);
        repo.git(&["commit", "-qm", "base"]);
        // A feature branch with a commit that is not reachable from HEAD (main).
        repo.git(&["checkout", "-q", "-b", "feature"]);
        std::fs::write(repo.0.join("f.txt"), b"feature\n").unwrap();
        repo.git(&["commit", "-qam", "feature-work"]);
        repo.git(&["checkout", "-q", "main"]);

        let preview = preview_delete_branch(repo.path(), "feature").expect("preview");
        assert!(preview.summary.contains("feature"));
        assert!(preview
            .details
            .iter()
            .any(|line| line.contains("feature-work")));
        // A non-existent branch fails closed rather than showing an "unknown" tip.
        assert!(preview_delete_branch(repo.path(), "ghost").is_err());
    }

    #[test]
    fn delete_remote_branch_preview_warns_unrecoverable() {
        let (repo, head) = repo_with_base_commit("delete-remote-preview");
        // Seed the remote-tracking ref so rev-parse resolves locally (offline).
        repo.git(&["update-ref", "refs/remotes/origin/main", &head]);

        let preview =
            preview_delete_remote_branch(repo.path(), "origin", "main").expect("preview");
        assert!(preview.summary.contains("main"));
        assert!(preview.summary.contains("origin"));
        assert!(preview.warnings.iter().any(|line| line.contains("recover")));
    }

    #[test]
    fn force_push_preview_reports_local_divergence() {
        let (repo, base) = repo_with_base_commit("force-push-preview");
        // Configure upstream and seed a remote-tracking ref at the base commit so
        // the local branch is one commit ahead — all resolved offline.
        repo.git(&["config", "branch.main.remote", "origin"]);
        repo.git(&["config", "branch.main.merge", "refs/heads/main"]);
        repo.git(&["update-ref", "refs/remotes/origin/main", &base]);
        std::fs::write(repo.0.join("f.txt"), b"local\n").unwrap();
        repo.git(&["commit", "-qam", "local-work"]);

        let preview = preview_force_push(repo.path(), "main").expect("preview");
        assert!(preview.summary.contains("main"));
        assert!(preview
            .details
            .iter()
            .any(|line| line.contains("local-work")));
        assert!(preview
            .warnings
            .iter()
            .any(|line| line.contains("force-with-lease")));
    }

    #[test]
    fn empty_after_resolution_matches_only_the_empty_phrase() {
        // git's actual empty-patch message — must match.
        assert!(is_empty_after_resolution(
            "The previous cherry-pick is now empty, possibly due to conflict resolution."
        ));
        assert!(is_empty_after_resolution(
            "The previous revert is now empty."
        ));
        // Unrelated --continue failures must NOT be mistaken for "empty" (which
        // would silently --skip a patch the user wanted to keep).
        assert!(!is_empty_after_resolution(
            "error: Committing is not possible because you have unmerged files."
        ));
        assert!(!is_empty_after_resolution(
            "nothing to commit, working tree clean"
        ));
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

    /// A repo with one commit on `main` and a configured (but offline) origin.
    /// `git config` here keeps commits unsigned so CI without a signing key works.
    fn repo_with_base_commit(tag: &str) -> (TempRepo, String) {
        let repo = TempRepo::new(tag);
        repo.git(&["init", "-q", "-b", "main"]);
        repo.git(&["config", "user.email", "t@t.t"]);
        repo.git(&["config", "user.name", "T"]);
        repo.git(&["config", "commit.gpgsign", "false"]);
        std::fs::write(repo.0.join("f.txt"), b"base\n").unwrap();
        repo.git(&["add", "f.txt"]);
        repo.git(&["commit", "-qm", "base"]);
        repo.git(&["remote", "add", "origin", "https://example.test/r.git"]);
        let head = String::from_utf8(repo.git(&["rev-parse", "HEAD"]).stdout).unwrap();
        (repo, head.trim().to_string())
    }

    #[test]
    fn set_upstream_writes_tracking_config() {
        let (repo, head) = repo_with_base_commit("set-upstream");
        // `--set-upstream-to` resolves the ref locally; seed it so no network is hit.
        repo.git(&["update-ref", "refs/remotes/origin/main", &head]);

        let result = set_upstream(repo.path(), "main", "origin/main");
        assert!(result.is_ok(), "set_upstream failed: {result:?}");

        let remote = String::from_utf8(repo.git(&["config", "branch.main.remote"]).stdout).unwrap();
        let merge = String::from_utf8(repo.git(&["config", "branch.main.merge"]).stdout).unwrap();
        assert_eq!(remote.trim(), "origin");
        assert_eq!(merge.trim(), "refs/heads/main");
    }

    #[test]
    fn set_upstream_rejects_option_like_operands() {
        let repo = TempRepo::new("set-upstream-inj");
        repo.git(&["init", "-q"]);
        // Both operands flow into git unprefixed, so option-injection must fail
        // before the subprocess runs.
        assert!(set_upstream(repo.path(), "-D", "origin/main").is_err());
        assert!(set_upstream(repo.path(), "main", "--upload-pack=touch /tmp/x").is_err());
    }

    #[test]
    fn publish_branch_validates_upstream_format_before_pushing() {
        let (repo, _) = repo_with_base_commit("publish-validate");
        // All of these fail format/operand validation before any network push, so
        // the offline origin is never contacted.
        assert!(
            publish_branch(repo.path(), "main", "originmain", None).is_err(),
            "missing slash must be rejected"
        );
        assert!(
            publish_branch(repo.path(), "main", "/main", None).is_err(),
            "empty remote half must be rejected"
        );
        assert!(
            publish_branch(repo.path(), "main", "origin/", None).is_err(),
            "empty branch half must be rejected"
        );
        assert!(
            publish_branch(repo.path(), "--upload-pack=x", "origin/main", None).is_err(),
            "option-like branch operand must be rejected"
        );
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
        assert!(
            !conflict_stage_absent(repo.path(), "f.txt", "2"),
            "ours stage should be present"
        );
        assert!(
            conflict_stage_absent(repo.path(), "f.txt", "3"),
            "theirs stage should be absent"
        );
    }

    #[test]
    fn accept_conflict_side_keeps_modified_side() {
        let repo = modify_delete_repo("keep-ours");
        // Accept ours: the modified version is checked out and staged, file kept.
        let result = accept_conflict_side(repo.path(), "f.txt", "ours");
        assert!(result.is_ok(), "accept ours failed: {result:?}");
        assert_eq!(
            std::fs::read_to_string(repo.0.join("f.txt")).unwrap(),
            "ours-modified\n"
        );
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
        assert_eq!(
            std::fs::read_to_string(repo.0.join("clean.txt")).unwrap(),
            "hi\n"
        );
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
        assert_eq!(
            line.split_whitespace().count(),
            3,
            "expected a merge commit: {line:?}"
        );
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
        assert!(
            result.is_err(),
            "expected refusal outside an operation: {result:?}"
        );
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
        assert!(
            result.is_ok(),
            "dash-prefixed path should resolve: {result:?}"
        );
        let unmerged = repo.git(&["ls-files", "-u", "--", "-foo"]);
        assert!(String::from_utf8_lossy(&unmerged.stdout).trim().is_empty());
    }

    #[test]
    fn reconflict_file_refuses_unrelated_path_and_keeps_edits() {
        // Mid-merge, re-conflicting a tracked file that was never part of the
        // conflict (no resolve-undo) must be refused — otherwise `checkout
        // --merge` would overwrite its unstaged edits with the index copy.
        let repo = TempRepo::new("reconflict-unrelated");
        repo.git(&["init", "-q", "-b", "main"]);
        repo.git(&["config", "user.email", "t@t.t"]);
        repo.git(&["config", "user.name", "T"]);
        repo.git(&["config", "commit.gpgsign", "false"]);
        std::fs::write(repo.0.join("f.txt"), b"base\n").unwrap();
        std::fs::write(repo.0.join("other.txt"), b"orig\n").unwrap();
        repo.git(&["add", "f.txt", "other.txt"]);
        repo.git(&["commit", "-qm", "base"]);
        repo.git(&["checkout", "-q", "-b", "other"]);
        std::fs::write(repo.0.join("f.txt"), b"theirs\n").unwrap();
        repo.git(&["commit", "-qam", "theirs"]);
        repo.git(&["checkout", "-q", "main"]);
        std::fs::write(repo.0.join("f.txt"), b"ours\n").unwrap();
        repo.git(&["commit", "-qam", "ours"]);
        let _ = repo.git(&["merge", "other"]); // conflicts on f.txt only
                                               // Unstaged edit to the unrelated, non-conflicted file.
        std::fs::write(repo.0.join("other.txt"), b"my precious edits\n").unwrap();
        let result = reconflict_file(repo.path(), "other.txt");
        assert!(
            result.is_err(),
            "should refuse a non-conflict path: {result:?}"
        );
        // The edit survives — checkout --merge never ran.
        assert_eq!(
            std::fs::read_to_string(repo.0.join("other.txt")).unwrap(),
            "my precious edits\n"
        );
    }
}
