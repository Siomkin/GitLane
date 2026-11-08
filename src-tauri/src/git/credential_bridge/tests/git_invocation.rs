//! The `-c` config and environment `git_invocation` builds for the helper-based
//! routes.

use super::*;

#[test]
fn git_invocation_none_is_empty() {
    let invocation = git_invocation(&TransportCredential::None).unwrap();
    assert!(invocation.config.is_empty());
    assert!(invocation.env.is_empty());
    assert!(invocation._broker.is_none());
}

#[test]
fn credential_helper_invocation_can_enable_path_matching_for_its_host() {
    let invocation = git_invocation(&TransportCredential::CredentialHelper {
        host: "dev.azure.com".into(),
        use_http_path: true,
    })
    .unwrap();
    assert_eq!(
        invocation.config,
        [
            "-c".to_string(),
            "credential.https://dev.azure.com.useHttpPath=true".to_string()
        ]
    );
    assert!(invocation.env.is_empty());
}

#[test]
fn git_invocation_gh_clears_then_sets_a_login_pinned_helper() {
    let inv = git_invocation(&TransportCredential::Gh {
        host: "www.github.com".into(),
        gh_host: "github.com".into(),
        login: "octocat".into(),
    })
    .unwrap();
    assert_eq!(
        inv.config,
        vec![
            "-c".to_string(),
            "credential.https://www.github.com.helper=".to_string(),
            "-c".to_string(),
            "credential.https://www.github.com.helper=!f() { \
             [ \"$1\" = get ] || exit 0; \
             t=$(gh auth token --hostname 'github.com' --user 'octocat' </dev/null) && [ -n \"$t\" ] || exit 1; \
             GH_TOKEN=\"$t\" GH_ENTERPRISE_TOKEN=\"$t\" exec gh auth git-credential \"$@\"; \
             }; f"
                .to_string(),
        ]
    );
    // The token value is not in git's environment. A hook can still run the
    // helper it inherits through `-c`.
    assert!(inv.env.is_empty());
}

#[test]
fn git_invocation_glab_clears_then_sets_glab_helper() {
    let inv = git_invocation(&TransportCredential::Glab {
        host: "gitlab.com".into(),
    })
    .unwrap();
    assert_eq!(
        inv.config,
        vec![
            "-c".to_string(),
            "credential.https://gitlab.com.helper=".to_string(),
            "-c".to_string(),
            "credential.https://gitlab.com.helper=!glab auth git-credential".to_string(),
        ]
    );
    assert!(inv.env.is_empty());
}
