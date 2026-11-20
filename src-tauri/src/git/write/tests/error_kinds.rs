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
    let git_dir = repo.0.join(".git");
    let moved = repo.0.join(".git-moved");
    set_discard_capture_test_hook(move || std::fs::rename(git_dir, moved).unwrap());

    let error = discard_file(
        repo.path(),
        "target.txt",
        None,
        IndexSide::Unstaged,
        &preview.expected_state,
    )
    .expect_err("a recapture that cannot open the repository must not discard");
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
