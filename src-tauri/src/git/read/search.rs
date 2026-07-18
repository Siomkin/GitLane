use git2::{Diff, Oid, Repository, Sort};
use regex::{Regex, RegexBuilder};

use crate::git::types::{HistorySearchPage, HistorySearchQuery, HistorySearchResult};

use super::open;

const DEFAULT_LIMIT: usize = 200;
const MAX_LIMIT: usize = 1_000;
/// Diff filters are deliberately work-bounded separately from their result
/// cap: a rare `-G`/`-S`/path match must not diff an entire large history.
const MAX_DIFFS_SCANNED: usize = 1_000;

fn non_empty(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_owned())
    })
}

fn compile_pattern(label: &str, value: Option<String>) -> Result<Option<Regex>, String> {
    non_empty(value)
        .map(|pattern| {
            RegexBuilder::new(&pattern)
                .case_insensitive(true)
                .build()
                .map_err(|error| format!("Invalid {label} regular expression: {error}"))
        })
        .transpose()
}

/// Resolve one side of the revision filter to a commit, translating libgit2's
/// failures into user-facing messages (the raw errors carry `class=`/`code=`
/// internals that mean nothing in the search form).
fn resolve_commit(repo: &Repository, revision: &str) -> Result<Oid, String> {
    let object = repo.revparse_single(revision).map_err(|error| {
        if error.code() == git2::ErrorCode::NotFound {
            format!("Unknown revision {revision:?} — expected a branch, tag, or commit id.")
        } else {
            format!("Could not resolve {revision:?}: {}.", error.message())
        }
    })?;
    object
        .peel_to_commit()
        .map(|commit| commit.id())
        .map_err(|_| format!("{revision:?} does not point to a commit."))
}

