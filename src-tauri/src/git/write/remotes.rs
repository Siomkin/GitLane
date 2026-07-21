//! Remote, fetch, push, and authentication-aware git writes.

use std::collections::HashMap;

use sha2::{Digest, Sha256};

use super::cli::{
    run_git, run_git_allow_exit_codes, run_git_env_redacted,
    run_git_env_stable_diagnostics_redacted, run_git_stdout_raw,
};
use super::operands::{ensure_operand, ensure_url_has_no_credentials};
use crate::git::credential_bridge::{self, GitInvocation};
use crate::git::transport_auth::TransportCredential;
use crate::git::types::ForcePushRouteLease;

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
    run_git_env_redacted(repo, &args_refs(&args), &env_refs(&env))
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
    run_git_env_stable_diagnostics_redacted(repo, &args_refs(&args), &env_refs(&env))
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

/// Build a single-ref push whose behavior cannot be widened by inherited
/// `push.followTags` or `remote.<name>.mirror` configuration. `--no-mirror`
/// does not override a remote's configured mirror mode on supported Git
/// versions, so pin that setting with command-scoped config instead.
fn push_command(remote: &str, options: &[&str], refspecs: &[&str]) -> Vec<String> {
    let mirror_remote = if remote == "." { "origin" } else { remote };
    let mut command = vec![
        "-c".to_string(),
        "push.followTags=false".to_string(),
        "-c".to_string(),
        format!("remote.{mirror_remote}.mirror=false"),
        "push".to_string(),
        "--no-follow-tags".to_string(),
    ];
    command.extend(options.iter().map(|value| (*value).to_string()));
    command.push(remote.to_string());
    command.extend(refspecs.iter().map(|value| (*value).to_string()));
    command
}

fn run_push(
    repo: &str,
    cred: &TransportCredential,
    remote: &str,
    options: &[&str],
    refspecs: &[&str],
) -> Result<String, String> {
    let command = push_command(remote, options, refspecs);
    run_transport(repo, cred, &args_refs(&command))
}

fn run_push_stable(
    repo: &str,
    cred: &TransportCredential,
    remote: &str,
    options: &[&str],
    refspecs: &[&str],
) -> Result<String, String> {
    let command = push_command(remote, options, refspecs);
    run_transport_stable(repo, cred, &args_refs(&command))
}

