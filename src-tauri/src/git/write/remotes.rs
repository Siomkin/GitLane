//! Remote, fetch, push, and authentication-aware git writes.

use std::collections::HashMap;

use super::cli::{run_git, run_git_env, run_git_env_stable_diagnostics};
use super::operands::ensure_operand;
use crate::git::credential_bridge::{self, GitInvocation};
use crate::git::transport_auth::TransportCredential;

const TAG_FETCH_REFSPEC: &str = "refs/tags/*:refs/tags/*";

/// Run a git network command under a resolved [`TransportCredential`]: prepend
/// the bridge's `-c` config and apply its env. For `None`/`Gh` the env is empty,
/// so those paths are byte-identical to a plain `run_git`.
fn run_transport(
    repo: &str,
    cred: &TransportCredential,
    command: &[&str],
) -> Result<String, String> {
    let inv = credential_bridge::git_invocation(cred)?;
    let (args, env) = merge_invocation(&inv, command);
    run_git_env(repo, &args_refs(&args), &env_refs(&env))
}

/// Like [`run_transport`] but with locale-stable diagnostics (`LC_ALL=C`), for
/// commands whose output is pattern-matched (concurrent fetch retry, fetch
/// tag-clobber, delete-tag missing-ref tolerance).
fn run_transport_stable(
    repo: &str,
    cred: &TransportCredential,
    command: &[&str],
) -> Result<String, String> {
    let inv = credential_bridge::git_invocation(cred)?;
    let (args, env) = merge_invocation(&inv, command);
    run_git_env_stable_diagnostics(repo, &args_refs(&args), &env_refs(&env))
}

fn merge_invocation(inv: &GitInvocation, command: &[&str]) -> (Vec<String>, Vec<(String, String)>) {
    let mut args = inv.config.clone();
    args.extend(command.iter().map(|s| (*s).to_string()));
    (args, inv.env.clone())
}

fn args_refs(args: &[String]) -> Vec<&str> {
    args.iter().map(String::as_str).collect()
}

fn env_refs(env: &[(String, String)]) -> Vec<(&str, &str)> {
    env.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect()
}

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

/// Rewrite only the HTTPS username on a remote's fetch URL and, when a
/// separate push URL exists, on that push URL too. Unlike [`set_remote_url`],
/// this preserves each URL's host/path, so auth changes do not collapse a
/// fork-style push URL back to the fetch URL.
pub fn set_remote_username(
    repo: &str,
    name: &str,
    username: Option<&str>,
) -> Result<String, String> {
    ensure_operand(name)?;
    let username = username.map(str::trim).filter(|value| !value.is_empty());

    let fetch_url = remote_get_url(repo, name, false)?;
    let next_fetch = rewrite_https_user(&fetch_url, username)?;

    if has_push_url(repo, name) {
        let push_url = remote_get_url(repo, name, true)?;
        let next_push = rewrite_https_user(&push_url, username)?;
        let fetch = run_git(repo, &["remote", "set-url", name, &next_fetch])?;
        let push = run_git(repo, &["remote", "set-url", "--push", name, &next_push])?;
        return Ok(join_git_outputs(&fetch, &push));
    }
    let fetch = run_git(repo, &["remote", "set-url", name, &next_fetch])?;
    Ok(fetch)
}

/// Whether `remote.<name>.pushurl` is set (a push URL distinct from the fetch
/// URL). `git config --get-all` exits non-zero when the key is absent.
fn has_push_url(repo: &str, name: &str) -> bool {
    let key = format!("remote.{name}.pushurl");
    run_git(repo, &["config", "--get-all", &key]).is_ok()
}

fn remote_get_url(repo: &str, name: &str, push: bool) -> Result<String, String> {
    let args = if push {
        vec!["remote", "get-url", "--push", name]
    } else {
        vec!["remote", "get-url", name]
    };
    Ok(run_git(repo, &args)?.trim().to_string())
}

