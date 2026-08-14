use super::support::*;

#[test]
fn parses_gh_version_from_standard_output() {
    assert_eq!(
        parse_gh_version("gh version 2.95.0 (2026-06-17)"),
        Some(GhVersion {
            major: 2,
            minor: 95,
            patch: 0
        })
    );
    assert_eq!(
        parse_gh_version("gh version 2.100.3-dev"),
        Some(GhVersion {
            major: 2,
            minor: 100,
            patch: 3
        })
    );
}

/// The regression: Debian/Arch and source builds carry a git-describe suffix.
/// The old parser choked on it and reported gh as unreadable ("failed to parse
/// gh version output"), which surfaced as a red error — even though the version
/// is right there and merely old.
#[test]
fn parses_gh_version_from_a_distro_build_suffix() {
    assert_eq!(
        parse_gh_version(
            "gh version 2.74.0-19-gea8fc856e (2025-06-09)\nhttps://github.com/cli/cli/releases/latest"
        ),
        Some(GhVersion {
            major: 2,
            minor: 74,
            patch: 0
        })
    );
    assert_eq!(
        parse_gh_version("gh version v2.96.1+deb1 (2026-07-02)"),
        Some(GhVersion {
            major: 2,
            minor: 96,
            patch: 1
        })
    );
}

#[test]
fn a_version_banner_with_no_version_is_still_unparsable() {
    // The URL line alone must not be mistaken for a version.
    assert_eq!(
        parse_gh_version("https://github.com/cli/cli/releases/latest"),
        None
    );
    assert_eq!(parse_gh_version(""), None);
}

/// `gh` is optional: every "can't use gh" failure must be classified as such,
/// so enumerating accounts degrades to "none" instead of nagging with an error.
#[test]
fn every_unusable_gh_failure_is_classified_as_unusable() {
    assert!(GithubError::ProviderUnavailable {
        provider: GH_PROVIDER.to_string()
    }
    .is_gh_unusable());
    assert!(GithubError::UnsupportedVersion {
        installed: "2.74.0".into(),
        required: MIN_GH_VERSION.to_string(),
    }
    .is_gh_unusable());
    assert!(GithubError::GhUnusable {
        detail: "missing capabilities".into()
    }
    .is_gh_unusable());
    // A real failure stays a real failure — it must still reach the user.
    assert!(!GithubError::NotAuthenticated {
        host: "github.com".into(),
        account: None
    }
    .is_gh_unusable());
    assert!(!GithubError::CommandFailed("boom".into()).is_gh_unusable());
}
