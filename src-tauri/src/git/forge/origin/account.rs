//! Origin CLI session identity. `origin auth status` is plaintext (no `--json`);
//! GitLane keeps only the Account line and never persists the Token line.

use crate::git::types::ForgeAccount;

use super::command::run_origin;

/// The signed-in Origin account, or `None` when the CLI is missing, unsigned,
/// or the status text has no Account line.
pub(crate) fn current_account() -> Option<ForgeAccount> {
    let raw = run_origin(".", &["auth", "status"]).ok()?;
    parse_auth_status(&raw)
}

/// Parse `origin auth status` plaintext. Only the `Account:` value is kept.
pub(super) fn parse_auth_status(text: &str) -> Option<ForgeAccount> {
    for line in text.lines() {
        let Some((label, value)) = line.split_once(':') else {
            continue;
        };
        if !label.trim().eq_ignore_ascii_case("account") {
            continue;
        }
        let username = value.trim();
        if username.is_empty() || username == "-" {
            return None;
        }
        return Some(ForgeAccount {
            username: username.to_string(),
            name: None,
        });
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    const STATUS: &str = "\
Account:     ada@cursor.com
Auth method: login
Endpoint:    https://api2.cursor.sh
Token:       valid
";

    #[test]
    fn parses_account_line_and_ignores_token() {
        let account = parse_auth_status(STATUS).expect("account");
        assert_eq!(account.username, "ada@cursor.com");
        assert_eq!(account.name, None);
        assert!(!account.username.contains("valid"));
        assert!(parse_auth_status("Token: secret\n").is_none());
        assert!(parse_auth_status("Account:   \n").is_none());
        assert!(parse_auth_status("Account: -\n").is_none());
        assert!(parse_auth_status("not status").is_none());
    }
}