fn rewrite_https_user(url: &str, username: Option<&str>) -> Result<String, String> {
    let trimmed = url.trim();
    let Some((scheme, rest)) = trimmed
        .strip_prefix("https://")
        .map(|rest| ("https://", rest))
        .or_else(|| {
            trimmed
                .strip_prefix("http://")
                .map(|rest| ("http://", rest))
        })
    else {
        return Err("Remote account usernames can only be written to HTTPS remotes.".into());
    };
    let (authority, path) = rest
        .find('/')
        .map(|index| rest.split_at(index))
        .unwrap_or((rest, ""));
    let authority = authority
        .rsplit_once('@')
        .map(|(_, host)| host)
        .unwrap_or(authority);
    Ok(match username {
        Some(user) => format!("{scheme}{}@{authority}{path}", encode_userinfo(user)),
        None => format!("{scheme}{authority}{path}"),
    })
}

fn encode_userinfo(value: &str) -> String {
    value
        .bytes()
        .flat_map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                vec![byte as char]
            }
            _ => format!("%{byte:02X}").chars().collect(),
        })
        .collect()
}

#[cfg(test)]
mod url_rewrite_tests {
    use super::rewrite_https_user;

    #[test]
    fn rewrite_https_user_preserves_at_signs_in_path() {
        let url = rewrite_https_user("https://github.com/o/r@v2.git", Some("frank")).unwrap();
        assert_eq!(url, "https://frank@github.com/o/r@v2.git");
    }

    #[test]
    fn rewrite_https_user_replaces_all_existing_userinfo() {
        let url =
            rewrite_https_user("https://alice:token@github.com/o/repo.git", Some("frank")).unwrap();
        assert_eq!(url, "https://frank@github.com/o/repo.git");

        let url = rewrite_https_user("https://a@b@github.com/o/repo.git", Some("frank")).unwrap();
        assert_eq!(url, "https://frank@github.com/o/repo.git");
    }

    #[test]
    fn rewrite_https_user_preserves_ports_and_can_strip_user() {
        let url =
            rewrite_https_user("https://alice@ghe.example.test:8443/o/repo.git", None).unwrap();
        assert_eq!(url, "https://ghe.example.test:8443/o/repo.git");

        let url = rewrite_https_user(
            "https://ghe.example.test:8443/o/repo.git",
            Some("Ada Lovelace"),
        )
        .unwrap();
        assert_eq!(
            url,
            "https://Ada%20Lovelace@ghe.example.test:8443/o/repo.git"
        );
    }
}

/// Remove a remote and its remote-tracking refs (`git remote remove`).
pub fn remove_remote(repo: &str, name: &str) -> Result<String, String> {
    ensure_operand(name)?;
    run_git(repo, &["remote", "remove", name])
}

/// Pull from the upstream remote without creating a merge commit. Divergence
/// fails explicitly so the user can choose merge or rebase from the graph.
///
/// `--no-rebase` pins the fast-forward-only contract regardless of the user's
/// `pull.rebase` config. Modern git already gives an explicit `--ff-only`
/// precedence over `pull.rebase=true`, but older versions rebased on divergence
/// instead of failing — passing `--no-rebase` makes the ff-only behaviour
/// identical everywhere rather than depending on the git version and config.
#[cfg(test)]
pub fn pull(repo: &str, cred: &TransportCredential) -> Result<String, String> {
    run_transport(repo, cred, &["pull", "--no-rebase", "--ff-only"])
}

/// Fetch the configured upstream, then revalidate the explicit checked-out
/// branch before integrating it. A checkout that lands while the network fetch
/// is running therefore aborts before any local branch is moved.
pub fn pull_branch(
    repo: &str,
    branch: &str,
    expected_oid: &str,
    remote: &str,
    merge_ref: &str,
    cred: &TransportCredential,
) -> Result<String, String> {
    super::head::ensure_expected_head(repo, Some(branch), Some(expected_oid))?;
    ensure_operand(remote)?;
    ensure_operand(merge_ref)?;
    run_transport(repo, cred, &["fetch", remote, merge_ref])?;
    super::head::ensure_expected_head(repo, Some(branch), Some(expected_oid))?;
    run_git(repo, &["merge", "--ff-only", "FETCH_HEAD"])
}

