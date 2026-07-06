//! Remote, fetch, push, and authentication-aware git writes.

use std::collections::HashMap;

use super::cli::{run_git, run_git_env_stable_diagnostics};
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
    let fetch = run_git(repo, &["remote", "set-url", name, &next_fetch])?;

    if has_push_url(repo, name) {
        let push_url = remote_get_url(repo, name, true)?;
        let next_push = rewrite_https_user(&push_url, username)?;
        let push = run_git(repo, &["remote", "set-url", "--push", name, &next_push])?;
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
pub fn pull(repo: &str, gh_host: Option<&str>) -> Result<String, String> {
    match gh_host {
        Some(host) => {
            let args = credential_args(host, &["pull", "--no-rebase", "--ff-only"]);
            let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
            run_git(repo, &arg_refs)
        }
        None => run_git(repo, &["pull", "--no-rebase", "--ff-only"]),
    }
}

/// Push to the upstream remote (shells out — libgit2 has no network here).
///
/// When `gh_host` is set (the remote is bound to a gh account via the URL
/// username), gh's git-credential helper is wired in inline for that host —
/// git passes the URL username through the credential context, and the helper
/// returns that account's token (gitcredentials(7) semantics). No token ever
/// crosses our process boundary.
pub fn push(repo: &str, gh_host: Option<&str>) -> Result<String, String> {
    match gh_host {
        Some(host) => {
            let args = credential_args(host, &["push"]);
            let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
            run_git(repo, &arg_refs)
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
/// wired in exactly as [`push`] does.
pub fn push_branch(repo: &str, branch: &str, gh_host: Option<&str>) -> Result<String, String> {
    // `branch` becomes a positional refspec in `git push <remote> <refspec>`, so
    // guard it against option injection (e.g. --receive-pack=…) like the others.
    ensure_operand(branch)?;
    let (remote, refspec) = push_target(repo, branch);
    match gh_host {
        Some(host) => {
            let args = credential_args(host, &["push", &remote, &refspec]);
            let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
            run_git(repo, &arg_refs)
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
    gh_host: Option<&str>,
) -> Result<String, String> {
    ensure_operand(branch)?;
    let (remote, remote_branch) = split_remote_ref(repo, upstream)?;
    ensure_operand(&remote)?;
    ensure_operand(&remote_branch)?;
    let refspec = format!("refs/heads/{branch}:refs/heads/{remote_branch}");
    match gh_host {
        Some(host) => {
            let args = credential_args(host, &["push", "--set-upstream", &remote, &refspec]);
            let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
            run_git(repo, &arg_refs)
        }
        None => run_git(repo, &["push", "--set-upstream", &remote, &refspec]),
    }
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
pub fn head_push_remote(repo: &str) -> String {
    run_git(repo, &["symbolic-ref", "--short", "-q", "HEAD"])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(|branch| push_target(repo, &branch).0)
        .unwrap_or_else(|| "origin".to_string())
}

/// The remote a bare `git pull` from the checked-out branch targets: the
/// branch's configured upstream remote. No origin fallback here — unlike push,
/// pull without an upstream should let git surface its own "no tracking
/// information" message.
pub fn head_pull_remote(repo: &str) -> Option<String> {
    run_git(repo, &["symbolic-ref", "--short", "-q", "HEAD"])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .and_then(|branch| {
            run_git(repo, &["config", &format!("branch.{branch}.remote")])
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty() && s != ".")
        })
}

/// Resolve where `branch` pushes: its configured remote (`branch.<name>.remote`,
/// with local-tracking `.` treated as unset and falling back to `origin`) and
/// refspec (honouring a divergent upstream branch name via
/// `branch.<name>.merge`, else a plain `<branch>`). Shared by
/// [`push_branch`] and [`force_push`] so both target exactly one ref rather than
/// deferring to `push.default`. Both config reads exit non-zero when unset, which
/// `.ok()` turns into the fallback.
pub(super) fn push_target(repo: &str, branch: &str) -> (String, String) {
    let remote = run_git(repo, &["config", &format!("branch.{branch}.remote")])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && s != ".")
        .unwrap_or_else(|| "origin".to_string());
    let refspec = run_git(repo, &["config", &format!("branch.{branch}.merge")])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(|merge| format!("{branch}:{merge}"))
        .unwrap_or_else(|| branch.to_string());
    (remote, refspec)
}

/// Fetch every non-skipped remote, prune deleted upstream refs, and import
/// tags (shells out — libgit2 has no network here). Explicit tag import is
/// intentional: Git's default tag auto-follow misses remote-only tags in some
/// no-branch-update refreshes, but the UI derives visible tags from local
/// `refs/tags/*`.
///
/// Each remote is fetched **individually with its own credentials** (GL-129):
/// `auth_by_remote` maps a remote name to the `(host, token)` its bound
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
pub fn fetch(repo: &str, gh_host_by_remote: &HashMap<String, String>) -> Result<String, String> {
    let mut succeeded: Vec<String> = Vec::new();
    let mut failed: Vec<String> = Vec::new();
    for remote in fetch_remotes(repo)? {
        ensure_operand(&remote)?;
        let gh_host = gh_host_by_remote.get(&remote).map(String::as_str);
        match fetch_remote(repo, &remote, gh_host) {
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
/// with clobber tolerance (see [`fetch`] for the tag semantics).
fn fetch_remote(repo: &str, remote: &str, gh_host: Option<&str>) -> Result<String, String> {
    let branch_cmd = ["fetch", remote, "--prune", "--no-tags", "--no-prune-tags"];
    let tag_cmd = [
        "fetch",
        remote,
        "--no-tags",
        "--no-prune",
        TAG_FETCH_REFSPEC,
    ];
    let (branch_args, tag_args): (Vec<String>, Vec<String>) = match gh_host {
        Some(host) => (
            credential_args(host, &branch_cmd),
            credential_args(host, &tag_cmd),
        ),
        None => (
            branch_cmd.iter().map(|s| (*s).to_string()).collect(),
            tag_cmd.iter().map(|s| (*s).to_string()).collect(),
        ),
    };
    let branch_refs: Vec<&str> = branch_args.iter().map(String::as_str).collect();
    let output = run_git_env_stable_diagnostics(repo, &branch_refs, &[])?;
    let tag_refs: Vec<&str> = tag_args.iter().map(String::as_str).collect();
    match run_git_env_stable_diagnostics(repo, &tag_refs, &[]) {
        Ok(tag_output) => Ok(join_git_outputs(&output, &tag_output)),
        Err(e) if is_tag_clobber_rejection(&e) => Ok(join_git_outputs(&output, &e)),
        Err(e) => Err(e),
    }
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
/// `refs/tags/` refspec avoids any ambiguity with a same-named branch. `gh_host` is /// wired in exactly as [`push`] does.
pub fn push_tag(
    repo: &str,
    name: &str,
    remote: &str,
    gh_host: Option<&str>,
) -> Result<String, String> {
    ensure_operand(name)?;
    ensure_operand(remote)?;
    let refspec = format!("refs/tags/{name}");
    match gh_host {
        Some(host) => {
            let args = credential_args(host, &["push", remote, &refspec]);
            let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
            run_git(repo, &arg_refs)
        }
        None => run_git(repo, &["push", remote, &refspec]),
    }
}

/// Delete a tag on `remote` (`git push <remote> --delete refs/tags/<name>`).
/// The fully-qualified `refs/tags/` refspec guarantees a same-named branch on
/// the remote is never deleted. Local deletion is separate ([`super::delete_tag`]);
/// without this, a tag deleted locally but still on the remote is re-imported by
/// the next Fetch's explicit `refs/tags/*` refspec. `gh_host` selects the /// account like [`push`] (URL-username selection).
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
    gh_host: Option<&str>,
) -> Result<String, String> {
    ensure_operand(remote)?;
    ensure_operand(name)?;
    let refspec = format!("refs/tags/{name}");
    let result = match gh_host {
        Some(host) => {
            let args = credential_args(host, &["push", remote, "--delete", &refspec]);
            let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
            run_git_env_stable_diagnostics(repo, &arg_refs, &[])
        }
        None => run_git_env_stable_diagnostics(repo, &["push", remote, "--delete", &refspec], &[]),
    };
    match result {
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
/// `gh_host` selects the  account like [`push`] (URL-username selection).
pub fn delete_remote_branch(
    repo: &str,
    remote: &str,
    branch: &str,
    gh_host: Option<&str>,
) -> Result<String, String> {
    ensure_operand(remote)?;
    ensure_operand(branch)?;
    match gh_host {
        Some(host) => {
            let args = credential_args(host, &["push", remote, "--delete", branch]);
            let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
            run_git(repo, &arg_refs)
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
/// could rewrite several remote branches at once. `gh_host` is  wired in as
/// [`push`] does.
pub fn force_push(repo: &str, branch: &str, gh_host: Option<&str>) -> Result<String, String> {
    ensure_operand(branch)?;
    let (remote, refspec) = push_target(repo, branch);
    match gh_host {
        Some(host) => {
            let args = credential_args(host, &["push", "--force-with-lease", &remote, &refspec]);
            let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
            run_git(repo, &arg_refs)
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
