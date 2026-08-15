//! Squashing a contiguous commit range that does **not** end at the branch tip.
//!
//! The tip squash in `commits.rs` soft-resets onto the range's parent and
//! commits, which only works when the range ends at HEAD. Below the tip there
//! are commits to keep *above* the range, so the rewrite runs on plumbing
//! instead: build the replacement with `commit-tree`, re-parent every commit
//! above it onto the result, then compare-and-swap the branch ref.
//!
//! Replay keeps every tree verbatim, so nothing can conflict, and the new tip's
//! tree equals the old one's, so the index and worktree are never touched — no
//! index snapshot needed here (unlike the tip squash, GL-307). Commit hooks do
//! not run, matching `git rebase`.

use super::cli::{
    run_git, run_git_allow_exit_codes, run_git_env_stdout, run_git_stdout, run_git_stdout_raw,
};

const OFF_THE_CHAIN: &str =
    "The commits to squash are not a first-parent range below the branch tip.";

/// Everything `commit-tree` needs to recreate one commit on a new parent.
struct Replay {
    tree: String,
    author_name: String,
    author_email: String,
    author_date: String,
    message: String,
}

/// Rewrite `parent_oid..newest_oid` into a single commit and replay the commits
/// between `newest_oid` and the branch tip on top of it. Returns the new tip oid.
#[allow(clippy::too_many_arguments)] // Mirrors the guarded squash IPC contract.
pub fn squash_range(
    repo: &str,
    expected_branch: Option<&str>,
    expected_oid: &str,
    newest_oid: &str,
    parent_oid: &str,
    summary: &str,
    description: &str,
    name: Option<&str>,
    email: Option<&str>,
    identity: &crate::git::types::CapturedIdentity,
) -> Result<String, String> {
    if summary.trim().is_empty() {
        return Err("A commit message is required.".to_string());
    }
    let branch = expected_branch.ok_or_else(|| {
        "Squashing commits below the tip needs a checked-out branch, not a detached HEAD."
            .to_string()
    })?;

    let _identity_guard = super::identity::lock_identity_config(repo)?;
    // Validate the ref before it is interpolated into an argv, the way every
    // other ref-moving write in this layer does.
    let branch_ref = super::branches::checked_branch_ref(repo, branch)?;
    super::head::ensure_expected_head(repo, expected_branch, Some(expected_oid))?;
    super::head::ensure_commit_exists(repo, parent_oid)?;

    let span = linear_span(repo, parent_oid, expected_oid)?;
    let newest_position = span
        .iter()
        .position(|oid| oid == newest_oid)
        .ok_or_else(|| "The selected commits are not on the checked-out branch.".to_string())?;
    // `span` is newest-first, so everything before the range's newest commit is
    // what has to be replayed — oldest-first, the order they get rebuilt in.
    let mut replayed: Vec<Replay> = Vec::new();
    for oid in span[..newest_position].iter().rev() {
        replayed.push(read_replay(repo, oid)?);
    }

    let config_args = identity_config_args(repo, name, email, identity)?;
    let sign = signing_enabled(repo, &config_args)?;

    let newest_tree = format!("{newest_oid}^{{tree}}");
    let message = if description.is_empty() {
        summary.to_string()
    } else {
        format!("{summary}\n\n{description}")
    };
    let mut tip = commit_tree(
        repo,
        &config_args,
        &newest_tree,
        parent_oid,
        &message,
        sign,
        &[],
    )?;

    for commit in &replayed {
        tip = commit_tree(
            repo,
            &config_args,
            &commit.tree,
            &tip,
            &commit.message,
            sign,
            &[
                ("GIT_AUTHOR_NAME", commit.author_name.as_str()),
                ("GIT_AUTHOR_EMAIL", commit.author_email.as_str()),
                ("GIT_AUTHOR_DATE", commit.author_date.as_str()),
            ],
        )?;
    }

    // `git reset --soft` gives the tip squash an ORIG_HEAD to undo from; moving
    // a ref directly does not, so set it explicitly and keep `git reset --hard
    // ORIG_HEAD` working the same way after either kind of squash.
    run_git(repo, &["update-ref", "ORIG_HEAD", expected_oid])?;
    // Compare-and-swap: the branch must still be where the caller saw it, or a
    // concurrent commit/checkout would be silently discarded. This is also what
    // moves HEAD, since the branch is checked out.
    run_git(
        repo,
        &[
            "update-ref",
            "-m",
            &format!("squash: {summary}"),
            &branch_ref,
            &tip,
            expected_oid,
        ],
    )?;
    Ok(tip)
}

