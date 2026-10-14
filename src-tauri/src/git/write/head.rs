//! Preconditions for writes whose user-visible subject is a branch/HEAD.
//!
//! Frontend state is only a snapshot. Every history-changing IPC call carries
//! the branch and oid the user acted on; these helpers fail closed when Git no
//! longer matches that snapshot instead of mutating whichever HEAD is current.

use super::cli::run_git;
use super::operands::ensure_operand;
use super::operands::short_oid;

/// The checked-out branch's short name, or `None` on a detached or unborn HEAD.
///
/// Read as a full refname and stripped here rather than with `--short`, whose
/// shortening is *ambiguity-aware*: with a tag named like the branch it prints
/// `heads/<name>`, because the bare name would no longer be unambiguous. The
/// summary side of this comparison comes from libgit2, which strips the prefix
/// literally, so the two would disagree and every operation guarded by the
/// current branch would refuse until the tag was renamed.
pub(super) fn current_branch(repo: &str) -> Option<String> {
    run_git(repo, &["symbolic-ref", "-q", "HEAD"])
        .ok()
        .and_then(|output| {
            output
                .trim()
                .strip_prefix("refs/heads/")
                .map(str::to_string)
        })
        .filter(|branch| !branch.is_empty())
}

fn resolved_commit(repo: &str, revision: &str) -> Result<String, String> {
    ensure_operand(revision)?;
    let oid = run_git(
        repo,
        &["rev-parse", "--verify", &format!("{revision}^{{commit}}")],
    )?
    .lines()
    .next()
    .unwrap_or("")
    .trim()
    .to_string();
    if oid.is_empty() {
        return Err(format!("Could not resolve {revision} to a commit."));
    }
    Ok(oid)
}

pub(super) fn ensure_commit_exists(repo: &str, revision: &str) -> Result<(), String> {
    resolved_commit(repo, revision).map(|_| ())
}

pub(super) fn ensure_revision_at(
    repo: &str,
    revision: &str,
    expected_oid: &str,
) -> Result<(), String> {
    let actual = resolved_commit(repo, revision)?;
    let expected = resolved_commit(repo, expected_oid)?;
    if actual != expected {
        return Err(format!(
            "{revision} changed from {} to {}. Refresh and try again.",
            short_oid(&expected),
            short_oid(&actual),
        ));
    }
    Ok(())
}

pub(super) fn ensure_expected_head(
    repo: &str,
    expected_branch: Option<&str>,
    expected_oid: Option<&str>,
) -> Result<(), String> {
    let actual_branch = current_branch(repo);
    if actual_branch.as_deref() != expected_branch {
        return Err(format!(
            "HEAD changed from {} to {}. Refresh and try again.",
            describe_branch(expected_branch),
            describe_branch(actual_branch.as_deref()),
        ));
    }

    match expected_oid {
        Some(expected) => ensure_revision_at(repo, "HEAD", expected),
        None => {
            if run_git(repo, &["rev-parse", "--verify", "--quiet", "HEAD"]).is_ok() {
                Err("HEAD gained a commit. Refresh and try again.".to_string())
            } else {
                Ok(())
            }
        }
    }
}

pub(super) fn ensure_expected_branch_tip(
    repo: &str,
    branch: &str,
    expected_oid: &str,
) -> Result<(), String> {
    ensure_operand(branch)?;
    ensure_revision_at(repo, &format!("refs/heads/{branch}"), expected_oid)
}

/// Switch to an existing local branch without checkout's branch/path ambiguity
/// or DWIM creation from a same-named remote-tracking ref. Callers that want to
/// create a tracking branch use the explicit remote-checkout path instead.
/// Returns only hook output and warnings (see [`run_switch`]).
pub(super) fn switch_branch(repo: &str, branch: &str) -> Result<String, String> {
    ensure_operand(branch)?;
    run_switch(repo, &["--no-guess", "--", branch])
}