fn push_revision(
    repo: &Repository,
    walk: &mut git2::Revwalk<'_>,
    revision: Option<String>,
) -> Result<(), String> {
    let Some(revision) = non_empty(revision) else {
        // Seed exactly the refs the commit graph walks (see git/graph/layout.rs)
        // so every hit can be revealed by paging the graph. A broader
        // `refs/*` seed would surface commits reachable only via refs/stash,
        // refs/notes, etc. — which the bounded graph never loads, leaving the
        // user with a result they cannot navigate to. Errors are tolerated (as
        // in the graph) so an unborn HEAD or a missing ref class yields an
        // empty result set rather than failing.
        let _ = walk.push_glob("refs/heads/*");
        let _ = walk.push_glob("refs/remotes/*");
        let _ = walk.push_glob("refs/tags/*");
        let _ = walk.push_head();
        return Ok(());
    };

    if let Some((from, to)) = revision.split_once("..") {
        let to = if to.trim().is_empty() {
            "HEAD"
        } else {
            to.trim()
        };
        let to_oid = resolve_commit(repo, to)?;
        walk.push(to_oid).map_err(|error| error.to_string())?;
        if !from.trim().is_empty() {
            let from_oid = resolve_commit(repo, from.trim())?;
            walk.hide(from_oid).map_err(|error| error.to_string())?;
        }
    } else {
        let oid = resolve_commit(repo, &revision)?;
        walk.push(oid).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn delta_path_matches(diff: &Diff<'_>, query: &str) -> bool {
    let query = query.to_lowercase();
    diff.deltas().any(|delta| {
        [delta.old_file().path(), delta.new_file().path()]
            .into_iter()
            .flatten()
            .any(|path| path.to_string_lossy().to_lowercase().contains(&query))
    })
}

fn diff_pattern_matches(diff: &Diff<'_>, pattern: &Regex) -> Result<bool, String> {
    for index in 0..diff.deltas().len() {
        let Some(patch) = git2::Patch::from_diff(diff, index).map_err(|error| error.to_string())?
        else {
            continue;
        };
        for hunk_index in 0..patch.num_hunks() {
            let (_, line_count) = patch.hunk(hunk_index).map_err(|error| error.to_string())?;
            for line_index in 0..line_count {
                let line = patch
                    .line_in_hunk(hunk_index, line_index)
                    .map_err(|error| error.to_string())?;
                if matches!(line.origin(), '+' | '-')
                    && pattern.is_match(&String::from_utf8_lossy(line.content()))
                {
                    return Ok(true);
                }
            }
        }
    }
    Ok(false)
}

fn blob_occurrences(repo: &Repository, oid: Oid, needle: &str) -> usize {
    if oid.is_zero() {
        return 0;
    }
    repo.find_blob(oid)
        .ok()
        .and_then(|blob| {
            std::str::from_utf8(blob.content())
                .ok()
                .map(|text| text.matches(needle).count())
        })
        .unwrap_or(0)
}

fn occurrence_changed(repo: &Repository, diff: &Diff<'_>, needle: &str) -> bool {
    diff.deltas().any(|delta| {
        blob_occurrences(repo, delta.old_file().id(), needle)
            != blob_occurrences(repo, delta.new_file().id(), needle)
    })
}

pub fn search_history(path: &str, query: HistorySearchQuery) -> Result<HistorySearchPage, String> {
    search_history_with_budget(path, query, MAX_DIFFS_SCANNED)
}

fn search_history_with_budget(
    path: &str,
    query: HistorySearchQuery,
    max_diffs_scanned: usize,
) -> Result<HistorySearchPage, String> {
    let repo = open(path).map_err(|error| error.to_string())?;
    let message_pattern = compile_pattern("message", query.message_pattern)?;
    let changed_pattern = compile_pattern("diff", query.changed_pattern)?;
    let author = non_empty(query.author).map(|value| value.to_lowercase());
    let path_query = non_empty(query.path);
    let occurrence_text = non_empty(query.occurrence_text);
    let limit = query.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);

    let mut walk = repo.revwalk().map_err(|error| error.to_string())?;
    push_revision(&repo, &mut walk, query.revision)?;
    walk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME)
        .map_err(|error| error.to_string())?;

    let needs_diff = path_query.is_some() || changed_pattern.is_some() || occurrence_text.is_some();
    let mut results = Vec::new();
    let mut truncated = false;
    let mut work_truncated = false;
    let mut diffs_scanned = 0;

    for oid in walk {
        let commit = repo
            .find_commit(oid.map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?;
        // Committer date, matching `git log --since/--until`. The walk is
        // topological, not strictly chronological, so filter instead of
        // terminating early.
        let commit_time = commit.time().seconds();
        if query
            .since_timestamp
            .is_some_and(|since| commit_time < since)
            || query
                .until_timestamp
                .is_some_and(|until| commit_time > until)
        {
            continue;
        }
        let message = commit.message().unwrap_or_default();
        if message_pattern
            .as_ref()
            .is_some_and(|pattern| !pattern.is_match(message))
        {
            continue;
        }
        if let Some(author) = &author {
            let signature = commit.author();
            let haystack = format!(
                "{} {}",
                signature.name().unwrap_or_default(),
                signature.email().unwrap_or_default()
            )
            .to_lowercase();
            if !haystack.contains(author) {
                continue;
            }
        }

        if needs_diff {
            if diffs_scanned >= max_diffs_scanned {
                truncated = true;
                work_truncated = true;
                break;
            }
            diffs_scanned += 1;
            let tree = commit.tree().map_err(|error| error.to_string())?;
            let parent_tree = commit.parent(0).ok().and_then(|parent| parent.tree().ok());
            let diff = repo
                .diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), None)
                .map_err(|error| error.to_string())?;
            if path_query
                .as_ref()
                .is_some_and(|path| !delta_path_matches(&diff, path))
            {
                continue;
            }
            if let Some(pattern) = &changed_pattern {
                if !diff_pattern_matches(&diff, pattern)? {
                    continue;
                }
            }
            if occurrence_text
                .as_ref()
                .is_some_and(|needle| !occurrence_changed(&repo, &diff, needle))
            {
                continue;
            }
        }

        if results.len() == limit {
            truncated = true;
            break;
        }
        let signature = commit.author();
        results.push(HistorySearchResult {
            id: commit.id().to_string(),
            short_id: commit.id().to_string().chars().take(8).collect(),
            summary: commit
                .summary()
                .ok()
                .flatten()
                .unwrap_or_default()
                .to_owned(),
            author_name: signature.name().unwrap_or_default().to_owned(),
            author_email: signature.email().unwrap_or_default().to_owned(),
            timestamp: signature.when().seconds(),
        });
    }

    Ok(HistorySearchPage {
        results,
        truncated,
        work_truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::{compile_pattern, non_empty, search_history, search_history_with_budget};
    use crate::git::types::HistorySearchQuery;
    use git2::{Oid, Repository, Signature, Time};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU32, Ordering};

    struct TempRepo(PathBuf);
    impl TempRepo {
        fn new(tag: &str) -> Self {
            static SEQ: AtomicU32 = AtomicU32::new(0);
            let n = SEQ.fetch_add(1, Ordering::Relaxed);
            let dir = std::env::temp_dir()
                .join(format!("gitlane-search-{tag}-{}-{n}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            TempRepo(dir)
        }
        fn str_path(&self) -> &str {
            self.0.to_str().unwrap()
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TempRepo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// Commit `message` (as its own file) onto `update_ref` at committer time
    /// `secs`, returning the new oid.
    fn commit_at(
        repo: &Repository,
        update_ref: &str,
        message: &str,
        parents: &[Oid],
        secs: i64,
    ) -> Oid {
        let blob = repo.blob(message.as_bytes()).unwrap();
        let mut builder = repo.treebuilder(None).unwrap();
        builder
            .insert(format!("{message}.txt"), blob, 0o100644)
            .unwrap();
        let tree = repo.find_tree(builder.write().unwrap()).unwrap();
        let sig = Signature::new("GitLane", "gitlane@example.test", &Time::new(secs, 0)).unwrap();
        let parent_commits = parents
            .iter()
            .map(|oid| repo.find_commit(*oid).unwrap())
            .collect::<Vec<_>>();
        let parent_refs = parent_commits.iter().collect::<Vec<_>>();
        repo.commit(Some(update_ref), &sig, &sig, message, &tree, &parent_refs)
            .unwrap()
    }

    fn empty_query() -> HistorySearchQuery {
        HistorySearchQuery {
            message_pattern: None,
            author: None,
            path: None,
            revision: None,
            changed_pattern: None,
            occurrence_text: None,
            since_timestamp: None,
            until_timestamp: None,
            limit: None,
        }
    }

    fn summaries(page: &crate::git::types::HistorySearchPage) -> Vec<String> {
        page.results.iter().map(|r| r.summary.clone()).collect()
    }

    #[test]
    fn trims_empty_filters() {
        assert_eq!(non_empty(Some("  ".into())), None);
        assert_eq!(non_empty(Some(" author ".into())), Some("author".into()));
    }

    #[test]
    fn reports_invalid_regex() {
        let error = compile_pattern("message", Some("[".into())).unwrap_err();
        assert!(error.starts_with("Invalid message regular expression:"));
    }

    #[test]
    fn unborn_head_yields_empty_results_without_error() {
        let dir = TempRepo::new("unborn");
        Repository::init(dir.path()).unwrap();
        let page = search_history(dir.str_path(), empty_query()).unwrap();
        assert!(page.results.is_empty());
        assert!(!page.truncated);
    }

    #[test]
    fn default_seed_excludes_commits_reachable_only_via_non_graph_refs() {
        // A commit pointed at only by refs/stash must NOT surface in the default
        // search — the seed is aligned to the graph (heads/remotes/tags) so every
        // hit is revealable. A normal branch commit still matches.
        let dir = TempRepo::new("stash-scope");
        let repo = Repository::init(dir.path()).unwrap();
        let base = commit_at(&repo, "refs/heads/main", "base", &[], 1000);
        commit_at(&repo, "refs/stash", "stashy", &[base], 2000);

        let all = search_history(dir.str_path(), empty_query()).unwrap();
        let msgs = summaries(&all);
        assert!(
            msgs.iter().any(|m| m == "base"),
            "branch commit should be found: {msgs:?}"
        );
        assert!(
            !msgs.iter().any(|m| m == "stashy"),
            "stash-only commit must be excluded: {msgs:?}"
        );
    }

    #[test]
    fn filters_by_inclusive_committer_date_range() {
        let dir = TempRepo::new("dates");
        let repo = Repository::init(dir.path()).unwrap();
        let old = commit_at(&repo, "refs/heads/main", "old", &[], 1_000);
        commit_at(&repo, "refs/heads/main", "new", &[old], 5_000);

        let mut q = empty_query();
        q.since_timestamp = Some(2_000);
        let msgs = summaries(&search_history(dir.str_path(), q).unwrap());
        assert_eq!(msgs, vec!["new".to_string()]);

        let mut q = empty_query();
        q.until_timestamp = Some(2_000);
        let msgs = summaries(&search_history(dir.str_path(), q).unwrap());
        assert_eq!(msgs, vec!["old".to_string()]);
    }

    #[test]
    fn unknown_revision_reports_a_friendly_error() {
        let dir = TempRepo::new("bad-rev");
        let repo = Repository::init(dir.path()).unwrap();
        commit_at(&repo, "refs/heads/main", "base", &[], 1000);
        let mut q = empty_query();
        q.revision = Some("does-not-exist".into());
        let error = search_history(dir.str_path(), q).unwrap_err();
        assert!(error.contains("Unknown revision"), "got: {error}");
        assert!(
            !error.contains("class="),
            "must not leak libgit2 internals: {error}"
        );
    }

    #[test]
    fn diff_filter_stops_at_the_work_budget_and_signals_truncation() {
        let dir = TempRepo::new("diff-budget");
        let repo = Repository::init(dir.path()).unwrap();
        let first = commit_at(&repo, "refs/heads/main", "first", &[], 1_000);
        let second = commit_at(&repo, "refs/heads/main", "second", &[first], 2_000);
        commit_at(&repo, "refs/heads/main", "third", &[second], 3_000);

        let mut q = empty_query();
        q.changed_pattern = Some("never-matches".into());
        let page = search_history_with_budget(dir.str_path(), q, 2).unwrap();

        assert!(page.results.is_empty());
        assert!(page.truncated);
        assert!(page.work_truncated);
    }

    #[test]
    fn result_cap_truncation_is_not_reported_as_work_truncation() {
        let dir = TempRepo::new("result-cap");
        let repo = Repository::init(dir.path()).unwrap();
        let first = commit_at(&repo, "refs/heads/main", "first", &[], 1_000);
        commit_at(&repo, "refs/heads/main", "second", &[first], 2_000);

        let mut q = empty_query();
        q.limit = Some(1);
        let page = search_history(dir.str_path(), q).unwrap();

        assert_eq!(page.results.len(), 1);
        assert!(page.truncated);
        assert!(!page.work_truncated);
    }

    #[test]
    fn discovers_the_repository_from_a_subdirectory() {
        let dir = TempRepo::new("discover");
        let repo = Repository::init(dir.path()).unwrap();
        commit_at(&repo, "refs/heads/main", "from-root", &[], 1_000);
        let nested = dir.path().join("nested");
        std::fs::create_dir(&nested).unwrap();

        let page = search_history(nested.to_str().unwrap(), empty_query()).unwrap();
        assert_eq!(summaries(&page), vec!["from-root".to_string()]);
    }
}
