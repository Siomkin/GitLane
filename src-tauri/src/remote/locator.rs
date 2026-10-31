//! `ssh://[user@]host[:port]/absolute/path` — how a remote repository is named
//! everywhere a local path is (tabs, recents, per-repo stores). `host` may be an
//! SSH config alias. The host and user end up on an `ssh` command line, so
//! anything that could be read as an option or break the argument is refused.

use std::fmt;

pub const SCHEME: &str = "ssh://";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Locator {
    pub user: Option<String>,
    pub host: String,
    pub port: Option<u16>,
    /// Absolute path on the host.
    pub path: String,
}

pub fn is_locator(text: &str) -> bool {
    text.starts_with(SCHEME)
}

impl Locator {
    pub fn parse(text: &str) -> Result<Self, String> {
        let rest = text
            .strip_prefix(SCHEME)
            .ok_or_else(|| format!("Not an ssh:// repository locator: {text}"))?;
        let (authority, path) = match rest.find('/') {
            Some(slash) => rest.split_at(slash),
            None => return Err(absolute_path_required()),
        };
        if path.starts_with("/~") {
            return Err(absolute_path_required());
        }
        if path.chars().any(char::is_control) {
            return Err("The repository path contains control characters.".into());
        }
        let (user, host_port) = match authority.rsplit_once('@') {
            Some((user, host)) => (Some(user.to_string()), host),
            None => (None, authority),
        };
        let (host, port) = split_port(host_port)?;
        check_ssh_word(&host, "host")?;
        if let Some(user) = &user {
            check_ssh_word(user, "user")?;
        }
        Ok(Locator {
            user,
            host,
            port,
            path: path.to_string(),
        })
    }

    /// `ssh://[user@]host[:port]`: shared by every repository on this host, and
    /// the key its one session is stored under.
    pub fn origin(&self) -> String {
        let user = self
            .user
            .as_deref()
            .map(|u| format!("{u}@"))
            .unwrap_or_default();
        let port = self.port.map(|p| format!(":{p}")).unwrap_or_default();
        let host = if self.host.contains(':') {
            format!("[{}]", self.host)
        } else {
            self.host.clone()
        };
        format!("{SCHEME}{user}{host}{port}")
    }

    /// The host as the user knows it, for messages.
    pub fn display_host(&self) -> &str {
        &self.host
    }

    /// `ssh` arguments that select the destination: `-p <port>` and `[user@]host`.
    pub fn ssh_destination(&self) -> Vec<String> {
        let mut args = Vec::new();
        if let Some(port) = self.port {
            args.push("-p".to_string());
            args.push(port.to_string());
        }
        args.push(match &self.user {
            Some(user) => format!("{user}@{}", self.host),
            None => self.host.clone(),
        });
        args
    }

    /// A path on this host as a locator.
    pub fn with_path(&self, server_path: &str) -> String {
        format!("{}{server_path}", self.origin())
    }
}

impl fmt::Display for Locator {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}{}", self.origin(), self.path)
    }
}

fn absolute_path_required() -> String {
    "Enter the repository's absolute path on the server (starting with /, without ~).".into()
}

fn split_port(host_port: &str) -> Result<(String, Option<u16>), String> {
    if let Some(bracketed) = host_port.strip_prefix('[') {
        let (host, after) = bracketed
            .split_once(']')
            .ok_or_else(|| format!("Unclosed [ in host: {host_port}"))?;
        let port = match after.strip_prefix(':') {
            Some(port) => Some(parse_port(port)?),
            None if after.is_empty() => None,
            None => return Err(format!("Unexpected text after host: {host_port}")),
        };
        return Ok((host.to_string(), port));
    }
    match host_port.rsplit_once(':') {
        Some((host, port)) => Ok((host.to_string(), Some(parse_port(port)?))),
        None => Ok((host_port.to_string(), None)),
    }
}

fn parse_port(port: &str) -> Result<u16, String> {
    port.parse()
        .ok()
        .filter(|p| *p > 0)
        .ok_or_else(|| format!("Invalid port: {port}"))
}

/// A host or user must be a single plain word: never empty, never an `ssh`
/// option (`-oProxyCommand=…`), no whitespace or control characters.
fn check_ssh_word(word: &str, what: &str) -> Result<(), String> {
    if word.is_empty() {
        return Err(format!("The {what} is empty."));
    }
    if word.starts_with('-') {
        return Err(format!("The {what} may not start with '-'."));
    }
    if word.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(format!(
            "The {what} may not contain spaces or control characters."
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_alias_user_and_port() {
        let l = Locator::parse("ssh://devbox/srv/app").unwrap();
        assert_eq!(
            (l.user.as_deref(), l.host.as_str(), l.port, l.path.as_str()),
            (None, "devbox", None, "/srv/app")
        );
        assert_eq!(l.ssh_destination(), vec!["devbox"]);

        let l = Locator::parse("ssh://me@build.example:2222/home/me/r").unwrap();
        assert_eq!(l.ssh_destination(), vec!["-p", "2222", "me@build.example"]);
        assert_eq!(l.origin(), "ssh://me@build.example:2222");
        assert_eq!(l.to_string(), "ssh://me@build.example:2222/home/me/r");
        assert_eq!(
            l.with_path("/home/me/wt"),
            "ssh://me@build.example:2222/home/me/wt"
        );

        let l = Locator::parse("ssh://[::1]:22/r").unwrap();
        assert_eq!((l.host.as_str(), l.port), ("::1", Some(22)));
        assert_eq!(l.origin(), "ssh://[::1]:22");
    }

    #[test]
    fn requires_an_absolute_path_without_tilde() {
        for bad in ["ssh://devbox", "ssh://devbox/~/app", "ssh://devbox/~me/app"] {
            assert!(
                Locator::parse(bad).unwrap_err().contains("absolute path"),
                "{bad}"
            );
        }
    }

    #[test]
    fn refuses_anything_ssh_could_read_as_an_option() {
        for bad in [
            "ssh://-oProxyCommand=touch%20x/r",
            "ssh://-p/r",
            "ssh://-u@host/r",
            "ssh://dev box/r",
            "ssh://@host/r",
            "ssh://host:0/r",
            "ssh://host:99999/r",
            "ssh://host/r\nmore",
        ] {
            assert!(Locator::parse(bad).is_err(), "{bad}");
        }
        assert!(Locator::parse("/local/path").is_err());
    }
}