/// Push a specific `branch` without checking it out first (shells out — libgit2
/// has no network here). Pushes to the branch's configured remote
/// (`branch.<name>.remote`), falling back to `origin` when none is set, and
/// honours a divergent upstream branch name (`branch.<name>.merge`) so a local
/// branch tracking a differently-named remote branch still lands on the right
/// ref. Does **not** set upstream — use [`set_upstream`] for that. `cred` selects
/// the inline transport credentials; no token crosses the frontend boundary.
pub fn push_branch(
    repo: &str,
    branch: &str,
    expected_oid: &str,
    cred: &TransportCredential,
) -> Result<String, String> {
    // `branch` becomes a positional refspec in `git push <remote> <refspec>`, so
    // guard it against option injection (e.g. --receive-pack=…) like the others.
    super::head::ensure_expected_branch_tip(repo, branch, expected_oid)?;
    let (remote, refspec) = push_target_at(repo, branch, expected_oid);
    run_transport(repo, cred, &["push", &remote, &refspec])
}

/// Publish `branch` to `upstream` (`remote/branch`) and set it as the branch's
/// upstream in one git invocation. Used for first-push flows where the remote
/// tracking ref does not exist yet, so `set_upstream` alone would fail.
pub fn publish_branch(
    repo: &str,
    branch: &str,
    expected_oid: &str,
    upstream: &str,
    cred: &TransportCredential,
) -> Result<String, String> {
    super::head::ensure_expected_branch_tip(repo, branch, expected_oid)?;
    let (remote, remote_branch) = split_remote_ref(repo, upstream)?;
    ensure_operand(&remote)?;
    ensure_operand(&remote_branch)?;
    let refspec = format!("{expected_oid}:refs/heads/{remote_branch}");
    // A pinned oid source is what prevents a concurrent local branch move from
    // changing the commit we publish. `git push --set-upstream` cannot infer a
    // local branch from an oid source, so persist the equivalent tracking
    // configuration explicitly after the push succeeds.
    let pushed = run_transport(repo, cred, &["push", &remote, &refspec])?;
    let configured_remote = run_git(
        repo,
        &["config", &format!("branch.{branch}.remote"), &remote],
    )?;
    let configured_merge = run_git(
        repo,
        &[
            "config",
            &format!("branch.{branch}.merge"),
            &format!("refs/heads/{remote_branch}"),
        ],
    )?;
    Ok(join_git_outputs(
        &join_git_outputs(&pushed, &configured_remote),
        &configured_merge,
    ))
}

/// Split an `upstream` string like `origin/main` into its `(remote, branch)`
/// parts by matching the **longest configured remote name** that prefixes it —
/// not by splitting on the first `/`. A remote name may itself contain a slash
/// (git permits it), and a first-`/` split would then send the push to the
/// wrong remote (or a nonexistent one). Falls back to the first-`/` split only
/// when no configured remote matches, so a genuine first-push to a
/// not-yet-fetched remote still works and git surfaces its own error if the
/// remote is unknown.
fn split_remote_ref(repo: &str, upstream: &str) -> Result<(String, String), String> {
    let invalid = || "Enter an upstream as remote/branch, for example origin/main.".to_string();
    let remotes = run_git(repo, &["remote"])?;
    let matched = remotes
        .lines()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .filter(|name| {
            upstream
                .strip_prefix(*name)
                .is_some_and(|rest| rest.starts_with('/'))
        })
        // Longest remote name wins so `origin/x` beats `origin` for an
        // `origin/x/feature` upstream.
        .max_by_key(|name| name.len());
    let (remote, remote_branch) = match matched {
        Some(remote) => (remote.to_string(), upstream[remote.len() + 1..].to_string()),
        None => {
            let (r, b) = upstream.split_once('/').ok_or_else(invalid)?;
            (r.to_string(), b.to_string())
        }
    };
    if remote.is_empty() || remote_branch.is_empty() {
        return Err(invalid());
    }
    Ok((remote, remote_branch))
}

