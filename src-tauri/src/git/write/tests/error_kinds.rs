//! The `CommandError` each GitLane-authored write failure reaches the frontend
//! as. These pin kind, code and message so moving a producer from a `String`
//! error to a typed one cannot change what crosses IPC.

use super::support::*;
use crate::git::types::{CommandError, CommandErrorKind};

fn to_command_error(error: impl Into<CommandError>) -> CommandError {
    error.into()
}

fn assert_error(error: CommandError, kind: CommandErrorKind, code: Option<&str>, message: &str) {
    assert_eq!(error.kind, kind, "kind of {error:?}");
    assert_eq!(error.code.as_deref(), code, "code of {error:?}");
    assert_eq!(error.message, message, "message of {error:?}");
    assert_eq!(error.detail, None, "detail of {error:?}");
    assert_eq!(error.hook, None, "hook of {error:?}");
}

#[test]
fn a_discard_after_the_file_drifted_is_a_stale_lease() {
    let repo = repo_with_file("pin-discard-drift", "target.txt", b"base\n");
    std::fs::write(repo.0.join("target.txt"), b"edit\n").unwrap();
    let preview = preview_discard_file(repo.path(), "target.txt", None, IndexSide::Unstaged)
        .expect("preview");
    std::fs::write(repo.0.join("target.txt"), b"later edit\n").unwrap();

    let error = discard_file(
        repo.path(),
        "target.txt",
        None,
        IndexSide::Unstaged,
        &preview.expected_state,
    )
    .expect_err("a drifted file must not be discarded");

    assert_error(
        to_command_error(error),
        CommandErrorKind::StaleLease,
        None,
        "Changes to target.txt changed after the confirmation opened. Refresh and try again.",
    );
}

#[test]
fn a_discard_whose_recapture_fails_outright_keeps_the_cause() {
    let repo = repo_with_file("pin-discard-recapture", "target.txt", b"base\n");
    std::fs::write(repo.0.join("target.txt"), b"edit\n").unwrap();
    let preview = preview_discard_file(repo.path(), "target.txt", None, IndexSide::Unstaged)
        .expect("preview");
    // Swap `.git` for a broken gitfile rather than removing it: `discover` stops
    // at an unreadable `.git` here instead of walking up to whatever repository
    // the temp directory happens to sit in.
    let git_dir = repo.0.join(".git");
    let moved = repo.0.join(".git-moved");
    set_discard_capture_test_hook(move || {
        std::fs::rename(&git_dir, moved).unwrap();
        std::fs::write(&git_dir, b"not a gitfile\n").unwrap();
    });

    let error = discard_file(
        repo.path(),
        "target.txt",
        None,
        IndexSide::Unstaged,
        &preview.expected_state,
    )
    .expect_err("a recapture that cannot open the repository must not discard");
    std::fs::remove_file(repo.0.join(".git")).unwrap();
    std::fs::rename(repo.0.join(".git-moved"), repo.0.join(".git")).unwrap();

    let error = to_command_error(error);
    assert_eq!(error.kind, CommandErrorKind::Git, "kind of {error:?}");
    assert!(
        error
            .message
            .starts_with("Could not re-check target.txt, so it was not discarded. "),
        "message of {error:?}"
    );
    assert_eq!(std::fs::read(repo.0.join("target.txt")).unwrap(), b"edit\n");
}

// The preview command gets these straight from the capture, with no
// re-wording in `discard_file`, so each producer's kind is pinned here.
#[test]
fn a_preview_racing_a_content_change_is_a_stale_lease() {
    let repo = repo_with_file("pin-preview-race", "target.txt", b"base\n");
    std::fs::write(repo.0.join("target.txt"), b"edit\n").unwrap();
    let hook_path = repo.0.join("target.txt");
    set_discard_capture_test_hook(move || std::fs::write(hook_path, b"a longer edit\n").unwrap());

    let error = preview_discard_file(repo.path(), "target.txt", None, IndexSide::Unstaged)
        .expect_err("a change during capture must invalidate the preview");

    assert_error(
        to_command_error(error),
        CommandErrorKind::StaleLease,
        None,
        "Changes to target.txt changed while GitLane was inspecting them. Refresh and try again.",
    );
}

#[test]
fn a_preview_of_a_side_with_no_change_is_a_stale_lease() {
    let repo = repo_with_file("pin-preview-no-side", "target.txt", b"base\n");
    std::fs::write(repo.0.join("target.txt"), b"edit\n").unwrap();
    repo.git_ok(&["add", "target.txt"]);

    let error = preview_discard_file(repo.path(), "target.txt", None, IndexSide::Unstaged)
        .expect_err("a fully staged file has no unstaged change to discard");

    assert_error(
        to_command_error(error),
        CommandErrorKind::StaleLease,
        None,
        "The unstaged change for target.txt is no longer available. Refresh and try again.",
    );
}

#[test]
fn init_into_a_folder_that_has_a_repository_names_it() {
    let parent = TempRepo::new("pin-init-existing");
    std::fs::create_dir_all(parent.0.join("app/.git")).unwrap();
    let target = parent.0.join("app");

    let error = init(parent.path(), "app", "main", Readme::Skip, "")
        .expect_err("init into an existing repository must be refused");

    assert_error(
        to_command_error(error),
        CommandErrorKind::Git,
        Some("alreadyARepository"),
        &format!("{} is already a Git repository.", target.to_string_lossy()),
    );
}

#[test]
fn init_in_place_on_an_openable_repository_names_it() {
    let (repo, _) = repo_with_base_commit("pin-init-in-place");

    let error = init_in_place(repo.path()).expect_err("an openable repository must be refused");

    assert_error(
        to_command_error(error),
        CommandErrorKind::Git,
        Some("alreadyARepository"),
        &format!(
            "{} is already a Git repository — try Retry to open it.",
            repo.path()
        ),
    );
}

#[test]
fn init_in_place_rejects_an_already_initialized_directory() {
    let dir = TempRepo::new("init-in-place-existing-repo");
    dir.git_ok(&["init", "-q"]);

    let err = init_in_place(dir.path()).expect_err("already a repo must be rejected");
    assert!(
        err.to_string().contains("already a Git repository"),
        "{err}"
    );
    assert!(err.to_string().contains("try Retry"), "{err}");
}

#[test]
fn a_reset_of_a_branch_whose_tip_moved_is_a_stale_lease() {
    let (repo, base) = repo_with_base_commit("pin-reset-moved-tip");
    repo.git_ok(&["commit", "--allow-empty", "-m", "later"]);
    let tip = rev_parse(&repo, "HEAD");

    let request = ResetRequest::parse(
        Some("main"),
        Some(&base),
        crate::git::types::ResetMode::Soft,
        None,
        None,
        None,
    )
    .expect("valid reset request");
    let error = reset_branch(repo.path(), &base, request)
        .expect_err("a moved branch tip must expire the lease");
    assert!(
        matches!(error, crate::git::write::error::WriteError::StaleLease(_)),
        "typed at the source, not recovered from text: {error:?}"
    );

    // The branch-tip lease lives in `head.rs`, so this pins it for every
    // write that guards on a previewed tip, not only reset.
    use crate::git::write::operands::short_oid;
    assert_error(
        to_command_error(error),
        CommandErrorKind::StaleLease,
        None,
        &format!(
            "refs/heads/main changed from {} to {}. Refresh and try again.",
            short_oid(&base),
            short_oid(&tip)
        ),
    );
}
