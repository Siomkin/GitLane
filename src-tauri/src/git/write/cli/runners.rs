//! Stdout, env, literal-path, and raw git runners.

use super::command::{git_command_bare, git_output};
use super::finish::finish;

/// Run `git -C <repo> <args...>`, returning combined stdout/stderr on success
/// or the error output on a non-zero exit.
pub(in crate::git::write) fn run_git(repo: &str, args: &[&str]) -> Result<String, String> {
    run_git_env(repo, args, &[])
}

/// Run git while accepting specific non-zero exit codes as an idempotent
/// success. This is intentionally narrow: callers must name the exact codes
/// documented by the subcommand (for example, `git config --unset-all`
/// returns 5 when the key is already absent). Every other launch/exit failure
/// still goes through [`finish`] and is surfaced to the user.
pub(in crate::git::write) fn run_git_allow_exit_codes(
    repo: &str,
    args: &[&str],
    allowed: &[i32],
) -> Result<String, String> {
    let output = git_output(repo, args, &[])?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if output
        .status
        .code()
        .is_some_and(|code| allowed.contains(&code))
    {
        return Ok(crate::redact::redact_secrets(
            format!("{stdout}{stderr}").trim(),
        ));
    }
    finish(output.status, &stdout, &stderr, args)
}

/// Run git and return **stdout only, untrimmed**, for callers that parse
/// machine-readable output line by line.
///
/// [`run_git`] concatenates stdout and stderr and trims the result, which is
/// right for the human-facing callers but corrupts porcelain parsing twice
/// over: a warning git wrote to stderr becomes an extra "record", and trimming
/// eats the leading space of the first one (`" M f.txt"` → `"M f.txt"`), which
/// carries meaning — the first status column is the staged half. Failures still
/// go through [`finish`], so error text and redaction are unchanged.
pub(in crate::git::write) fn run_git_stdout(repo: &str, args: &[&str]) -> Result<String, String> {
    let output = git_output(repo, args, &[])?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    if output.status.success() {
        return Ok(stdout);
    }
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    finish(output.status, &stdout, &stderr, args)
}

/// Like [`run_git_stdout`] but with extra environment variables — used to pin
/// `GIT_AUTHOR_*` while replaying commits with `commit-tree`, whose only output
/// is the new oid.
pub(in crate::git::write) fn run_git_env_stdout(
    repo: &str,
    args: &[&str],
    envs: &[(&str, &str)],
) -> Result<String, String> {
    let output = git_output(repo, args, envs)?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    if output.status.success() {
        return Ok(stdout);
    }
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    finish(output.status, &stdout, &stderr, args)
}

/// Run a command whose trailing operands are repository paths, forcing Git to
/// treat every pathspec byte literally. `--` only ends option parsing; without
/// this global mode a real filename such as `:(glob)*` can still expand to
/// unrelated files.
pub(in crate::git::write) fn run_git_literal_paths(
    repo: &str,
    args: &[&str],
) -> Result<String, String> {
    let mut literal_args = Vec::with_capacity(args.len() + 1);
    literal_args.push("--literal-pathspecs");
    literal_args.extend_from_slice(args);
    run_git(repo, &literal_args)
}

/// Like [`run_git`] but with extra environment variables — used to pass a
/// bound account's `GH_TOKEN` through git's credential helper on push.
pub(in crate::git::write) fn run_git_env(
    repo: &str,
    args: &[&str],
    envs: &[(&str, &str)],
) -> Result<String, String> {
    let output = git_output(repo, args, envs)?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    finish(output.status, &stdout, &stderr, args)
}

/// Run a network-facing git command and redact its successful diagnostics
/// before returning them across IPC. Low-level [`run_git`] deliberately keeps
/// successful output byte-for-byte (apart from trimming) because many callers
/// parse it as machine data.
pub(in crate::git::write) fn run_git_env_redacted(
    repo: &str,
    args: &[&str],
    envs: &[(&str, &str)],
) -> Result<String, String> {
    run_git_env(repo, args, envs).map(|output| crate::redact::redact_secrets(&output))
}

/// Run git and return stdout byte-for-byte on success. This is reserved for
/// NUL-delimited machine output where [`run_git`]'s user-facing whitespace trim
/// would corrupt a leading-space path.
pub(in crate::git::write) fn run_git_stdout_raw(
    repo: &str,
    args: &[&str],
) -> Result<Vec<u8>, String> {
    let output = git_output(repo, args, &[])?;
    if output.status.success() {
        return Ok(output.stdout);
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    match finish(output.status, &stdout, &stderr, args) {
        Err(error) => Err(error),
        Ok(_) => unreachable!("a failed git process cannot finish successfully"),
    }
}

/// Like [`run_git_stdout_raw`], but treat the listed non-zero exit codes as
/// success and still return stdout bytes untouched. Used for `git diff
/// --no-index`, which exits 1 when the files differ (the useful case). Does
/// **not** UTF-8-decode, concatenate stderr, or trim — patch bytes stay
/// faithful.
pub(in crate::git::write) fn run_git_stdout_raw_allow_exit_codes(
    repo: &str,
    args: &[&str],
    allowed: &[i32],
) -> Result<Vec<u8>, String> {
    let output = git_output(repo, args, &[])?;
    if output.status.success()
        || output
            .status
            .code()
            .is_some_and(|code| allowed.contains(&code))
    {
        return Ok(output.stdout);
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    match finish(output.status, &stdout, &stderr, args) {
        Err(error) => Err(error),
        Ok(_) => unreachable!("a failed git process cannot finish successfully"),
    }
}

/// Run `git <args>` **without** `-C <repo>`. Returns combined stdout/stderr on
/// success or the error output on a non-zero exit.
pub(in crate::git::write) fn run_git_bare(args: &[&str]) -> Result<String, String> {
    let output = git_command_bare(args)?
        .output()
        .map_err(|e| format!("failed to launch git: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    finish(output.status, &stdout, &stderr, args)
}
