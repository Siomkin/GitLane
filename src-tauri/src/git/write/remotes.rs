//! Remote, fetch, push, and authentication-aware git writes.

use super::cli::{run_git, run_git_env, run_git_env_stable_diagnostics};
use super::operands::ensure_operand;

const TAG_FETCH_REFSPEC: &str = "refs/tags/*:refs/tags/*";

/// Add a new remote `name` pointing at `url` (`git remote add`).
pub fn add_remote(repo: &str, name: &str, url: &str) -> Result<String, String> {
    ensure_operand(name)?;
    ensure_operand(url)?;
    run_git(repo, &["remote", "add", name, url])
}

/// Repoint an existing remote at a new `url`. `git remote set-url` updates only
/// the *fetch* URL; when a separate push URL is configured we repoint that too,
/// so editing a remote doesn't silently leave pushes going to the old host. (When
/// no separate push URL exists, push follows the fetch URL, so nothing else is
/// needed.)
pub fn set_remote_url(repo: &str, name: &str, url: &str) -> Result<String, String> {
    ensure_operand(name)?;
    ensure_operand(url)?;
    let fetch = run_git(repo, &["remote", "set-url", name, url])?;
    if has_push_url(repo, name) {
        let push = run_git(repo, &["remote", "set-url", "--push", name, url])?;
        return Ok(join_git_outputs(&fetch, &push));
    }
    Ok(fetch)
}

/// Whether `remote.<name>.pushurl` is set (a push URL distinct from the fetch
/// URL). `git config --get-all` exits non-zero when the key is absent.
fn has_push_url(repo: &str, name: &str) -> bool {
    let key = format!("remote.{name}.pushurl");
    run_git(repo, &["config", "--get-all", &key]).is_ok()
}

/// Remove a remote and its remote-tracking refs (`git remote remove`).
pub fn remove_remote(repo: &str, name: &str) -> Result<String, String> {
    ensure_operand(name)?;
    run_git(repo, &["remote", "remove", name])
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
pub(super) fn push_target(repo: &str, branch: &str) -> (String, String) {
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
                &[
                    "fetch",
                    &remote,
                    "--no-tags",
                    "--no-prune",
                    TAG_FETCH_REFSPEC,
                ],
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

pub(super) fn is_tag_clobber_rejection(output: &str) -> bool {
    output.contains("would clobber existing tag")
        && !output.lines().any(|line| {
            let trimmed = line.trim_start();
            trimmed.starts_with("fatal:") || trimmed.starts_with("error:")
        })
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
