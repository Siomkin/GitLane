use super::*;

#[test]
fn stale_appends_the_suffix_the_classifier_reads() {
    let error = WriteError::stale("main changed.");
    assert_eq!(
        error,
        WriteError::StaleLease("main changed. Refresh and try again.".into())
    );
    // An untyped caller that `?`s it keeps the same text, and so the same kind.
    let text: String = error.into();
    assert_eq!(classify_failure(&text).kind, CommandErrorKind::StaleLease);
}

#[test]
fn a_string_becomes_an_unclassified_git_error() {
    assert_eq!(
        WriteError::from("boom".to_string()),
        WriteError::Git("boom".into())
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
fn a_typed_error_matches_what_the_classifier_made_of_the_same_text() {
    for typed in [
        WriteError::stale("Changes to f.txt changed after the confirmation opened."),
        WriteError::AlreadyARepository("/r is already a Git repository.".into()),
    ] {
        let text = typed.to_string();
        assert_eq!(CommandError::from(typed), CommandError::from(text));
    }
}
