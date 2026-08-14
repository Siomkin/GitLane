//! Running a git network command under a resolved transport credential — the
//! bridge's `-c` config and env, merged into one invocation.

use super::super::cli::{run_git_env_redacted, run_git_env_stable_diagnostics_redacted};
use crate::git::credential_bridge::{self, GitInvocation};
use crate::git::transport_auth::TransportCredential;

/// Run a git network command under a resolved [`TransportCredential`]: prepend
/// the bridge's `-c` config and apply its env. For `None`/`Gh` the env is empty,
/// so those paths are byte-identical to a plain `run_git`.
pub(in crate::git::write) fn run_transport(
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
pub(in crate::git::write) fn run_transport_stable(
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

pub(super) fn run_push(
    repo: &str,
    cred: &TransportCredential,
    remote: &str,
    options: &[&str],
    refspecs: &[&str],
) -> Result<String, String> {
    let command = push_command(remote, options, refspecs);
    run_transport(repo, cred, &args_refs(&command))
}

pub(super) fn run_push_stable(
    repo: &str,
    cred: &TransportCredential,
    remote: &str,
    options: &[&str],
    refspecs: &[&str],
) -> Result<String, String> {
    let command = push_command(remote, options, refspecs);
    run_transport_stable(repo, cred, &args_refs(&command))
}
