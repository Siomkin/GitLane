//! Commit attribution in a format-patch mailbox: which commit a file belongs
//! to, and what a bare unified diff carries instead.

use super::support::*;
use crate::git::types::ChangeStatus;

#[test]
fn format_patch_preamble_never_leaks_into_hunks() {
    let files = parse_unified_diff(MAILBOX);
    assert_eq!(files.len(), 3);

    // Commit 1's file: exactly the 4 body lines its @@ header promises - no
    // phantom lines from the trailer or commit 2's preamble, and no `R` status
    // from the prose `rename from` line.
    let one = &files[0];
    assert_eq!(one.path, "src/one.txt");
    assert_eq!(one.status, ChangeStatus::Modified);
    assert_eq!((one.add, one.del), (1, 1));
    assert_eq!(one.hunks.len(), 1);
    let kinds: Vec<&str> = one.hunks[0].lines.iter().map(|l| l.kind.as_str()).collect();
    assert_eq!(kinds, ["ctx", "del", "add", "ctx"]);

    // Commit 2 re-touches the file (its own entry) with a count-less old side
    // (`-3` == `-3,1`) and adds a new file.
    let again = &files[1];
    assert_eq!(again.path, "src/one.txt");
    assert_eq!((again.add, again.del), (1, 0));
    let hunk = &again.hunks[0];
    let kinds: Vec<&str> = hunk.lines.iter().map(|l| l.kind.as_str()).collect();
    assert_eq!(kinds, ["ctx", "add"]);

    assert_eq!(files[2].path, "src/two.txt");
    assert_eq!(files[2].status, ChangeStatus::Added);
    assert_eq!((files[2].add, files[2].del), (1, 0));
}

#[test]
fn attributes_files_to_their_commit() {
    let files = parse_unified_diff(MAILBOX);

    // Commit 1: oid from the boundary line; the folded Subject is joined into
    // one line with the [PATCH 1/2] marker stripped.
    assert_eq!(
        files[0].commit_oid.as_deref(),
        Some("1111111111111111111111111111111111111111")
    );
    assert_eq!(
        files[0].commit_subject.as_deref(),
        Some("feat: first commit with a subject long enough to fold onto a continuation line")
    );

    // Commit 2 owns both of its files.
    for f in &files[1..] {
        assert_eq!(
            f.commit_oid.as_deref(),
            Some("2222222222222222222222222222222222222222")
        );
        assert_eq!(f.commit_subject.as_deref(), Some("fix: second commit"));
    }
}

#[test]
fn bare_unified_diff_carries_no_commit_attribution() {
    let files = parse_unified_diff(SAMPLE);
    assert!(files
        .iter()
        .all(|f| f.commit_oid.is_none() && f.commit_subject.is_none()));
}

#[test]
fn parses_real_two_commit_gh_patch() {
    let files = parse_unified_diff(PR_85);
    // 14 files in commit 1 + 3 in commit 2 (per-commit patches repeat a path
    // touched by both commits: src/git/status/tests.rs, preview.ts).
    assert_eq!(files.len(), 17);

    let (add1, del1) = files[..14]
        .iter()
        .fold((0, 0), |(a, d), f| (a + f.add, d + f.del));
    assert_eq!((add1, del1), (422, 30), "commit 1 diffstat totals");

    let (add2, del2) = files[14..]
        .iter()
        .fold((0, 0), |(a, d), f| (a + f.add, d + f.del));
    assert_eq!((add2, del2), (63, 3), "commit 2 diffstat totals");

    // The last file of commit 1 sits right against commit 2's preamble - the
    // exact spot the old parser appended phantom lines to.
    let paths = &files[13];
    assert_eq!(paths.path, "src/lib/paths.ts");
    assert_eq!((paths.add, paths.del), (5, 0));
    assert_eq!(paths.hunks.len(), 1);
    // @@ -16,3 +16,8 @@: 3 ctx + 5 add, nothing more.
    assert_eq!(paths.hunks[0].lines.len(), 8);

    // Commit 2 opens cleanly on its own first file.
    assert_eq!(files[14].path, "src-tauri/src/git/status/selection.rs");
    assert_eq!((files[14].add, files[14].del), (18, 1));

    // The five files created in commit 1 all classify as additions.
    let added = files
        .iter()
        .filter(|f| f.status == ChangeStatus::Added)
        .count();
    assert_eq!(added, 5);

    // Every file carries its commit's attribution; the folded real-world
    // Subject lines reassemble with the [PATCH n/2] marker stripped.
    let oid1 = "7a78caf48c32ceb917f821e21cff3df6f7138c0a";
    let oid2 = "00b13d71ceda75df5b0014d7a0b2b80a75284dd8";
    assert!(files[..14]
        .iter()
        .all(|f| f.commit_oid.as_deref() == Some(oid1)));
    assert!(files[14..]
        .iter()
        .all(|f| f.commit_oid.as_deref() == Some(oid2)));
    assert_eq!(
        files[0].commit_subject.as_deref(),
        Some("GL-100 feat(review): Code/Preview toggle renders markdown files")
    );
    assert_eq!(
        files[14].commit_subject.as_deref(),
        Some("GL-100 fix(review): selection diffs carry blob oids so markdown Preview loads")
    );
}

#[test]
fn boundary_without_subject_keeps_oid_and_no_subject() {
    let files = parse_unified_diff(NO_SUBJECT);
    assert_eq!(files.len(), 1);
    assert_eq!(
        files[0].commit_oid.as_deref(),
        Some("3333333333333333333333333333333333333333")
    );
    assert_eq!(files[0].commit_subject, None);
    assert_eq!((files[0].add, files[0].del), (1, 0));
}
