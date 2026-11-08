use super::{is_secretlike_username, redact_secrets, redact_secrets_with_values};

#[test]
fn redacts_password_userinfo_but_keeps_username() {
    assert_eq!(
        redact_secrets(
            "fatal: Authentication failed for 'https://alice:glpat-SECRET@gitlab.com/o/r.git'"
        ),
        "fatal: Authentication failed for 'https://alice:***@gitlab.com/o/r.git'"
    );
}

#[test]
fn redacts_x_access_token_style_credentials() {
    assert_eq!(
        redact_secrets("remote: https://x-access-token:ghs_TOKEN@github.com/o/r"),
        "remote: https://x-access-token:***@github.com/o/r"
    );
}

#[test]
fn redacts_the_whole_password_when_it_contains_an_at_sign() {
    assert_eq!(
        redact_secrets("remote: https://alice:p@ss@example.com/o/r"),
        "remote: https://alice:***@example.com/o/r"
    );
}

#[test]
fn redacts_a_token_in_the_username_slot() {
    // GitHub and GitLab both accept token-as-username; the "username" here
    // is the credential, not an account selector.
    assert_eq!(
        redact_secrets(
            "fatal: Authentication failed for 'https://ghp_AbCdEf0123@github.com/o/r.git'"
        ),
        "fatal: Authentication failed for 'https://***@github.com/o/r.git'"
    );
    assert_eq!(
        redact_secrets("https://glpat-XxYyZz123456@gitlab.com/g/r.git"),
        "https://***@gitlab.com/g/r.git"
    );
    assert_eq!(
        redact_secrets("https://github_pat_11ABC0000_aaaaaaaaaa@github.com/o/r.git"),
        "https://***@github.com/o/r.git"
    );
}

#[test]
fn redacts_a_percent_encoded_token_username() {
    // Git percent-decodes userinfo, so `ghp%5F…` authenticates as `ghp_…`.
    // Classifying the raw form would let it through both the prefix list
    // and the token-alphabet fallback.
    assert!(is_secretlike_username("ghp%5FAbCdEf0123456789"));
    assert!(is_secretlike_username("glpat%2DXxYyZz123456"));
    assert_eq!(
        redact_secrets("https://ghp%5FAbCdEf0123456789@github.com/o/r.git"),
        "https://***@github.com/o/r.git"
    );
    // A malformed escape is left literal and must not crash or misclassify.
    assert!(!is_secretlike_username("alice%"));
    assert!(!is_secretlike_username("alice%zz"));
    assert!(!is_secretlike_username("%"));
}

#[test]
fn keeps_account_selector_usernames_visible() {
    // These are how per-remote auth picks an account — redacting them would
    // break a real feature, so the predicate must stay conservative.
    for user in [
        "alice",
        "oauth2",
        "x-token-auth",
        "git",
        "my-long-ish-handle",
    ] {
        let url = format!("https://{user}@github.com/o/r.git");
        assert_eq!(redact_secrets(&url), url, "{user} must stay visible");
    }
}

#[test]
fn leaves_username_only_and_plain_urls_untouched() {
    assert_eq!(
        redact_secrets("https://alice@github.com/o/r.git"),
        "https://alice@github.com/o/r.git"
    );
    assert_eq!(
        redact_secrets("Cloning 'https://github.com/o/r.git'..."),
        "Cloning 'https://github.com/o/r.git'..."
    );
}

#[test]
fn preserves_custom_ports_and_redacts_multiple_urls() {
    assert_eq!(
        redact_secrets(
            "a https://u:p1@ghe.example.test:8443/x and b https://v:p2@gitlab.com/y done"
        ),
        "a https://u:***@ghe.example.test:8443/x and b https://v:***@gitlab.com/y done"
    );
}

#[test]
fn no_url_text_is_returned_unchanged() {
    let text = "fatal: could not read Username for 'x': terminal prompts disabled";
    assert_eq!(redact_secrets(text), text);
}

#[test]
fn does_not_treat_scp_style_ssh_as_a_password_url() {
    // scp-like SSH has no "://" and no password — left as-is.
    let text = "git@github.com:owner/repo.git";
    assert_eq!(redact_secrets(text), text);
}

#[test]
fn active_values_are_redacted_alongside_url_credentials() {
    let text = "request https://alice:url-secret@example.test/path used Bearer live-secret";
    assert_eq!(
        redact_secrets_with_values(text, &["Bearer live-secret", "live-secret"]),
        "request https://alice:***@example.test/path used ***"
    );
}

#[test]
fn empty_active_values_do_not_change_text() {
    let text = "Bearer authentication failed";
    assert_eq!(redact_secrets_with_values(text, &[""]), text);
}

#[test]
fn active_values_match_mixed_url_and_form_encoding() {
    let secret = "a b=Z+%25";
    let text = concat!(
        "raw=a b=Z+%25 ",
        "percent=a%20b%3d%5A%2b%2525 ",
        "form=a+b%3DZ%2B%2525 ",
        "near_miss=a+b%3Db%2B%2525 ",
        "mixed=a+b=%5A+%2525"
    );
    let redacted = redact_secrets_with_values(text, &[secret]);

    assert_eq!(
        redacted,
        concat!(
            "raw=*** ",
            "percent=*** ",
            "form=*** ",
            "near_miss=a+b%3Db%2B%2525 ",
            "mixed=***"
        )
    );
}

#[test]
fn active_values_redact_encoded_base64_padding() {
    let payload = "YWxpY2U6dG9rZW4=";
    assert_eq!(
        redact_secrets_with_values(
            "payload=YWxpY2U6dG9rZW4%3d again=YWxpY2U6dG9rZW4%3D",
            &[payload]
        ),
        "payload=*** again=***"
    );
}
