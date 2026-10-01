//! Local repository identity configuration.

use std::sync::{MutexGuard, OnceLock};

use super::cli::{run_git, run_git_allow_exit_codes};
use super::commondir_lock::{commondir_lock, CommondirLocks};

// A profile apply spans several real-git commands. Tauri may execute two IPC
// calls concurrently, so serialize each repository's identity tuple without
// making a slow commit or signing prompt stall unrelated repositories. Values
// live for the process lifetime just like the registry that owns their keys.
static IDENTITY_WRITE_LOCKS: CommondirLocks = OnceLock::new();

/// Serialize identity config mutations with every operation that may create a
/// commit or signed tag. Callers hold this guard from the config snapshot
/// through the git subprocess so a profile apply cannot interleave between
/// those two steps. Linked worktrees share one lock because their local config
/// lives in the repository's common Git directory.
pub(super) fn lock_identity_config(repo: &str) -> Result<MutexGuard<'static, ()>, String> {
    commondir_lock(&IDENTITY_WRITE_LOCKS, repo, "identity")
}

#[derive(Clone, Copy)]
pub(super) enum SigningOperation {
    Commit,
    Tag,
}

/// `git config --worktree` outranks the shared local config where identity
/// cards are stored. Build command-scoped `-c` overrides from the pinned card
/// so a linked worktree cannot silently change its key/format/signing policy.
/// For commit operations, only use signing fields when the caller's captured
/// author still matches the same local identity; this avoids combining a stale
/// author snapshot with signing settings from a newly edited card.
fn pinned_signing_args(
    repo: &str,
    expected_author: Option<(&str, &str)>,
    captured: &crate::git::types::CapturedIdentity,
    operation: SigningOperation,
) -> Result<Vec<String>, String> {
    const STALE: &str =
        "The repository identity changed before this operation. Refresh and try again.";
    let identity = crate::git::read::repo_identity(repo)
        .map_err(|error| format!("Failed to read the repository identity: {error}"))?;
    match captured {
        // The composer saw a card; the repo must still carry exactly that one
        // (a changed signing key alone counts), and an author pin must still
        // name the same person.
        crate::git::types::CapturedIdentity::Card { identity: card } => {
            if identity.as_ref() != Some(card)
                || expected_author.is_some_and(|(name, email)| {
                    identity
                        .as_ref()
                        .is_some_and(|i| i.name != name || i.email != email)
                })
            {
                return Err(STALE.into());
            }
            // INVARIANT: the `is_some_and` comparison above only continues when
            // `identity` is `Some(card)`.
            Ok(signing_args(
                identity.expect("compared equal to Some(card) above"),
                operation,
            ))
        }
        // The composer saw no card ("this computer"); the repo must still have
        // none, else the write would silently sign as the late card.
        crate::git::types::CapturedIdentity::CapturedNone => {
            if identity.is_some() {
                return Err(STALE.into());
            }
            Ok(Vec::new())
        }
        // The composer never read the identity: no card expectation to compare
        // against, but an author pin still demands that the repo's current
        // identity (if any) names the same person, and whatever identity is
        // current supplies the signing policy.
        crate::git::types::CapturedIdentity::NotCaptured => match identity {
            None => {
                if expected_author.is_some() {
                    return Err(STALE.into());
                }
                Ok(Vec::new())
            }
            Some(identity) => {
                if expected_author
                    .is_some_and(|(name, email)| identity.name != name || identity.email != email)
                {
                    return Err(STALE.into());
                }
                Ok(signing_args(identity, operation))
            }
        },
    }
}

/// `-c` overrides pinning a commit's author to the caller's `name`/`email`
/// (both non-empty, else no author pin), plus the signing policy of the card
/// `captured` still matches. `-c user.*` sets author **and** committer for the
/// one invocation, so the commit cannot author as whoever the global config
/// names today.
pub(super) fn pinned_author_args(
    repo: &str,
    name: Option<&str>,
    email: Option<&str>,
    captured: &crate::git::types::CapturedIdentity,
) -> Result<Vec<String>, String> {
    let expected_author = match (name, email) {
        (Some(n), Some(e)) if !n.is_empty() && !e.is_empty() => Some((n, e)),
        _ => None,
    };
    let mut args = Vec::new();
    if let Some((name, email)) = expected_author {
        args.extend(user_args(name, email));
    }
    args.extend(pinned_signing_args(
        repo,
        expected_author,
        captured,
        SigningOperation::Commit,
    )?);
    Ok(args)
}