/// Add a new remote `name` pointing at `url` (`git remote add`).
pub fn add_remote(repo: &str, name: &str, url: &str) -> Result<String, String> {
    ensure_operand(name)?;
    ensure_operand(url)?;
    ensure_url_has_no_credentials(url)?;
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
    ensure_url_has_no_credentials(url)?;
    let push_urls = configured_push_urls(repo, name)?;
    if push_urls.len() > 1 {
        return Err(format!(
            "Remote '{name}' has multiple push URLs. Edit them in Git before changing this remote in GitLane."
        ));
    }
    let fetch = run_git(repo, &["remote", "set-url", name, url])?;
    if !push_urls.is_empty() {
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

    let fetch_url = remote_get_url(repo, name)?;
    let next_fetch = rewrite_https_user(&fetch_url, username)?;

    let push_urls = configured_push_urls(repo, name)?;
    if push_urls.len() > 1 {
        return Err(format!(
            "Remote '{name}' has multiple push URLs. Edit them in Git before changing its username in GitLane."
        ));
    }
    if let Some(push_url) = push_urls.first() {
        let next_push = rewrite_https_user(push_url, username)?;
        let fetch = run_git(repo, &["remote", "set-url", name, &next_fetch])?;
        let push = run_git(repo, &["remote", "set-url", "--push", name, &next_push])?;
        return Ok(join_git_outputs(&fetch, &push));
    }
    let fetch = run_git(repo, &["remote", "set-url", name, &next_fetch])?;
    Ok(fetch)
}

/// Explicit push URLs only; unlike `remote get-url --push --all`, this does not
/// synthesize the fetch URL when no pushurl is configured. Exit 1 means absent;
/// other config failures remain actionable errors.
fn configured_push_urls(repo: &str, name: &str) -> Result<Vec<String>, String> {
    let key = format!("remote.{name}.pushurl");
    let raw = run_git_allow_exit_codes(repo, &["config", "--get-all", &key], &[1])?;
    Ok(raw
        .lines()
        .filter(|url| !url.is_empty())
        .map(str::to_string)
        .collect())
}

/// Resolve exactly one effective push endpoint. `remote get-url --push --all`
/// applies Git's URL rewrite rules, so this is the target the transport would
/// really contact rather than merely the raw configured value.
fn push_endpoint(repo: &str, remote: &str) -> Result<String, String> {
    ensure_operand(remote)?;
    let endpoint = if remote == "." {
        ".".to_string()
    } else {
        let raw = run_git_stdout_raw(repo, &["remote", "get-url", "--push", "--all", remote])?;
        let mut records = raw.split(|byte| *byte == b'\n').collect::<Vec<_>>();
        if records.last().is_some_and(|record| record.is_empty()) {
            records.pop();
        }
        let endpoints = records
            .into_iter()
            .map(|record| {
                let value = std::str::from_utf8(record)
                    .map_err(|_| "A remote push URL is not valid UTF-8.".to_string())?;
                if value.is_empty()
                    || value.trim() != value
                    || value.chars().any(char::is_control)
                {
                    return Err(format!(
                        "Remote '{remote}' has a push URL with unsupported whitespace or control characters."
                    ));
                }
                Ok(value.to_string())
            })
            .collect::<Result<Vec<_>, String>>()?;
        if endpoints.len() != 1 {
            return Err(format!(
                "Remote '{remote}' must have exactly one push URL before it can be force-pushed safely."
            ));
        }
        endpoints.into_iter().next().expect("length checked")
    };
    ensure_operand(&endpoint)?;
    ensure_url_has_no_credentials(&endpoint)?;
    Ok(endpoint)
}

/// Return an opaque digest of the one effective push endpoint, safe to carry
/// across IPC. Force-push fails closed on multi-push remotes: one refspec would
/// otherwise be sent to every configured push URL.
pub(super) fn push_endpoint_token(repo: &str, remote: &str) -> Result<String, String> {
    let endpoint = push_endpoint(repo, remote)?;

    let mut digest = Sha256::new();
    digest.update(b"gitlane-force-push-endpoint-v1\0");
    digest.update(endpoint.as_bytes());
    let token = digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok(token)
}

fn remote_get_url(repo: &str, name: &str) -> Result<String, String> {
    Ok(run_git(repo, &["remote", "get-url", name])?
        .trim()
        .to_string())
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
#[allow(clippy::items_after_test_module)] // Tests stay beside the URL helper they exercise.
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
    run_push(repo, cred, &remote, &[], &[&refspec])
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
    // configuration explicitly after the push succeeds. Push + config are not
    // one transaction: dying in between leaves the branch published but
    // untracked, which a re-publish repairs.
    let pushed = run_push(repo, cred, &remote, &[], &[&refspec])?;
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

/// Resolve where `branch` pushes: its remote via git's own push precedence
/// (`branch.<name>.pushRemote` → `remote.pushDefault` → `branch.<name>.remote`,
/// including Git's local-repository `.` target) and refspec (honouring a
/// divergent upstream branch name via
/// `branch.<name>.merge`, else the fully-qualified local branch). Shared by
/// [`push_branch`] and [`force_push`] so both target exactly one ref rather than
/// deferring to `push.default`. Config reads exit non-zero when unset, which
/// `.ok()` turns into the fallback.
pub(super) fn push_target(repo: &str, branch: &str) -> (String, String) {
    let (remote, destination) = push_destination(repo, branch);
    (remote, format!("refs/heads/{branch}:{destination}"))
}

pub(super) fn push_target_at(repo: &str, branch: &str, expected_oid: &str) -> (String, String) {
    let (remote, destination) = push_destination(repo, branch);
    (remote, format!("{expected_oid}:{destination}"))
}

pub(super) fn push_destination(repo: &str, branch: &str) -> (String, String) {
    let config = |key: String| {
        run_git(repo, &["config", &key])
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    };
    let upstream_remote = config(format!("branch.{branch}.remote"));
    // `git push` resolves its remote as branch.<name>.pushRemote →
    // remote.pushDefault → branch.<name>.remote → origin; a terminal push and a
    // GitLane push must land on the same remote (and pick that remote's
    // credentials) in triangular setups too.
    let remote = config(format!("branch.{branch}.pushRemote"))
        .or_else(|| config("remote.pushDefault".to_string()))
        .or_else(|| upstream_remote.clone())
        .unwrap_or_else(|| "origin".to_string());
    // `branch.<name>.merge` names the branch on the *fetch* upstream. It only
    // describes a push destination when pushing to that same remote; on a
    // triangular push remote git's push.default=simple uses the same-named
    // branch instead.
    let destination = if upstream_remote.as_deref() == Some(remote.as_str()) {
        config(format!("branch.{branch}.merge"))
    } else {
        None
    }
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
        let skip = ["skipFetchAll", "skipDefaultUpdate"].iter().any(|key| {
            run_git(
                repo,
                &["config", "--bool", &format!("remote.{remote}.{key}")],
            )
            .ok()
            .is_some_and(|value| value.trim().eq_ignore_ascii_case("true"))
        });
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
    run_push(repo, cred, remote, &[], &[&refspec])
}

/// Delete a tag on `remote` only when it still points at `expected_oid`. The
/// exact `--force-with-lease` prevents a tag moved after the confirmation was
/// opened from being erased. The fully-qualified `refs/tags/` destination also
/// guarantees a same-named branch on the remote is never deleted. Local
/// deletion is separate ([`super::delete_tag`]); without this, a tag deleted
/// locally but still on the remote is re-imported by the next Fetch's explicit
/// `refs/tags/*` refspec. `cred` selects the account.
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
    expected_oid: &str,
    cred: &TransportCredential,
) -> Result<String, String> {
    ensure_operand(remote)?;
    ensure_operand(name)?;
    ensure_operand(expected_oid)?;
    let destination = format!("refs/tags/{name}");
    let lease = format!("--force-with-lease={destination}:{expected_oid}");
    match run_push_stable(repo, cred, remote, &[&lease, "--delete"], &[&destination]) {
        Err(output) if is_missing_remote_ref(&output) => {
            Ok(format!("Tag {name} was not on {remote}"))
        }
        Err(output) => {
            // File transports report an already-absent leased ref as a generic
            // stale-info rejection. Confirm absence on the same effective push
            // endpoint before treating that desired end state as success. A
            // moved ref produces output here and therefore preserves the
            // original lease failure.
            let probe = push_endpoint(repo, remote).and_then(|endpoint| {
                run_transport(
                    repo,
                    cred,
                    &["ls-remote", "--refs", &endpoint, &destination],
                )
            });
            match probe {
                Ok(found) if found.trim().is_empty() => {
                    Ok(format!("Tag {name} was not on {remote}"))
                }
                _ => Err(output),
            }
        }
        ok => ok,
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
    expected_oid: &str,
    cred: &TransportCredential,
) -> Result<String, String> {
    ensure_operand(remote)?;
    ensure_operand(branch)?;
    ensure_operand(expected_oid)?;
    let destination = format!("refs/heads/{branch}");
    let lease = format!("--force-with-lease={destination}:{expected_oid}");
    run_push(repo, cred, remote, &[&lease, "--delete"], &[&destination])
}

/// Force-push a single `branch` with the exact lease a confirmation preview
/// captured. Git refuses when the server-side destination no longer matches
/// that snapshot, even if a later fetch advanced the local remote-tracking ref.
/// Used after history is rewritten (amend, reset, rebase) on an already-pushed
/// branch.
///
/// The preview's remote and destination are compared with the freshly-resolved
/// push route before transport starts. The source refspec uses the previewed
/// local oid rather than the mutable branch name, and the explicit
/// `<destination>:<oid>` (or `<destination>:` when absent) lease never asks Git
/// to infer an expectation from live tracking state. `cred` selects the inline
/// credentials.
pub fn force_push(
    repo: &str,
    branch: &str,
    expected_oid: &str,
    route: &ForcePushRouteLease,
    cred: &TransportCredential,
) -> Result<String, String> {
    super::head::ensure_expected_branch_tip(repo, branch, expected_oid)?;
    ensure_operand(&route.remote)?;
    ensure_operand(&route.destination_ref)?;
    if let Some(oid) = route.destination_oid.as_deref() {
        ensure_operand(oid)?;
    }
    ensure_operand(&route.push_endpoint_token)?;
    validate_force_push_route_inner(
        repo,
        branch,
        &route.remote,
        &route.destination_ref,
        &route.push_endpoint_token,
    )?;

    let refspec = format!("{expected_oid}:{}", route.destination_ref);
    // An empty expected value is meaningful Git syntax: the destination must
    // still not exist when receive-pack applies the update.
    let lease = format!(
        "--force-with-lease={}:{}",
        route.destination_ref,
        route.destination_oid.as_deref().unwrap_or("")
    );
    // Keep the named remote as the transport operand: `remote get-url` already
    // applies Git's longest-match URL rewrite once. Feeding that resolved URL
    // back to `git push` would apply a second chained rewrite and contact a
    // different endpoint. The route check immediately precedes this spawn; as
    // with the ref guards, an external config edit in that narrow window can
    // only be eliminated by Git gaining an atomic config lease.
    run_push(repo, cred, &route.remote, &[&lease], &[&refspec])
}

fn validate_force_push_route_inner(
    repo: &str,
    branch: &str,
    expected_remote: &str,
    expected_destination: &str,
    expected_endpoint_token: &str,
) -> Result<(), String> {
    if !expected_destination.starts_with("refs/heads/") {
        return Err(format!(
            "Unsupported force-push destination {expected_destination}. Preview the force-push again."
        ));
    }
    let (remote, destination) = push_destination(repo, branch);
    if !destination.starts_with("refs/heads/") {
        return Err(format!(
            "Unsupported force-push destination {destination}. Preview the force-push again."
        ));
    }
    if remote != expected_remote || destination != expected_destination {
        return Err(format!(
            "Push destination changed from {expected_remote} {expected_destination} to {remote} {destination}. Preview the force-push again."
        ));
    }
    let endpoint_token = push_endpoint_token(repo, expected_remote)?;
    if endpoint_token != expected_endpoint_token {
        return Err(format!(
            "Push endpoint for remote '{expected_remote}' changed. Preview the force-push again."
        ));
    }
    Ok(())
}

/// Validate the previewed force-push route before resolving credentials. The
/// mutation repeats the endpoint check immediately before it spawns git, so
/// config drift at either boundary normally fails closed (subject to the same
/// narrow external config-write race as Git's other pre-spawn guards).
pub fn validate_force_push_route(
    repo: &str,
    branch: &str,
    expected_remote: &str,
    expected_destination: &str,
    expected_endpoint_token: &str,
) -> Result<(), String> {
    ensure_operand(branch)?;
    ensure_operand(expected_remote)?;
    ensure_operand(expected_destination)?;
    ensure_operand(expected_endpoint_token)?;
    validate_force_push_route_inner(
        repo,
        branch,
        expected_remote,
        expected_destination,
        expected_endpoint_token,
    )
}
