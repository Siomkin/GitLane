use crate::redact::{
    is_secretlike_username, redact_secrets, redact_secrets_with_values, redact_url_credentials,
    redact_url_userinfo, TOKEN_USERNAME_PREFIXES,
};

#[test]
fn a_schemeless_authorization_value_is_hidden_whole() {
    for (input, expected) in [
        (
            "Authorization: glpat-abc123 was rejected",
            "Authorization: ***",
        ),
        ("Authorization: abc123 def", "Authorization: ***"),
        (
            "Authorization: abc123 def; url=x",
            "Authorization: ***; url=x",
        ),
    ] {
        assert_eq!(redact_secrets(input), expected);
    }
}

#[test]
fn a_single_word_scheme_hides_only_its_credential() {
    assert_eq!(
        redact_secrets("Authorization: BEARER abc123 was rejected"),
        "Authorization: BEARER *** was rejected"
    );
    assert_eq!(
        redact_secrets("authorization: token expired, run gh auth login"),
        "authorization: token *** run gh auth login"
    );
}

#[test]
fn a_digest_value_is_not_cut_at_a_quoted_semicolon() {
    assert_eq!(
        redact_secrets(r#"Authorization: Digest username="a;b", response="abc123""#),
        "Authorization: Digest ***"
    );
}

#[test]
fn matches_right_after_an_escape_sequence() {
    for (input, expected) in [
        (
            r"line\nAuthorization: Bearer abc123",
            r"line\nAuthorization: Bearer ***",
        ),
        (r"line\nghp_abc123 end", r"line\n*** end"),
        ("x%20ghp_abc123 end", "x%20*** end"),
    ] {
        assert_eq!(redact_secrets(input), expected);
    }
    for text in ["xy20ghp_abc123", "%zzghp_abc123", "%2zghp_abc123"] {
        assert_eq!(redact_secrets(text), text);
    }
}

#[test]
fn names_in_a_path_stay_but_long_tokens_in_a_path_do_not() {
    for text in [
        "fatal: repository 'https://github.com/acme/glagent-tools.git/' not found",
        "error: cannot lock refs/heads/glrt-fix",
    ] {
        assert_eq!(redact_secrets(text), text);
    }
    let token = "glrt-abcdefghij0123456789";
    assert_eq!(
        redact_secrets(&format!("DELETE /runners/{token} failed")),
        "DELETE /runners/*** failed"
    );
}

#[test]
fn active_values_are_matched_before_a_pattern_can_split_them() {
    assert_eq!(
        redact_secrets_with_values("Authorization: Bearer ab;cd", &["ab;cd"]),
        "Authorization: Bearer ***"
    );
    assert_eq!(
        redact_secrets_with_values("?access_token=ab&cd", &["ab&cd"]),
        "?access_token=***"
    );
}

#[test]
fn url_credentials_pass_hides_credentials_but_not_names() {
    for (input, expected) in [
        (
            "https://ghp_abc:x@github.com/o/r",
            "https://***:***@github.com/o/r",
        ),
        (
            "https://h/r.git?private_token=abc123&a=1",
            "https://h/r.git?private_token=***&a=1",
        ),
        (
            "https://github.com/acme/glagent-tools.git",
            "https://github.com/acme/glagent-tools.git",
        ),
        ("glrt-mirror", "glrt-mirror"),
    ] {
        assert_eq!(redact_url_credentials(input), expected);
    }
}

#[test]
fn redacts_a_bare_token_for_every_prefix() {
    for prefix in TOKEN_USERNAME_PREFIXES {
        assert_eq!(
            redact_secrets(&format!("remote: invalid token {prefix}abc123 for host")),
            "remote: invalid token *** for host",
            "prefix {prefix}"
        );
    }
}

#[test]
fn atlassian_api_tokens_are_secrets_including_their_checksum() {
    let token = "ATATTaaaa-bbbb_cccc=1111";
    assert!(is_secretlike_username(token));
    assert_eq!(
        redact_secrets(&format!("bad token {token}")),
        "bad token ***"
    );
    assert_eq!(
        redact_secrets(&format!("https://{token}@bitbucket.org/o/r.git")),
        "https://***@bitbucket.org/o/r.git"
    );
}

#[test]
fn redacts_a_token_used_as_the_username_with_a_password() {
    assert_eq!(
        redact_secrets("failed: https://ghp_abc123:x-oauth-basic@github.com/o/r"),
        "failed: https://***:***@github.com/o/r"
    );
}

#[test]
fn bare_token_ends_at_its_own_characters() {
    assert_eq!(
        redact_secrets("token glpat-abc123."),
        "token ***.",
        "a closing full stop stays"
    );
    assert_eq!(redact_secrets("glpat-abc.01.xyz failed"), "*** failed");
    assert_eq!(redact_secrets("'ghp_abc123'@host"), "'***'@host");
}

#[test]
fn a_prefix_alone_or_inside_a_word_is_not_a_token() {
    for text in [
        "tokens start with glpat- or ATBB",
        "log/loghp_abc and dGhpATBBcw==",
        "underscore_ghp_abc",
    ] {
        assert_eq!(redact_secrets(text), text);
    }
}

#[test]
fn redacts_authorization_values_and_keeps_the_scheme() {
    for (input, expected) in [
        (
            "> Authorization: Bearer abc123",
            "> Authorization: Bearer ***",
        ),
        ("authorization: token abc123", "authorization: token ***"),
        (
            "Authorization: Basic dXNlcjpwYXNz==",
            "Authorization: Basic ***",
        ),
        (
            "Proxy-Authorization: Bearer abc123",
            "Proxy-Authorization: Bearer ***",
        ),
        ("Authorization: abc123", "Authorization: ***"),
        (
            r#""authorization": "Bearer abc123""#,
            r#""authorization": "Bearer ***"#,
        ),
        (
            r#"Authorization: Digest username="a", response="abc123""#,
            "Authorization: Digest ***",
        ),
    ] {
        assert_eq!(redact_secrets(input), expected);
    }
}

#[test]
fn authorization_value_stops_at_the_end_of_its_line() {
    assert_eq!(
        redact_secrets("Authorization: Bearer abc123\r\nAccept: */*\nnext"),
        "Authorization: Bearer ***\r\nAccept: */*\nnext"
    );
    // Git's progress output overwrites a line with a lone carriage return.
    assert_eq!(
        redact_secrets("Authorization: Bearer abc123\rnext"),
        "Authorization: Bearer ***\rnext"
    );
    assert_eq!(
        redact_secrets("a: Authorization: Bearer abc123\nb"),
        "a: Authorization: Bearer ***\nb"
    );
    assert_eq!(
        redact_secrets("header=Authorization: Bearer abc123; url=x"),
        "header=Authorization: Bearer ***; url=x"
    );
}

#[test]
fn a_percent_encoded_token_stays_whole() {
    assert_eq!(redact_secrets("bad ATATTaaaa%3D1111 end"), "bad *** end");
}

#[test]
fn redacts_token_query_parameters() {
    for (input, expected) in [
        (
            "GET https://gitlab.test/api?private_token=abc123&per_page=1 failed",
            "GET https://gitlab.test/api?private_token=***&per_page=1 failed",
        ),
        (
            "'https://host/p?ACCESS_TOKEN=abc123#top'",
            "'https://host/p?ACCESS_TOKEN=***#top'",
        ),
        ("no url access_token=abc123", "no url access_token=***"),
        ("access_token=ab/c+d=e== end", "access_token=*** end"),
    ] {
        assert_eq!(redact_secrets(input), expected);
    }
}

#[test]
fn text_with_no_token_is_unchanged() {
    for text in [
        "",
        "error: pathspec 'main' did not match; héllo wörld ✓",
        "Authorization failed for github token at 3f2a9c1d0b",
        "Authorization:",
        "?access_token=&page=2",
    ] {
        assert_eq!(redact_secrets(text), text);
    }
}

#[test]
fn redaction_keeps_surrounding_multibyte_text() {
    assert_eq!(redact_secrets("é glpat-abc123 é"), "é *** é");
}

#[test]
fn redacting_twice_changes_nothing_more() {
    let once = redact_secrets(
        "ghp_abc Authorization: Bearer x\nAuthorization: y\n?access_token=z https://a:b@c",
    );
    assert_eq!(redact_secrets(&once), once);
}

#[test]
fn url_userinfo_pass_leaves_token_shaped_names_alone() {
    let url = "https://github.com/acme/glagent-tools.git?access_token=abc123";
    assert_eq!(redact_url_userinfo(url), url);
    assert_eq!(redact_url_userinfo("glrt-mirror"), "glrt-mirror");
}
