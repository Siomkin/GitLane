//! Classify the `git credential fill` read-back after a save.
//!
//! Git asks helpers in config order and keeps the first one that returns a
//! password; that helper's `username=` overrides the one requested. So a helper
//! listed earlier (e.g. GCM in `/etc/gitconfig`) can shadow what a later one just
//! stored. The username that came back is the clue the user needs; the password
//! line is only checked for presence and its value is never bound or returned.

use crate::git::types::{CommandError, CommandErrorKind};

#[derive(Debug, PartialEq, Eq)]
pub(super) enum ReadBack {
    Matches,
    OtherUsername(String),
    Missing,
}

pub(super) fn read_back(filled: &str, expected_username: &str) -> ReadBack {
    let has_password = filled.lines().any(|line| line.starts_with("password="));
    if !has_password {
        return ReadBack::Missing;
    }
    if expected_username.is_empty() {
        return ReadBack::Matches;
    }
    match filled
        .lines()
        .find_map(|line| line.strip_prefix("username="))
    {
        Some(returned) if returned == expected_username => ReadBack::Matches,
        Some(returned) if !returned.is_empty() => ReadBack::OtherUsername(returned.to_string()),
        _ => ReadBack::Missing,
    }
}

/// The save error for a read-back that did not return the saved credential.
pub(super) fn read_back_error(
    read_back: ReadBack,
    credential_host: &str,
    username: &str,
) -> Option<CommandError> {
    match read_back {
        ReadBack::Matches => None,
        ReadBack::Missing => Some(
            CommandError::new(
                CommandErrorKind::Auth,
                "Git credential helper did not return the saved credential.",
            )
            .with_code("credentialNotReturned"),
        ),
        // A token stored as the username (`https://<token>@host`) must not be
        // named or sent back; without a username there is nothing safe to
        // forget either, since a username-less reject erases every entry.
        ReadBack::OtherUsername(returned) if crate::redact::is_secretlike_username(&returned) => {
            Some(
                CommandError::new(
                    CommandErrorKind::Auth,
                    format!(
                        "Git returned a different saved credential instead of @{username}: another \
                         credential helper answers first for {credential_host} with a token stored \
                         as its username. Remove that entry from your helper, then save again."
                    ),
                )
                .with_code("credentialShadowed"),
            )
        }
        ReadBack::OtherUsername(returned) => {
            let mut error = CommandError::new(
                CommandErrorKind::Auth,
                format!(
                    "Git returned a saved credential for @{returned} instead of @{username}. \
                     Another credential helper answers first for {credential_host}. \
                     Git matches usernames exactly, including case."
                ),
            )
            .with_code("credentialShadowed");
            error.credential_username = Some(returned);
            Some(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{read_back, read_back_error, ReadBack};

    #[test]
    fn matching_username_with_password_matches() {
        let filled = "protocol=https\nhost=github.com\nusername=siomkin\npassword=p\n";
        assert_eq!(read_back(filled, "siomkin"), ReadBack::Matches);
    }

    #[test]
    fn a_different_username_is_named() {
        let filled = "username=x-access-token\npassword=p\n";
        assert_eq!(
            read_back(filled, "siomkin"),
            ReadBack::OtherUsername("x-access-token".into())
        );
    }

    #[test]
    fn a_case_only_difference_is_a_different_username() {
        let filled = "username=Siomkin\npassword=p\n";
        assert_eq!(
            read_back(filled, "siomkin"),
            ReadBack::OtherUsername("Siomkin".into())
        );
    }

    #[test]
    fn empty_output_is_missing() {
        assert_eq!(read_back("", "siomkin"), ReadBack::Missing);
    }

    #[test]
    fn a_password_without_a_username_is_missing() {
        assert_eq!(read_back("password=p\n", "siomkin"), ReadBack::Missing);
    }

    #[test]
    fn a_blank_expected_username_accepts_any_username_with_a_password() {
        assert_eq!(
            read_back("username=anyone\npassword=p\n", ""),
            ReadBack::Matches
        );
        assert_eq!(read_back("username=anyone\n", ""), ReadBack::Missing);
    }

    #[test]
    fn the_returned_secret_never_reaches_the_error() {
        let filled = "username=x-access-token\npassword=SECRET-ghp_stale\n"; // ggignore: test fixture
        let error = read_back_error(read_back(filled, "siomkin"), "github.com", "siomkin").unwrap();
        assert_eq!(error.code.as_deref(), Some("credentialShadowed"));
        assert_eq!(error.credential_username.as_deref(), Some("x-access-token"));
        assert!(error.message.contains("@x-access-token"));
        assert!(error.message.contains("@siomkin"));
        let json = serde_json::to_string(&error).unwrap();
        assert!(!json.contains("SECRET"), "{json}");
    }

    #[test]
    fn a_token_returned_as_the_username_is_never_named() {
        let token = "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"; // ggignore: test fixture
        let filled = format!("username={token}\npassword=x-oauth-basic\n");
        let error =
            read_back_error(read_back(&filled, "siomkin"), "github.com", "siomkin").unwrap();
        assert_eq!(error.code.as_deref(), Some("credentialShadowed"));
        assert!(error.credential_username.is_none());
        let json = serde_json::to_string(&error).unwrap();
        assert!(!json.contains(token), "{json}");
        assert!(!json.contains("credentialUsername"), "{json}");
    }

    #[test]
    fn a_missing_read_back_carries_no_username() {
        let error = read_back_error(ReadBack::Missing, "github.com", "siomkin").unwrap();
        assert_eq!(error.code.as_deref(), Some("credentialNotReturned"));
        assert!(error.credential_username.is_none());
    }
}
