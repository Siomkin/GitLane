use super::probe::BOUNDARY_CLIS;
use super::sign_out::{looks_like_host, parse_status_hosts};
use super::spec::PROVIDERS;
use super::status::{gitlab_account, parse_azure_account};
use super::*;
use crate::git::forge::ForgeKind;

#[test]
fn sign_out_rejects_a_provider_we_do_not_know() {
    // The provider name crosses IPC, so an unknown one must fail closed
    // rather than reaching a CLI spawn.
    let err = sign_out("not-a-forge").unwrap_err();

    assert!(err.contains("Unsupported provider"), "{err}");
    assert!(err.contains("not-a-forge"), "{err}");
}

#[test]
fn sign_out_reports_providers_that_have_no_cli_sign_out_path() {
    // Every provider without a `cli` or `logout_args` must produce an
    // explanation rather than silently doing nothing.
    for spec in PROVIDERS {
        if spec.cli.is_some() && spec.logout_args.is_some() {
            continue;
        }
        let err = sign_out(spec.provider).unwrap_err();
        assert!(
            err.contains(spec.forge),
            "{}: message should name the forge, got {err}",
            spec.provider
        );
    }
}

#[test]
fn every_provider_that_can_sign_out_names_a_cli() {
    // logout_args without a cli would be unreachable configuration.
    for spec in PROVIDERS {
        if spec.logout_args.is_some() {
            assert!(
                spec.cli.is_some(),
                "{} has logout args but no CLI",
                spec.provider
            );
        }
    }
}

#[test]
fn exposes_auth_only_provider_metadata() {
    let statuses = statuses();
    assert!(statuses.iter().any(|s| s.provider == "bitbucket"));
    assert!(statuses.iter().any(|s| s.provider == "gitlab"));
    assert!(statuses
        .iter()
        .any(|s| s.provider == ForgeKind::CURSOR_ORIGIN_KEY));
    assert!(statuses.iter().all(|s| !s.login_command.is_empty()));
    assert!(statuses.iter().all(|s| !s.docs_url.is_empty()));
}

#[test]
fn gitlab_is_the_only_hostname_scoped_logout() {
    for spec in PROVIDERS {
        assert_eq!(
            spec.logout_needs_hostname,
            spec.provider == "gitlab",
            "{} hostname-scoped logout flag",
            spec.provider
        );
    }
}

#[test]
fn parses_signed_in_hosts_from_glab_status() {
    // Real `glab auth status` shape: host un-indented, details indented.
    let out = "gitlab.com\n  ✓ Logged in to gitlab.com as siomkin (…)\n  ✓ Token found: ***\ngitlab.example.com:8443\n  ✓ Logged in as ada\n";
    assert_eq!(
        parse_status_hosts(out),
        vec![
            "gitlab.com".to_string(),
            "gitlab.example.com:8443".to_string()
        ]
    );
}

#[test]
fn status_host_parsing_ignores_detail_and_prose_lines() {
    // Blank lines, indented detail, and glyph/prose lines are not hosts.
    assert!(parse_status_hosts("\n  ✓ Logged in\n  Not logged in\n").is_empty());
    // De-dupes a host repeated across the listing.
    assert_eq!(
        parse_status_hosts("gitlab.com\n  ✓ x\ngitlab.com\n  ✓ y\n"),
        vec!["gitlab.com".to_string()]
    );
    assert!(looks_like_host("gitlab.com"));
    assert!(looks_like_host("gitlab.example.com:8443"));
    assert!(!looks_like_host("✓ Logged in to gitlab.com"));
    assert!(!looks_like_host(""));
}

#[test]
fn parses_glab_user_into_account() {
    let json = r#"{"id":42,"username":"ada","name":"Ada Lovelace","state":"active"}"#;
    let account = gitlab_account(json).expect("account parsed");
    assert_eq!(account.username, "ada");
    assert_eq!(account.name.as_deref(), Some("Ada Lovelace"));

    // No display name still resolves; empty/garbage does not.
    let minimal = gitlab_account(r#"{"id":7,"username":"solo"}"#).expect("minimal");
    assert_eq!(minimal.username, "solo");
    assert_eq!(minimal.name, None);
    assert!(gitlab_account(r#"{"id":7,"username":""}"#).is_none());
    assert!(gitlab_account("not json").is_none());
}

#[test]
fn every_provider_cli_probes_through_a_known_subprocess_site() {
    // glab and origin must reach their forge boundary (env scrubbing, output
    // bounds); only CLIs without one may be built by the generic probe.
    for spec in PROVIDERS {
        let Some(cli) = spec.cli else { continue };
        assert!(
            BOUNDARY_CLIS.contains(&cli) || matches!(cli, "az" | "tea"),
            "{}: {cli} has no known probe path",
            spec.provider
        );
    }
}

#[test]
fn parses_az_account_user() {
    let json =
        r#"{"id":"sub-guid","name":"My Sub","user":{"name":"alex@contoso.com","type":"user"}}"#;
    let account = parse_azure_account(json).expect("account parsed");
    assert_eq!(account.username, "alex@contoso.com");
    assert_eq!(account.name, None);

    assert!(parse_azure_account(r#"{"user":{"name":""}}"#).is_none());
    assert!(parse_azure_account(r#"{"id":"x"}"#).is_none());
}
