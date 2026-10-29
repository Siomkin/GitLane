//! Host suggestions for the open dialog: the concrete `Host` names in the
//! user's `~/.ssh/config`. Patterns (`*`, `?`, `!`) are skipped; any typed host
//! is still accepted. `Include` is not followed.

/// The non-pattern `Host` names in `config`, in order, without duplicates.
pub fn hosts(config: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for line in config.lines() {
        let line = line.trim();
        let Some((key, rest)) = line.split_once(|c: char| c.is_whitespace() || c == '=') else {
            continue;
        };
        if !key.eq_ignore_ascii_case("host") {
            continue;
        }
        for name in rest.trim_start_matches(['=', ' ', '\t']).split_whitespace() {
            if name.starts_with('#') {
                break;
            }
            if name.contains(['*', '?', '!']) || out.iter().any(|h| h == name) {
                continue;
            }
            out.push(name.to_string());
        }
    }
    out
}

/// [`hosts`] of the current user's `~/.ssh/config`; none when it is missing.
pub fn user_hosts() -> Vec<String> {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"));
    home.map(|h| std::path::PathBuf::from(h).join(".ssh").join("config"))
        .and_then(|path| std::fs::read_to_string(path).ok())
        .map(|config| hosts(&config))
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
Host !bastion jump # the jump host
Host devbox
Match host foo
";
        assert_eq!(hosts(config), vec!["devbox", "staging", "ci", "jump"]);
    }
}
