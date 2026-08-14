//! Remote configuration writes: adding, removing, repointing a remote, and
//! rewriting the HTTPS username that selects an account.

use super::fetch::join_git_outputs;

use sha2::{Digest, Sha256};

use super::super::cli::{run_git, run_git_allow_exit_codes, run_git_stdout_raw};
use super::super::operands::{ensure_operand, ensure_url_has_no_credentials};

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
pub(super) fn push_endpoint(repo: &str, remote: &str) -> Result<String, String> {
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
pub(in crate::git::write) fn push_endpoint_token(
    repo: &str,
    remote: &str,
) -> Result<String, String> {
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