/// The repository's full card identity as `-c` overrides, for writes with no
/// author payload of their own: merge/rebase/cherry-pick/revert commits
/// (`Commit`) and annotated tags (`Tag`, whose tagger is just as
/// identity-sensitive). Empty when the repository defers to its contextual Git
/// configuration.
pub(super) fn pinned_card_args(
    repo: &str,
    operation: SigningOperation,
) -> Result<Vec<String>, String> {
    let Some(identity) = crate::git::read::repo_identity(repo)
        .map_err(|error| format!("Failed to read the repository identity: {error}"))?
    else {
        return Ok(Vec::new());
    };
    let mut args = user_args(&identity.name, &identity.email);
    args.extend(signing_args(identity, operation));
    Ok(args)
}

fn user_args(name: &str, email: &str) -> Vec<String> {
    vec![
        "-c".to_string(),
        format!("user.name={name}"),
        "-c".to_string(),
        format!("user.email={email}"),
    ]
}

fn signing_args(
    identity: crate::git::types::RepoIdentity,
    operation: SigningOperation,
) -> Vec<String> {
    let mut args = Vec::new();
    let mut push = |key: &str, value: String| {
        args.push("-c".to_string());
        args.push(format!("{key}={value}"));
    };
    if let Some(key) = identity.signing_key {
        push("user.signingkey", key);
    }
    if let Some(format) = identity.gpg_format {
        push("gpg.format", format);
    }
    let enabled = match operation {
        SigningOperation::Commit => identity.gpg_sign,
        SigningOperation::Tag => identity.tag_gpg_sign,
    };
    if let Some(enabled) = enabled {
        push(
            match operation {
                SigningOperation::Commit => "commit.gpgsign",
                SigningOperation::Tag => "tag.gpgsign",
            },
            enabled.to_string(),
        );
    }
    args
}

/// Bind a repo's commit identity by writing `user.name`/`user.email` (and, when
/// provided, signing config) into its local git config, so commits are authored
/// — and optionally signed — as the associated profile/account.
///
/// Signing fields are **tri-state** so the same command serves both the legacy
/// name/email editor and a full profile apply:
/// - `None` leaves the existing local key untouched (a plain name/email save
///   never disturbs signing the user set elsewhere).
/// - `Some("")` unsets the key (switching to a profile that doesn't sign).
/// - `Some(value)` writes the key.
///
/// Only the signing *reference* (GPG key id / SSH key path) is ever stored —
/// never a passphrase or private key.
pub fn set_repo_identity(
    repo: &str,
    name: &str,
    email: &str,
    signing_key: Option<&str>,
    gpg_format: Option<&str>,
    gpg_sign: Option<bool>,
    tag_gpg_sign: Option<bool>,
) -> Result<String, String> {
    let _guard = lock_identity_config(repo)?;
    // No ordering makes a six-command tuple atomic: each `git config` takes
    // `.git/config.lock` on its own, so a competing git process can fail any
    // step. A half-applied switch from card A to card B can pair B's name/email
    // with A's signing key (wrong signer) or B's name with A's email (wrong
    // author), so snapshot the whole tuple first and roll the *entire* tuple
    // back on any failure. Rollback restores the prior state rather than
    // clearing it: a failed save must not silently unpin a working identity.
    let previous = IDENTITY_KEYS.map(|key| (key, read_local(repo, key)));
    let applied = (|| {
        replace_value(repo, "user.name", name)?;
        replace_value(repo, "user.email", email)?;
        apply_optional(repo, "user.signingkey", signing_key)?;
        apply_optional(repo, "gpg.format", gpg_format)?;
        apply_optional(repo, "commit.gpgsign", bool_arg(gpg_sign))?;
        apply_optional(repo, "tag.gpgsign", bool_arg(tag_gpg_sign))
    })();
    if let Err(error) = applied {
        // Best effort: config writes are already failing, so a failure here
        // cannot be repaired automatically. The original cause is what the user
        // needs to see, so rollback errors are deliberately swallowed.
        for (key, value) in &previous {
            let _ = match value {
                Some(value) => replace_value(repo, key, value),
                None => unset_value(repo, key),
            };
        }
        return Err(error);
    }
    Ok(format!("Identity set to {name} <{email}>"))
}

