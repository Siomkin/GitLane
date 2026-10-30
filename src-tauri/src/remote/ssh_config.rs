//! Host suggestions for the open dialog: the concrete `Host` names in the
//! user's `~/.ssh/config`, read by `ssh2-config`, so `Include`d files count
//! too. Patterns (`*`, `?`) and negated names are skipped; a config the parser
//! can't read gives no suggestions rather than an error.

use std::path::Path;

use ssh2_config::{ParseRule, SshConfig};

/// The non-pattern `Host` names in `config`, in order, without duplicates.
/// `home` resolves `~` and relative `Include` paths.
pub fn hosts(config: &str, home: &Path) -> Vec<String> {
    let Ok(parsed) = SshConfig::default()
        .home_dir(home)
        .parse(&mut config.as_bytes(), ParseRule::ALLOW_UNKNOWN_FIELDS)
    else {
        return Vec::new();
    };
    let mut out: Vec<String> = Vec::new();
    for clause in parsed.get_hosts().iter().flat_map(|h| &h.pattern) {
        let name = &clause.pattern;
        if clause.negated || name.contains(['*', '?']) || out.contains(name) {
            continue;
        }
        out.push(name.clone());
    }
    out
}

/// [`hosts`] of the current user's `~/.ssh/config`; none when it is missing.
pub fn user_hosts() -> Vec<String> {
    let Some(home) = super::home_dir() else {
        return Vec::new();
    };
    std::fs::read_to_string(home.join(".ssh").join("config"))
        .map(|config| hosts(&config, &home))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::hosts;

    #[test]
    fn lists_concrete_hosts_only() {
        let config = "\
Host devbox
  HostName 192.168.1.7
host build-* staging
Host=ci
Host *
  ForwardAgent no
Host !bastion jump
Host devbox
Match host foo
  User me
";
        let home = std::env::temp_dir();
        assert_eq!(
            hosts(config, &home),
            vec!["devbox", "staging", "ci", "jump"]
        );
    }

    #[test]
    fn follows_include_relative_to_dot_ssh() {
        let home = std::env::temp_dir().join(format!("gitlane-sshcfg-{}", std::process::id()));
        let ssh = home.join(".ssh");
        std::fs::create_dir_all(&ssh).unwrap();
        std::fs::write(
            ssh.join("work.conf"),
            "Host work-box\n  HostName 10.0.0.9\n",
        )
        .unwrap();
        let listed = hosts("Include work.conf\nHost devbox\n", &home);
        let _ = std::fs::remove_dir_all(&home);
        assert_eq!(listed, vec!["work-box", "devbox"]);
    }
}
