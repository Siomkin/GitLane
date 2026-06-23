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
    use super::{discard_all, ensure_operand};
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
}