/// Every local config key an identity card owns. Ordered so that a *forward*
/// walk retires signing before author fields — see `clear_repo_identity`.
const IDENTITY_KEYS: [&str; 6] = [
    "commit.gpgsign",
    "tag.gpgsign",
    "user.signingkey",
    "gpg.format",
    "user.name",
    "user.email",
];

/// The current local value of `key`, or `None` when unset. `git config --get`
/// exits 1 for a missing key, which is a normal answer rather than a failure.
fn read_local(repo: &str, key: &str) -> Option<String> {
    let value = run_git_allow_exit_codes(repo, &["config", "--local", "--get", key], &[1]).ok()?;
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

fn bool_arg(value: Option<bool>) -> Option<&'static str> {
    value.map(|on| if on { "true" } else { "false" })
}

fn replace_value(repo: &str, key: &str, value: &str) -> Result<(), String> {
    run_git(repo, &["config", "--local", "--replace-all", key, value]).map(|_| ())
}

fn unset_value(repo: &str, key: &str) -> Result<(), String> {
    // `git config --unset-all` exits 5 only when no matching key exists. That
    // is the one non-zero result that already represents the requested state;
    // permissions, malformed config, and every other failure must propagate.
    run_git_allow_exit_codes(repo, &["config", "--local", "--unset-all", key], &[5]).map(|_| ())
}

/// Tri-state local config write: `None` leaves the key untouched, `Some("")`
/// unsets it, `Some(value)` replaces every local value. An already-absent key
/// is accepted; every other unset failure is surfaced.
fn apply_optional(repo: &str, key: &str, value: Option<&str>) -> Result<(), String> {
    match value {
        None => {}
        Some("") => {
            unset_value(repo, key)?;
        }
        Some(v) => {
            replace_value(repo, key, v)?;
        }
    }
    Ok(())
}

/// Remove the pinned commit identity — name, email, and any signing config —
/// from a repo's local git config so it defers to global config again (the
/// "default git identity" / "No identity" choice). Already-absent keys are an
/// idempotent success; real config/permission failures are surfaced.
pub fn clear_repo_identity(repo: &str) -> Result<String, String> {
    let _guard = lock_identity_config(repo)?;
    // Order matters. Each `git config` call takes `.git/config.lock`
    // independently, so an external git process (or a permission error) can
    // fail the tuple partway through. `repo_identity` reports "no identity"
    // whenever name/email are absent *regardless of leftover signing keys*, so
    // a clear that dropped name/email first but failed before the signing keys
    // would leave the repo silently committing as the global identity while
    // still signing with the removed card's key — the exact wrong-key outcome
    // the pinned-signing checks exist to prevent. Retiring the signing tuple
    // first makes any torn clear fail toward *unsigned*, never toward
    // *signed as someone else*.
    for key in IDENTITY_KEYS {
        unset_value(repo, key)?;
    }
    Ok("Identity cleared".into())
}

#[cfg(test)]
mod tests {
    use super::lock_identity_config;
    use std::{
        path::{Path, PathBuf},
        sync::atomic::{AtomicU64, Ordering},
        time::Duration,
    };

    static NEXT_REPO_ID: AtomicU64 = AtomicU64::new(0);

    struct TestRepo(PathBuf);

    impl TestRepo {
        fn new(tag: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "gitlane-identity-lock-{tag}-{}-{}",
                std::process::id(),
                NEXT_REPO_ID.fetch_add(1, Ordering::Relaxed)
            ));
            git2::Repository::init(&path).expect("test repository should initialize");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestRepo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn identity_lock_recovers_after_poisoning() {
        let repo = TestRepo::new("poison");
        let repo_path = repo.path().to_string_lossy().into_owned();
        let panic = std::thread::spawn(move || {
            let _guard =
                lock_identity_config(&repo_path).expect("identity lock should be available");
            panic!("poison the identity lock");
        })
        .join();

        assert!(panic.is_err());
        assert!(lock_identity_config(repo.path().to_string_lossy().as_ref()).is_ok());
    }

