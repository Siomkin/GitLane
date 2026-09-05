use std::path::{Path, PathBuf};

/// The filesystem roots one repository's watch must cover, resolved once at
/// watch time. For a plain checkout the workdir alone contains `.git`; for a
/// linked worktree the private gitdir and the shared common dir lie outside it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct WatchRoots {
    /// The worktree root (or the gitdir for a bare repo) — the opened path.
    pub(super) workdir: PathBuf,
    /// This worktree's private gitdir (`<common>/worktrees/<name>` — HEAD,
    /// index, MERGE_HEAD, rebase state) when it lies outside `workdir`.
    pub(super) gitdir: Option<PathBuf>,
    /// The shared common dir (`<main>/.git` — refs, objects, packed-refs)
    /// when it lies outside `workdir`.
    pub(super) commondir: Option<PathBuf>,
}

impl WatchRoots {
    /// A plain checkout whose `.git` lives inside the workdir.
    pub(super) fn plain(workdir: impl Into<PathBuf>) -> Self {
        WatchRoots {
            workdir: workdir.into(),
            gitdir: None,
            commondir: None,
        }
    }

    /// The directories this tab watches on its own — the workdir, plus its
    /// private gitdir when that lies *outside* the common dir. The private
    /// gitdir usually sits inside the common dir (`<common>/worktrees/<name>`),
    /// where the shared common-dir watch already covers it; it gets its own
    /// watch only in the unusual case where it lies elsewhere. The common dir
    /// (`commondir`) is watched once per repository and fanned out to every
    /// worktree tab (GL-125), so it is deliberately not included here.
    pub(super) fn private_targets(&self) -> Vec<&Path> {
        let mut targets = vec![self.workdir.as_path()];
        if let Some(gitdir) = &self.gitdir {
            let covered = self
                .commondir
                .as_ref()
                .is_some_and(|common| gitdir.starts_with(common));
            if !covered {
                targets.push(gitdir);
            }
        }
        targets
    }
}

/// Resolve the roots a watch on `open_path` must cover. Paths come from the
/// same libgit2 handle so containment checks compare a consistent family; a
/// discovery failure degrades to watching just the opened directory (matching
/// the pre-worktree behaviour, and `classify_paths` stays conservative).
pub(super) fn resolve_watch_roots(open_path: &Path) -> WatchRoots {
    let Ok(repo) = git2::Repository::discover(open_path) else {
        return WatchRoots::plain(open_path);
    };
    let workdir = repo
        .workdir()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| open_path.to_path_buf());
    let outside = |dir: &Path| !dir.starts_with(&workdir);
    WatchRoots {
        gitdir: Some(repo.path().to_path_buf()).filter(|p| outside(p)),
        commondir: Some(repo.commondir().to_path_buf()).filter(|p| outside(p)),
        workdir,
    }
}