/// The remote half of an `upstream` (`remote/branch`) publish target — the same
/// longest-prefix resolution [`publish_branch`] uses, exposed so per-remote auth
/// can validate the account against the remote actually pushed to (GL-129).
pub fn publish_remote(repo: &str, upstream: &str) -> Result<String, String> {
    split_remote_ref(repo, upstream).map(|(remote, _)| remote)
}

/// The remote a push of `branch` targets (the remote half of [`push_target`]).
/// For per-remote auth validation before [`push_branch`] / [`force_push`].
pub fn branch_push_remote(repo: &str, branch: &str) -> String {
    push_target(repo, branch).0
}

/// The remote a bare `git push` from the checked-out branch targets — that
/// branch's [`push_target`] remote, falling back to `origin` on a detached or
/// unborn HEAD (where the push itself will fail with git's own message anyway).
#[cfg(test)]
pub fn head_push_remote(repo: &str) -> String {
    run_git(repo, &["symbolic-ref", "--short", "-q", "HEAD"])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(|branch| push_target(repo, &branch).0)
        .unwrap_or_else(|| "origin".to_string())
}

pub fn branch_pull_target(repo: &str, branch: &str) -> Result<(String, String), String> {
    ensure_operand(branch)?;
    // `--default` makes an unset key a successful empty read while preserving
    // real config failures, so users get the actionable no-upstream message
    // without masking malformed or unreadable configuration.
    let remote = run_git(
        repo,
        &[
            "config",
            "--get",
            "--default",
            "",
            &format!("branch.{branch}.remote"),
        ],
    )?
    .trim()
    .to_string();
    let merge_ref = run_git(
        repo,
        &[
            "config",
            "--get",
            "--default",
            "",
            &format!("branch.{branch}.merge"),
        ],
    )?
    .trim()
    .to_string();
    if remote.is_empty() || merge_ref.is_empty() {
        return Err(format!(
            "Branch '{branch}' has no remote-tracking upstream. Publish it or set an upstream first."
        ));
    }
    ensure_operand(&remote)?;
    ensure_operand(&merge_ref)?;
    Ok((remote, merge_ref))
}

/// Resolve where `branch` pushes: its configured remote (`branch.<name>.remote`,
/// with local-tracking `.` treated as unset and falling back to `origin`) and
/// refspec (honouring a divergent upstream branch name via
/// `branch.<name>.merge`, else the fully-qualified local branch). Shared by
/// [`push_branch`] and [`force_push`] so both target exactly one ref rather than
/// deferring to `push.default`. Both config reads exit non-zero when unset, which
/// `.ok()` turns into the fallback.
pub(super) fn push_target(repo: &str, branch: &str) -> (String, String) {
    let (remote, destination) = push_destination(repo, branch);
    (remote, format!("refs/heads/{branch}:{destination}"))
}

pub(super) fn push_target_at(repo: &str, branch: &str, expected_oid: &str) -> (String, String) {
    let (remote, destination) = push_destination(repo, branch);
    (remote, format!("{expected_oid}:{destination}"))
}

fn push_destination(repo: &str, branch: &str) -> (String, String) {
    let remote = run_git(repo, &["config", &format!("branch.{branch}.remote")])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && s != ".")
        .unwrap_or_else(|| "origin".to_string());
    let destination = run_git(repo, &["config", &format!("branch.{branch}.merge")])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("refs/heads/{branch}"));
    (remote, destination)
}

