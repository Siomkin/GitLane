//! `identity` write-path tests.

use super::support::*;

#[test]
fn set_repo_identity_round_trips_signing_and_respects_tri_state() {
    let repo = TempRepo::new("identity-signing");
    repo.git_ok(&["init", "-q"]);

    // A config edited outside GitLane can contain duplicate values. Applying a
    // card must collapse them so later reads/clears remain deterministic.
    repo.git_ok(&["config", "--local", "--add", "user.name", "Old One"]);
    repo.git_ok(&["config", "--local", "--add", "user.name", "Old Two"]);
    repo.git_ok(&[
        "config",
        "--local",
        "--add",
        "user.email",
        "old@example.test",
    ]);

    // Apply a profile that signs: name/email + signing key, format, gpgsign, tags.
    set_repo_identity(
        repo.path(),
        "Work Dev",
        "work@example.test",
        Some("ABCD1234"),
        Some("openpgp"),
        Some(true),
        Some(true),
    )
    .expect("set identity with signing");

    let id = repo_identity(repo.path())
        .expect("read identity")
        .expect("identity present");
    assert_eq!(id.name, "Work Dev");
    assert_eq!(id.email, "work@example.test");
    assert_eq!(id.signing_key.as_deref(), Some("ABCD1234"));
    assert_eq!(id.gpg_format.as_deref(), Some("openpgp"));
    assert_eq!(id.gpg_sign, Some(true));
    assert_eq!(id.tag_gpg_sign, Some(true));
    let names = repo.git(&["config", "--local", "--get-all", "user.name"]);
    assert!(names.status.success(), "updated name should be readable");
    assert_eq!(
        String::from_utf8_lossy(&names.stdout)
            .lines()
            .collect::<Vec<_>>(),
        ["Work Dev"]
    );

    // `None` leaves signing untouched — the legacy name/email editor must not
    // wipe a key the user (or a prior profile) set.
    set_repo_identity(
        repo.path(),
        "Work Dev",
        "work@example.test",
        None,
        None,
        None,
        None,
    )
    .expect("re-save name/email only");
    let id = repo_identity(repo.path()).unwrap().unwrap();
    assert_eq!(
        id.signing_key.as_deref(),
        Some("ABCD1234"),
        "None must not disturb existing signing"
    );
    assert_eq!(id.gpg_sign, Some(true));

    // Switching to a no-signing profile: empty string unsets the key/format,
    // gpgsign=false is written (so signing is explicitly off, not inherited).
    set_repo_identity(
        repo.path(),
        "Solo",
        "solo@example.test",
        Some(""),
        Some(""),
        Some(false),
        Some(false),
    )
    .expect("apply no-signing profile");
    let id = repo_identity(repo.path()).unwrap().unwrap();
    assert_eq!(id.signing_key, None, "empty signing key unsets it");
    assert_eq!(id.gpg_format, None, "empty gpg.format unsets it");
    assert_eq!(
        id.gpg_sign,
        Some(false),
        "gpgSign=false is written, not unset"
    );
    assert_eq!(id.tag_gpg_sign, Some(false), "tag.gpgsign=false is written");
}

#[test]
fn clear_repo_identity_removes_name_email_and_signing() {
    let repo = TempRepo::new("identity-clear");
    repo.git_ok(&["init", "-q"]);
    set_repo_identity(
        repo.path(),
        "Work",
        "work@example.test",
        Some("KEY1"),
        Some("ssh"),
        Some(true),
        Some(true),
    )
    .expect("set identity with signing");

    // Duplicate values previously made `git config --unset` exit 5 while
    // leaving the config untouched. `--unset-all` must clear every value.
    repo.git_ok(&["config", "--local", "--add", "user.name", "Duplicate"]);
    repo.git_ok(&["config", "--local", "--add", "user.signingkey", "KEY2"]);

    clear_repo_identity(repo.path()).expect("clear identity");

    // With name/email gone the read returns None; the signing keys are also
    // unset so a stale key can't outlive the identity it belonged to.
    assert!(
        repo_identity(repo.path()).unwrap().is_none(),
        "identity fully cleared"
    );
    let signing = repo.git(&["config", "--local", "--get", "user.signingkey"]);
    assert!(
        !signing.status.success(),
        "user.signingkey should be unset after clear"
    );
}

#[test]
fn clear_repo_identity_accepts_absent_keys_but_surfaces_real_git_errors() {
    let repo = TempRepo::new("identity-clear-absent");
    repo.git_ok(&["init", "-q"]);
    clear_repo_identity(repo.path()).expect("already-absent identity is cleared");

    let not_a_repo = TempRepo::new("identity-clear-not-repo");
    let error = clear_repo_identity(not_a_repo.path()).expect_err("invalid repo must fail");
    assert!(!error.is_empty(), "real git failure should be surfaced");
}