    #[test]
    fn different_repositories_have_independent_identity_locks() {
        let first = TestRepo::new("first");
        let second = TestRepo::new("second");
        let first_guard = lock_identity_config(first.path().to_string_lossy().as_ref())
            .expect("first identity lock should be available");
        let second_path = second.path().to_string_lossy().into_owned();
        let (acquired_tx, acquired_rx) = std::sync::mpsc::channel();

        let second_thread = std::thread::spawn(move || {
            let _guard = lock_identity_config(&second_path)
                .expect("second identity lock should be available");
            acquired_tx
                .send(())
                .expect("acquisition should be reported");
        });

        assert!(acquired_rx.recv_timeout(Duration::from_secs(1)).is_ok());
        drop(first_guard);
        second_thread
            .join()
            .expect("second lock thread should finish");
    }
    fn card_repo(tag: &str) -> TestRepo {
        let repo = TestRepo::new(tag);
        let config = git2::Repository::open(repo.path())
            .unwrap()
            .config()
            .unwrap();
        let mut local = config.open_level(git2::ConfigLevel::Local).unwrap();
        local.set_str("user.name", "Card Name").unwrap();
        local.set_str("user.email", "card@example.test").unwrap();
        local.set_str("user.signingkey", "ABC123").unwrap();
        local.set_str("gpg.format", "openpgp").unwrap();
        local.set_bool("commit.gpgsign", true).unwrap();
        local.set_bool("tag.gpgsign", false).unwrap();
        repo
    }

    fn argv(args: &[&str]) -> Vec<String> {
        args.iter().map(|arg| arg.to_string()).collect()
    }

    /// The argv `commits/create`, `conflict_resolution` and `squash_range` all
    /// pin a commit's author with.
    #[test]
    fn pinned_author_args_pin_the_author_then_the_matching_card_signing() {
        let repo = card_repo("author-argv");
        let path = repo.path().to_string_lossy().into_owned();
        let args = super::pinned_author_args(
            &path,
            Some("Card Name"),
            Some("card@example.test"),
            &crate::git::types::CapturedIdentity::NotCaptured,
        )
        .unwrap();
        assert_eq!(
            args,
            argv(&[
                "-c",
                "user.name=Card Name",
                "-c",
                "user.email=card@example.test",
                "-c",
                "user.signingkey=ABC123",
                "-c",
                "gpg.format=openpgp",
                "-c",
                "commit.gpgsign=true",
            ])
        );
        // A half-given author pins nobody, and a different person is stale.
        assert!(super::pinned_author_args(
            &path,
            Some("Card Name"),
            Some(""),
            &crate::git::types::CapturedIdentity::NotCaptured,
        )
        .unwrap()
        .starts_with(&argv(&["-c", "user.signingkey=ABC123"])));
        assert!(super::pinned_author_args(
            &path,
            Some("Someone Else"),
            Some("else@example.test"),
            &crate::git::types::CapturedIdentity::NotCaptured,
        )
        .is_err());
    }

    /// The argv merge/rebase/cherry-pick/revert (`Commit`) and annotated tags
    /// (`Tag`) pin the full card with.
    #[test]
    fn pinned_card_args_pin_the_whole_card_per_operation() {
        let repo = card_repo("card-argv");
        let path = repo.path().to_string_lossy().into_owned();
        let user = argv(&[
            "-c",
            "user.name=Card Name",
            "-c",
            "user.email=card@example.test",
            "-c",
            "user.signingkey=ABC123",
            "-c",
            "gpg.format=openpgp",
            "-c",
        ]);
        let commit = super::pinned_card_args(&path, super::SigningOperation::Commit).unwrap();
        let tag = super::pinned_card_args(&path, super::SigningOperation::Tag).unwrap();
        assert_eq!(
            commit,
            [user.clone(), argv(&["commit.gpgsign=true"])].concat()
        );
        assert_eq!(tag, [user, argv(&["tag.gpgsign=false"])].concat());

        let bare = TestRepo::new("card-argv-none");
        let bare_path = bare.path().to_string_lossy().into_owned();
        assert!(
            super::pinned_card_args(&bare_path, super::SigningOperation::Commit)
                .unwrap()
                .is_empty()
        );
    }
}