/// Fetch every non-skipped remote, prune deleted upstream refs, and import
/// tags (shells out — libgit2 has no network here). Explicit tag import is
/// intentional: Git's default tag auto-follow misses remote-only tags in some
/// no-branch-update refreshes, but the UI derives visible tags from local
/// `refs/tags/*`.
///
/// Each remote is fetched **individually with its own credentials** (GL-129):
/// `cred_by_remote` maps a remote name to the [`TransportCredential`] its bound
/// account resolved to, and remotes without an entry go through the system
/// credential helpers / SSH untouched — that is what keeps unauthenticated
/// Bitbucket/GitLab remotes working next to an account-bound GitHub remote.
/// One failing remote does not stop the others (matching `git fetch --all`
/// semantics); if any remote failed, the combined per-remote output comes back
/// as the error so the toast attributes each part to its remote.
///
/// Tags are fetched through an explicit tag-only refspec after a `--no-tags`
/// branch/prune fetch. A remote tag that would clobber an existing local tag
/// is left alone and treated as non-fatal, so the UI still refreshes branch
/// updates and any tags that did import. Other tag-fetch failures fail that
/// remote. Local-only tags and tags deleted upstream are intentionally
/// preserved unless the user deletes them explicitly: the tag fetch passes
/// `--no-prune` (its explicit `refs/tags/*` refspec would otherwise prune
/// local-only tags under `fetch.prune=true`), and the branch fetch forces
/// `--no-prune-tags` so a repo with `fetch.pruneTags=true` (or
/// `remote.<name>.pruneTags=true`) and a divergent local tag does not fail the
/// remote's fetch with "would clobber existing tag" before the clobber
/// tolerance can run.
pub fn fetch(
    repo: &str,
    cred_by_remote: &HashMap<String, TransportCredential>,
) -> Result<String, String> {
    let mut succeeded: Vec<String> = Vec::new();
    let mut failed: Vec<String> = Vec::new();
    let default_cred = TransportCredential::None;
    for remote in fetch_remotes(repo)? {
        ensure_operand(&remote)?;
        let cred = cred_by_remote.get(&remote).unwrap_or(&default_cred);
        match fetch_remote(repo, &remote, cred) {
            Ok(output) => succeeded.push(label_remote_output(&remote, &output)),
            Err(err) => failed.push(label_remote_output(&remote, &err)),
        }
    }
    let mut combined = String::new();
    for part in failed.iter().chain(succeeded.iter()) {
        combined = join_git_outputs(&combined, part);
    }
    if failed.is_empty() {
        Ok(combined)
    } else {
        Err(combined)
    }
}

/// Fetch one remote: a branch/prune pass, then the explicit tag-refspec pass
/// with clobber tolerance (see [`fetch`] for the tag semantics). If another git
/// process moves a remote-tracking ref after this fetch reads it but before it
/// takes the lock, retry the branch pass once from the now-current oid.
fn fetch_remote(repo: &str, remote: &str, cred: &TransportCredential) -> Result<String, String> {
    let branch_cmd = ["fetch", remote, "--prune", "--no-tags", "--no-prune-tags"];
    let tag_cmd = [
        "fetch",
        remote,
        "--no-tags",
        "--no-prune",
        TAG_FETCH_REFSPEC,
    ];
    let output = match run_transport_stable(repo, cred, &branch_cmd) {
        Ok(output) => output,
        Err(error) if is_concurrent_fetch_ref_update(&error) => {
            run_transport_stable(repo, cred, &branch_cmd)?
        }
        Err(error) => return Err(error),
    };
    match run_transport_stable(repo, cred, &tag_cmd) {
        Ok(tag_output) => Ok(join_git_outputs(&output, &tag_output)),
        Err(e) if is_tag_clobber_rejection(&e) => Ok(join_git_outputs(&output, &e)),
        Err(e) => Err(e),
    }
}

/// Git's stable diagnostic when a concurrent process updates a remote-tracking
/// ref between fetch's read and lock phases. This is safe to retry once; an
/// ordinary lock-file collision, auth failure, or rejected ref update does not
/// match and remains visible to the caller.
pub(super) fn is_concurrent_fetch_ref_update(output: &str) -> bool {
    output.lines().any(|line| {
        line.contains("error: cannot lock ref 'refs/remotes/")
            && line.contains(": is at ")
            && line.contains(" but expected ")
    }) && output.contains("(unable to update local ref)")
}