/// Detach at an explicit revision. Keeping this separate from [`switch_branch`]
/// makes it impossible for a stale branch name to fall through to path checkout.
pub(super) fn switch_detached(repo: &str, revision: &str) -> Result<String, String> {
    ensure_operand(revision)?;
    run_switch(repo, &["--detach", "--", revision])
}

/// Run `git switch <args>` and return only what git didn't print about the
/// switch itself: hook output and warnings. `--quiet` does that from a branch,
/// but from a detached HEAD it would also hide "you are leaving N commits
/// behind", so that case runs loud and drops git's routine lines instead.
/// Git's messages are in the pinned C locale, so their shapes are stable.
/// HEAD is read in-process, so choosing costs no extra git spawn.
pub(super) fn run_switch(repo: &str, args: &[&str]) -> Result<String, String> {
    let detached = git2::Repository::open(repo)
        .and_then(|repo| repo.head_detached())
        .unwrap_or(false);
    let mut argv = vec!["switch"];
    if !detached {
        argv.push("--quiet");
    }
    argv.extend_from_slice(args);
    let output = run_git(repo, &argv)?;
    Ok(if detached {
        drop_switch_chatter(&output)
    } else {
        output
    })
}

fn drop_switch_chatter(output: &str) -> String {
    output
        .lines()
        .filter(|line| !is_switch_chatter(line))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

/// One of git's own `switch` feedback lines, matched by its whole shape so a
/// hook line that merely starts the same way is kept.
fn is_switch_chatter(line: &str) -> bool {
    let quoted = |prefix: &str, suffix: &str| {
        line.strip_prefix(prefix)
            .and_then(|rest| rest.strip_suffix(suffix))
            .is_some_and(|name| !name.is_empty())
    };
    line.starts_with("Previous HEAD position was ")
        || line.starts_with("HEAD is now at ")
        || quoted("Switched to branch '", "'")
        || quoted("Switched to a new branch '", "'")
        || quoted("Your branch is up to date with '", "'.")
        || (line.starts_with("Your branch is ahead of '") && line.contains("' by "))
        || (line.starts_with("Your branch is behind '") && line.contains("' by "))
        || (line.starts_with("Your branch and '") && line.ends_with("' have diverged,"))
        || (line.starts_with("and have ")
            && line.ends_with("different commits each, respectively."))
        || (line.starts_with("Your branch is based on '")
            && line.ends_with("but the upstream is gone."))
        || (line.starts_with("branch '") && line.contains("' set up to track '"))
        || (line.starts_with("  (use \"git ") && line.ends_with(')'))
}

pub(super) fn checkout_expected_branch(
    repo: &str,
    branch: &str,
    expected_oid: &str,
) -> Result<(), String> {
    ensure_expected_branch_tip(repo, branch, expected_oid)?;
    if current_branch(repo).as_deref() != Some(branch) {
        switch_branch(repo, branch)?;
    }
    ensure_expected_head(repo, Some(branch), Some(expected_oid))
}

fn describe_branch(branch: Option<&str>) -> String {
    branch
        .map(|name| format!("branch '{name}'"))
        .unwrap_or_else(|| "detached HEAD".to_string())
}

#[cfg(test)]
mod tests {
    use super::drop_switch_chatter;

    #[test]
    fn drops_git_feedback_but_keeps_look_alike_hook_lines() {
        let output = [
            "Previous HEAD position was abc1234 wip",
            "Switched to branch 'develop'",
            "Your branch is behind 'origin/develop' by 2 commits, and can be fast-forwarded.",
            "  (use \"git pull\" to update your local branch)",
            "branch 'develop' set up to track 'origin/develop'.",
            "branch 'develop' needs composer install",
            "Your branch has a stale vendor/",
            "[php-switch] ready",
        ]
        .join("\n");
        assert_eq!(
            drop_switch_chatter(&output),
            "branch 'develop' needs composer install\nYour branch has a stale vendor/\n[php-switch] ready"
        );
    }
}
