//! Commit construction and metadata shared by branch range rewrites.

use super::super::cli::{run_git_allow_exit_codes, run_git_env_stdout, run_git_stdout_raw};

use super::Replay;

/// Read one commit's tree, author and full message. NUL-delimited so a message
/// with blank lines (or an author name with newlines) still parses.
///
/// Decoded strictly rather than lossily: the message and author are about to be
/// written back into a new commit, and `from_utf8_lossy` would replace the
/// undecodable bytes with U+FFFD — silently corrupting metadata this rewrite
/// promises to preserve. Refusing is the honest outcome.
pub(super) fn read_replay(repo: &str, oid: &str) -> Result<Replay, String> {
    let bytes = run_git_stdout_raw(
        repo,
        &["log", "-1", "--format=%T%x00%an%x00%ae%x00%aI%x00%B", oid],
    )?;
    let raw = String::from_utf8(bytes).map_err(|_| {
        format!(
            "Can't replay {}: its message or author is not valid UTF-8, and rewriting it here would corrupt them.",
            &oid[..7.min(oid.len())]
        )
    })?;
    let fields: Vec<&str> = raw.splitn(5, '\0').collect();
    let [tree, author_name, author_email, author_date, message] = fields[..] else {
        return Err(format!("Could not read the metadata of {oid}."));
    };
    Ok(Replay {
        tree: tree.to_string(),
        author_name: author_name.to_string(),
        author_email: author_email.to_string(),
        author_date: author_date.to_string(),
        // `%B` is followed by git's own trailing newline; commit-tree normalizes
        // the message anyway, so only that trailing whitespace is dropped.
        message: message.trim_end().to_string(),
    })
}

/// `-c` overrides pinning the identity this repository commits as — the same
/// ones an ordinary commit gets, so a squash cannot author as someone else.
pub(super) fn identity_config_args(
    repo: &str,
    name: Option<&str>,
    email: Option<&str>,
    identity: &crate::git::types::CapturedIdentity,
) -> Result<Vec<String>, String> {
    let mut args: Vec<String> = Vec::new();
    let expected_author = match (name, email) {
        (Some(n), Some(e)) if !n.is_empty() && !e.is_empty() => Some((n, e)),
        _ => None,
    };
    if let Some((n, e)) = expected_author {
        args.push("-c".into());
        args.push(format!("user.name={n}"));
        args.push("-c".into());
        args.push(format!("user.email={e}"));
    }
    args.extend(super::super::identity::pinned_signing_args(
        repo,
        expected_author,
        identity,
        super::super::identity::SigningOperation::Commit,
    )?);
    Ok(args)
}

/// `commit-tree` ignores `commit.gpgsign` — unlike `git commit` it only signs
/// when handed `-S` — so the effective value has to be read (through the same
/// `-c` overrides) and turned into a flag.
pub(super) fn signing_enabled(repo: &str, config_args: &[String]) -> Result<bool, String> {
    let mut args: Vec<&str> = config_args.iter().map(String::as_str).collect();
    args.extend(["config", "--bool", "--get", "commit.gpgsign"]);
    // Exit 1 is "key not set", not a failure. The output is stdout and stderr
    // concatenated, so match the value line rather than the whole blob — a git
    // warning on stderr would otherwise read as "not signing".
    let value = run_git_allow_exit_codes(repo, &args, &[1])?;
    Ok(value.lines().any(|line| line.trim() == "true"))
}

pub(super) fn commit_tree(
    repo: &str,
    config_args: &[String],
    tree: &str,
    parent: &str,
    message: &str,
    sign: bool,
    envs: &[(&str, &str)],
) -> Result<String, String> {
    let mut args: Vec<&str> = config_args.iter().map(String::as_str).collect();
    args.extend(["commit-tree", tree, "-p", parent, "-m", message]);
    if sign {
        args.push("-S");
    }
    let oid = run_git_env_stdout(repo, &args, envs)?.trim().to_string();
    if oid.is_empty() {
        return Err("git commit-tree returned no commit.".to_string());
    }
    Ok(oid)
}
