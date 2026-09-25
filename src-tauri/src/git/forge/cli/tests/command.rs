use std::ffi::OsStr;

use super::support::*;

#[test]
fn gh_commands_clear_repository_local_environment() {
    let command = gh_command(".", &["version"]);
    for key in crate::git::REPOSITORY_LOCAL_ENV_VARS {
        assert!(
            command
                .get_envs()
                .any(|(name, value)| name == OsStr::new(key) && value.is_none()),
            "{key} must be removed from the gh subprocess environment"
        );
    }
}

/// `gh stack link` takes no `--repo`, so the validated authority travels as
/// `GH_REPO` / `GH_HOST` — explicit values, which also beat any the app
/// inherited from its launching shell.
#[test]
fn repository_pinned_gh_commands_carry_the_validated_authority_in_env() {
    let repository = GithubRepository {
        host: "ghe.example.test:8443".into(),
        owner: "octo".into(),
        name: "app".into(),
    };
    let command = gh_command_in_repository(".", &repository, &["stack", "link", "1", "2"]);
    let env = |key: &str| {
        command
            .get_envs()
            .find(|(name, _)| *name == OsStr::new(key))
            .and_then(|(_, value)| value)
            .map(|value| value.to_string_lossy().into_owned())
    };
    assert_eq!(
        env("GH_REPO").as_deref(),
        Some("ghe.example.test:8443/octo/app")
    );
    assert_eq!(env("GH_HOST").as_deref(), Some("ghe.example.test:8443"));
    assert_eq!(
        command.get_args().collect::<Vec<_>>(),
        ["stack", "link", "1", "2"].map(OsStr::new)
    );
}

#[test]
fn missing_gh_copy_is_preserved() {
    assert_eq!(
        GH_NOT_FOUND,
        "GitHub CLI (gh) not found on PATH — install it from https://cli.github.com to use pull requests."
    );
}
