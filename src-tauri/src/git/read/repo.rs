//! Repository opening, summary, and graph entry points.

use git2::Repository;

use crate::git::graph;
use crate::git::types::{RepoGraph, RepoOpenError, RepoOpenErrorKind, RepoSummary};

/// Open the repository containing `path` (searches upward for `.git`).
pub fn open(path: &str) -> Result<Repository, git2::Error> {
    Repository::discover(path)
}

/// [`summary`] with the failure classified (GL-108): the frontend swaps a
/// moved/deleted repository for its dedicated missing-repo state instead of
/// showing the raw libgit2 message on the error bar.
pub fn summary_classified(path: &str) -> Result<RepoSummary, RepoOpenError> {
    summary(path).map_err(|e| classify_open_error(path, &e))
}

/// What a recorded repository path still resolves to. The single presence
/// probe behind both surfaces that judge a remembered path — a repo tab
/// ([`classify_open_error`]) and a recents row (`recents_status`) — so the same
/// path never gets two verdicts.
pub(super) enum Presence {
    /// No directory stands at the path anymore: deleted, moved, or replaced by
    /// a regular file. A file is a path that is gone, not a repository that
    /// lost its `.git`.
    Gone,
    /// A directory is still there, but libgit2 discovers no repository from it.
    NotARepository,
    /// The path still resolves to a repository.
    Repository(Repository),
}

impl Presence {
    /// The discovered handle, for callers that want to read from the repo.
    pub(super) fn repository(self) -> Option<Repository> {
        match self {
            Presence::Repository(repo) => Some(repo),
            _ => None,
        }
    }
}

/// Probe a remembered path: directory on disk, then `Repository::discover`.
pub(super) fn repo_presence(path: &str) -> Presence {
    if !std::path::Path::new(path).is_dir() {
        return Presence::Gone;
    }
    match Repository::discover(path) {
        Ok(repo) => Presence::Repository(repo),
        Err(_) => Presence::NotARepository,
    }
}

/// Distinguish "the path is gone" and "the folder is no longer a repository"
/// from real open failures, via the shared [`repo_presence`] probe — a tab and
/// a recents row take the same decision from the same call. Only ever runs on
/// an already-failed open, so re-probing costs nothing in the success path (and
/// the discovered handle is dropped, not reused).
fn classify_open_error(path: &str, err: &git2::Error) -> RepoOpenError {
    let kind = match repo_presence(path) {
        Presence::Gone => RepoOpenErrorKind::Missing,
        _ if err.code() == git2::ErrorCode::NotFound => RepoOpenErrorKind::NotARepository,
        _ => RepoOpenErrorKind::Other,
    };
    let message = match kind {
        RepoOpenErrorKind::Missing => {
            format!("This repository can't be found at {path}. It may have been moved or deleted.")
        }
        RepoOpenErrorKind::NotARepository => {
            format!("The folder at {path} is not a git repository anymore.")
        }
        RepoOpenErrorKind::Other => err.message().to_string(),
    };
    RepoOpenError {
        kind,
        message,
        path: path.to_string(),
    }
}

/// The main checkout's path for a *linked* worktree — the stable repository
/// identity (GL-109/GL-110). A linked worktree's gitdir lives under
/// `<common>/worktrees/<name>`, and `commondir()` points back at the shared
/// gitdir, so opening the common dir yields the main worktree. Returns None for
/// the main worktree itself (its own path is the identity) and for a bare main
/// without a working tree (falls back to the bare gitdir).
pub(super) fn main_worktree_path(repo: &git2::Repository) -> Option<String> {
    if !repo.is_worktree() {
        return None;
    }
    let common = repo.commondir();
    let main = Repository::open(common).ok()?;
    main.workdir()
        .and_then(|p| p.to_str())
        .map(|s| s.trim_end_matches('/').to_string())
        .or_else(|| common.to_str().map(|s| s.trim_end_matches('/').to_string()))
}