/// Prefix a remote's fetch output with its name so the combined multi-remote
/// output stays attributable (the single `--all` invocation used to print
/// "Fetching <remote>" headers itself).
fn label_remote_output(remote: &str, output: &str) -> String {
    if output.trim().is_empty() {
        format!("{remote}: up to date")
    } else {
        format!("{remote}:\n{}", output.trim())
    }
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
/// `refs/tags/` refspec avoids any ambiguity with a same-named branch. `cred`
/// selects the inline transport credentials.
pub fn push_tag(
    repo: &str,
    name: &str,
    remote: &str,
    cred: &TransportCredential,
) -> Result<String, String> {
    ensure_operand(name)?;
    ensure_operand(remote)?;
    let refspec = format!("refs/tags/{name}");
    run_transport(repo, cred, &["push", remote, &refspec])
}

/// Delete a tag on `remote` (`git push <remote> --delete refs/tags/<name>`).
/// The fully-qualified `refs/tags/` refspec guarantees a same-named branch on
/// the remote is never deleted. Local deletion is separate ([`super::delete_tag`]);
/// without this, a tag deleted locally but still on the remote is re-imported by
/// the next Fetch's explicit `refs/tags/*` refspec. `cred` selects the account.
///
/// A tag that was never pushed is not an error: absence upstream is the desired
/// end state, so "remote ref does not exist" maps to `Ok` and a combined
/// delete-everywhere still proceeds to the local delete. The subprocess runs
/// with `LC_ALL=C` so that message match is locale-stable (same approach as
/// [`is_tag_clobber_rejection`]).
pub fn delete_remote_tag(
    repo: &str,
    remote: &str,
    name: &str,
    cred: &TransportCredential,
) -> Result<String, String> {
    ensure_operand(remote)?;
    ensure_operand(name)?;
    let refspec = format!("refs/tags/{name}");
    match run_transport_stable(repo, cred, &["push", remote, "--delete", &refspec]) {
        Err(output) if is_missing_remote_ref(&output) => {
            Ok(format!("Tag {name} was not on {remote}"))
        }
        other => other,
    }
}

pub(super) fn is_missing_remote_ref(output: &str) -> bool {
    output.contains("remote ref does not exist")
}

/// Delete a branch on `remote` (`git push <remote> --delete <branch>`). `branch`
/// is the short name on the remote (e.g. `feature/x`, not `origin/feature/x`).
/// `cred` selects the account.
pub fn delete_remote_branch(
    repo: &str,
    remote: &str,
    branch: &str,
    cred: &TransportCredential,
) -> Result<String, String> {
    ensure_operand(remote)?;
    ensure_operand(branch)?;
    run_transport(repo, cred, &["push", remote, "--delete", branch])
}

/// Force-push a single `branch` with `--force-with-lease` — the *safe* force:
/// git refuses if the remote advanced since our last fetch, so a teammate's push
/// is never silently clobbered. Used after history is rewritten (amend, reset,
/// rebase) on an already-pushed branch.
///
/// An explicit `<remote> <refspec>` is always supplied (via [`push_target`]) so
/// the force applies to **only** the selected branch. A bare `git push
/// --force-with-lease` would defer to `push.default`/configured refspecs and
/// could rewrite several remote branches at once. `cred` selects the inline
/// transport credentials.
pub fn force_push(
    repo: &str,
    branch: &str,
    expected_oid: &str,
    cred: &TransportCredential,
) -> Result<String, String> {
    super::head::ensure_expected_branch_tip(repo, branch, expected_oid)?;
    let (remote, refspec) = push_target_at(repo, branch, expected_oid);
    run_transport(
        repo,
        cred,
        &["push", "--force-with-lease", &remote, &refspec],
    )
}
