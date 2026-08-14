//! The repository summary: an unborn HEAD, and a linked worktree's identity.

use super::support::*;

#[test]
fn summary_flags_an_unborn_head_then_clears_it_after_the_first_commit() {
    use super::super::repo::summary;
    use git2::RepositoryInitOptions;

    // Fresh `git init`: HEAD points at a branch with no commits. `repo.head()`
    // fails with `UnbornBranch`, which is a real state — not a read failure —
    // so `unborn` must be true and distinguishable from "No branch" (GL-115).
    // Pin the initial branch so the resolved name is deterministic regardless of
    // the host's `init.defaultBranch`.
    let dir = TempRepo::new("unborn-summary");
    let repo = Repository::init_opts(
        dir.path(),
        RepositoryInitOptions::new().initial_head("master"),
    )
    .unwrap();
    let path = dir.path().to_str().unwrap();

    let fresh = summary(path).unwrap();
    assert!(
        fresh.unborn,
        "a repo with no commits reports an unborn HEAD"
    );
    // The unborn branch is resolved from HEAD's symbolic target (GL-115
    // follow-up): a branch *exists*, it just has no commits yet, so downstream
    // consumers can treat it like a checked-out branch instead of "No branch".
    assert_eq!(
        fresh.head_branch.as_deref(),
        Some("master"),
        "unborn HEAD resolves its symbolic target branch name"
    );
    assert_eq!(fresh.head_oid, None, "there is no commit to resolve");
    assert!(!fresh.detached, "unborn is not the same as detached");

    // The first commit is born: HEAD now resolves, so `unborn` clears and the
    // branch name still resolves — now via the born HEAD.
    commit(&repo, "HEAD", "base", &[]);
    let born = summary(path).unwrap();
    assert!(!born.unborn, "a committed repo is no longer unborn");
    assert_eq!(
        born.head_branch.as_deref(),
        Some("master"),
        "the branch name persists once the first commit is born"
    );
    assert!(
        born.head_oid.is_some(),
        "HEAD resolves after the first commit"
    );
}

#[test]
fn summary_reports_linked_worktree_identity() {
    use super::super::recents::recents_status;
    use super::super::repo::summary;

    let dir = TempRepo::new("wt-identity");
    let repo = Repository::init(dir.path()).unwrap();
    commit(&repo, "HEAD", "base", &[]);

    // A linked worktree on its own branch, next to (not inside) the main dir.
    let wt_dir = dir.path().parent().unwrap().join(format!(
        "{}-linked",
        dir.path().file_name().unwrap().to_string_lossy()
    ));
    let _ = std::fs::remove_dir_all(&wt_dir);
    repo.worktree("linked", &wt_dir, None).unwrap();

    // Canonicalize both sides: temp paths go through symlinks on macOS
    // (/var → /private/var), and git records the resolved form.
    let canon = |p: &str| std::fs::canonicalize(p).unwrap();

    let main = summary(dir.path().to_str().unwrap()).unwrap();
    assert!(
        !main.is_worktree,
        "the main checkout is not a linked worktree"
    );
    assert_eq!(
        main.main_path, None,
        "the main checkout is its own identity"
    );

    let wt = summary(wt_dir.to_str().unwrap()).unwrap();
    assert!(wt.is_worktree, "a linked worktree reports itself as one");
    assert_eq!(
        canon(
            wt.main_path
                .as_deref()
                .expect("linked worktree has a main path")
        ),
        canon(&main.path),
        "a linked worktree's identity is the main checkout's path"
    );

    // The shared tab/recents probe reports the same identity per path.
    let statuses = recents_status(&[
        wt_dir.to_string_lossy().into_owned(),
        dir.path().to_string_lossy().into_owned(),
    ]);
    assert!(statuses[0].is_worktree);
    assert_eq!(
        canon(statuses[0].main_path.as_deref().unwrap()),
        canon(&main.path)
    );
    assert!(!statuses[1].is_worktree);
    assert_eq!(statuses[1].main_path, None);
    assert_eq!(statuses[0].branch.as_deref(), Some("linked"));

    let _ = std::fs::remove_dir_all(&wt_dir);
}