/// The first-parent chain from `tip_oid` down to `parent_oid`, newest first —
/// exactly the span this rewrite replaces.
///
/// The range is verified link by link rather than trusted, because `A..B` means
/// "reachable from B, not from A" and is **not** proof that `A` is an ancestor
/// of `B`: hand it an unrelated commit and it excludes nothing, so the "span"
/// becomes the branch's whole history and the rewrite would re-parent all of it
/// onto that stranger. `--parents` prints each commit's real parents, so one
/// walk can assert all three things that make the replay safe: every line
/// continues the previous line's first parent, the chain actually *reaches*
/// `parent_oid`, and no commit in it has a second parent (replay re-parents
/// commits one at a time, which would silently drop a merge link — a count
/// heuristic misses the merge whose second parent is already an ancestor).
fn linear_span(repo: &str, parent_oid: &str, tip_oid: &str) -> Result<Vec<String>, String> {
    let range = format!("{parent_oid}..{tip_oid}");
    let listing = run_git_stdout(
        repo,
        &[
            "rev-list",
            "--first-parent",
            "--topo-order",
            "--parents",
            &range,
        ],
    )?;

    let mut span: Vec<String> = Vec::new();
    let mut next: Option<String> = None;
    for line in listing.lines().filter(|line| !line.trim().is_empty()) {
        let mut fields = line.split_whitespace();
        let oid = fields
            .next()
            .ok_or_else(|| "Could not read the commit range.".to_string())?;
        let parents: Vec<&str> = fields.collect();
        if parents.len() > 1 {
            return Err("Can't squash across a merge commit.".to_string());
        }
        if next.is_some_and(|expected| expected != oid) {
            return Err(OFF_THE_CHAIN.to_string());
        }
        span.push(oid.to_string());
        next = parents.first().map(|parent| (*parent).to_string());
    }
    if span.is_empty() || next.as_deref() != Some(parent_oid) {
        return Err(OFF_THE_CHAIN.to_string());
    }

    // Everything in the span gets a new oid, so none of it may already be on a
    // remote. `--not --remotes` drops the commits any remote-tracking ref
    // contains; a shorter list than the span means one of them is published.
    // This is reachability from the *local* remote-tracking refs, so it can miss
    // a commit pushed straight to a URL and can refuse one a stale ref still
    // names — deliberately the conservative side of both.
    let unpushed = run_git_stdout(repo, &["rev-list", &range, "--not", "--remotes"])?
        .lines()
        .filter(|line| !line.trim().is_empty())
        .count();
    if unpushed != span.len() {
        return Err(
            "These commits have already been pushed; squashing them would rewrite published history."
                .to_string(),
        );
    }
    Ok(span)
}

/// Read one commit's tree, author and full message. NUL-delimited so a message
/// with blank lines (or an author name with newlines) still parses.
///
/// Decoded strictly rather than lossily: the message and author are about to be
/// written back into a new commit, and `from_utf8_lossy` would replace the
/// undecodable bytes with U+FFFD — silently corrupting metadata this rewrite
/// promises to preserve. Refusing is the honest outcome.
fn read_replay(repo: &str, oid: &str) -> Result<Replay, String> {
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
fn identity_config_args(
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
    args.extend(super::identity::pinned_signing_args(
        repo,
        expected_author,
        identity,
        super::identity::SigningOperation::Commit,
    )?);
    Ok(args)
}

/// `commit-tree` ignores `commit.gpgsign` — unlike `git commit` it only signs
/// when handed `-S` — so the effective value has to be read (through the same
/// `-c` overrides) and turned into a flag.
fn signing_enabled(repo: &str, config_args: &[String]) -> Result<bool, String> {
    let mut args: Vec<&str> = config_args.iter().map(String::as_str).collect();
    args.extend(["config", "--bool", "--get", "commit.gpgsign"]);
    // Exit 1 is "key not set", not a failure. The output is stdout and stderr
    // concatenated, so match the value line rather than the whole blob — a git
    // warning on stderr would otherwise read as "not signing".
    let value = run_git_allow_exit_codes(repo, &args, &[1])?;
    Ok(value.lines().any(|line| line.trim() == "true"))
}

fn commit_tree(
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
