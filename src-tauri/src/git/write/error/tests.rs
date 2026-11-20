use super::*;
use crate::git::types::RepoOpenErrorKind;

#[test]
fn stale_appends_the_suffix_the_classifier_reads() {
    let error = WriteError::stale("main changed.");
    assert!(
        matches!(&error, WriteError::StaleLease(m) if m == "main changed. Refresh and try again."),
        "{error:?}"
    );
    // An untyped caller that `?`s it keeps the same text, and so the same kind.
    let text: String = error.into();
    assert_eq!(classify_failure(&text).kind, CommandErrorKind::StaleLease);
}

#[test]
fn a_string_becomes_an_unclassified_git_error() {
    let error = WriteError::from("boom".to_string());
    assert!(
        matches!(&error, WriteError::Git(m) if m == "boom"),
        "{error:?}"
    );
}

#[test]
fn each_variant_maps_to_its_command_error() {
    let stale = CommandError::from(WriteError::stale("x changed."));
    assert_eq!(stale.kind, CommandErrorKind::StaleLease);
    assert_eq!(stale.code, None);
    assert_eq!(stale.message, "x changed. Refresh and try again.");

    let repo = CommandError::from(WriteError::AlreadyARepository(
        "/r is already a Git repository.".into(),
    ));
    assert_eq!(repo.kind, CommandErrorKind::Git);
    assert_eq!(repo.code.as_deref(), Some("alreadyARepository"));
    assert_eq!(repo.message, "/r is already a Git repository.");

    // git's own text still goes through the classifier.
    let git = CommandError::from(WriteError::Git(
        "fatal: Authentication failed for 'https://example.test/r.git/'".into(),
    ));
    assert_eq!(git.kind, CommandErrorKind::Auth);
}

#[test]
fn an_open_failure_keeps_its_libgit2_kind() {
    let open = WriteError::Open(RepoOpenError {
        kind: RepoOpenErrorKind::Missing,
        message: "/gone does not exist.".into(),
        path: "/gone".into(),
    });
    assert_eq!(open.to_string(), "/gone does not exist.");
    let error = CommandError::from(open);
    assert_eq!(error.kind, CommandErrorKind::MissingPath);
    assert_eq!(error.message, "/gone does not exist.");
    assert_eq!(error.path.as_deref(), Some("/gone"));
}

#[test]
fn a_typed_error_matches_what_the_classifier_made_of_the_same_text() {
    for typed in [
        WriteError::stale("Changes to f.txt changed after the confirmation opened."),
        WriteError::AlreadyARepository("/r is already a Git repository.".into()),
    ] {
        let text = typed.to_string();
        assert_eq!(CommandError::from(typed), CommandError::from(text));
    }
}