/// The branch name a fresh (`unborn`) HEAD points at. HEAD is a symbolic ref
/// (`ref: refs/heads/<name>`) even before the first commit exists, so read its
/// target directly and strip the `refs/heads/` prefix. Returns None if HEAD is
/// missing or not a `refs/heads/` symbolic ref (never expected for an unborn
/// branch, but keeps the caller from surfacing a bogus name).
fn unborn_branch_name(repo: &Repository) -> Option<String> {
    let head = repo.find_reference("HEAD").ok()?;
    head.symbolic_target()
        .ok()
        .flatten()?
        .strip_prefix("refs/heads/")
        .map(|s| s.to_string())
}

/// High-level state for the title bar / status area.
pub fn summary(path: &str) -> Result<RepoSummary, git2::Error> {
    let repo = open(path)?;
    let detached = repo.head_detached().unwrap_or(false);

    let head = repo.head();
    // An unborn HEAD (fresh `git init`, no commits yet) is a real state, not a
    // read failure — surfaced so the UI can say "No commits yet" instead of
    // the ambiguous "No branch" (GL-115).
    let unborn = matches!(&head, Err(e) if e.code() == git2::ErrorCode::UnbornBranch);
    let head = head.ok();
    let head_branch = if detached {
        None
    } else if unborn {
        // `repo.head()` failed, but HEAD is still a symbolic ref pointing at the
        // branch the first commit will create (e.g. `refs/heads/main`). Resolve
        // that name so consumers treat it like a checked-out branch for display,
        // even though it has no commits and no entry in the branch list yet
        // (GL-115 follow-up). The `unborn` flag keeps it distinguishable.
        unborn_branch_name(&repo)
    } else {
        head.as_ref()
            .and_then(|h| h.shorthand().ok())
            .map(|s| s.to_string())
    };
    let head_oid = head
        .and_then(|h| h.peel_to_commit().ok())
        .map(|c| c.id().to_string());

    Ok(RepoSummary {
        // Prefer the worktree root as the canonical path (correct for linked
        // worktrees and immune to repeated "/.git/" patterns); fall back to the
        // gitdir for a bare repo.
        path: repo
            .workdir()
            .and_then(|p| p.to_str())
            .map(|s| s.trim_end_matches('/').to_string())
            .unwrap_or_else(|| repo.path().to_str().unwrap_or(path).to_string()),
        workdir: repo.workdir().and_then(|p| p.to_str()).map(String::from),
        head_branch,
        head_oid,
        detached,
        unborn,
        is_worktree: repo.is_worktree(),
        main_path: main_worktree_path(&repo),
    })
}

/// Build the laid-out commit graph (delegates to [`graph::build`]).
pub fn commit_graph(path: &str, limit: usize) -> Result<RepoGraph, git2::Error> {
    let repo = open(path)?;
    graph::build(&repo, limit)
}

#[cfg(test)]
mod tests {
    use super::summary_classified;
    use crate::git::read::recents_status;
    use crate::git::types::RepoOpenErrorKind;

    #[test]
    fn open_failures_are_classified() {
        let base = std::env::temp_dir().join(format!("gitlane-open-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let plain = base.join("not-a-repo");
        std::fs::create_dir_all(&plain).expect("create temp dir");
        let missing = base.join("gone");
        let file = base.join("a-file");
        std::fs::write(&file, b"not a repo").expect("write temp file");

        // A path that no longer exists → Missing, with a human message (never
        // the raw libgit2 "class=Os (2); code=NotFound" jargon).
        let err = summary_classified(&missing.to_string_lossy()).unwrap_err();
        assert_eq!(err.kind, RepoOpenErrorKind::Missing);
        assert!(!err.message.contains("class="));

        // A directory that exists but holds no repository → NotARepository
        // (the shared `repo_presence` probe found a directory, just no repo).
        let err = summary_classified(&plain.to_string_lossy()).unwrap_err();
        assert_eq!(err.kind, RepoOpenErrorKind::NotARepository);

        // A regular file where the repo used to be → Missing, and the recents
        // row says the same: one probe, one verdict per path (GL-376). This is
        // the input the two probes used to answer differently.
        let path = file.to_string_lossy().into_owned();
        let err = summary_classified(&path).unwrap_err();
        assert_eq!(
            err.kind,
            RepoOpenErrorKind::Missing,
            "a file at the path is gone, not a folder that stopped being a repo"
        );
        assert!(
            !recents_status(&[path])[0].exists,
            "the recents row agrees the file is missing"
        );

        let _ = std::fs::remove_dir_all(&base);
    }
}
