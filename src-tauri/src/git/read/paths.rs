//! HEAD-tree path suggestions for the advanced search's "File path" field.

use git2::{TreeWalkMode, TreeWalkResult};

use super::open;

const DEFAULT_LIMIT: usize = 25;
const MAX_LIMIT: usize = 100;
const MAX_NODES_VISITED: usize = 10_000;

/// Case-insensitive substring matches for `filter` over the HEAD tree's file
/// and directory paths, in tree (depth-first) order. An empty filter, unborn
/// HEAD, or bare error yields no suggestions — the field is best-effort.
pub fn suggest_tree_paths(
    path: &str,
    filter: &str,
    limit: Option<usize>,
) -> Result<Vec<String>, String> {
    suggest_tree_paths_with_budget(path, filter, limit, MAX_NODES_VISITED)
        .map(|(matches, _)| matches)
}

fn suggest_tree_paths_with_budget(
    path: &str,
    filter: &str,
    limit: Option<usize>,
    max_nodes_visited: usize,
) -> Result<(Vec<String>, bool), String> {
    let needle = filter.trim().to_lowercase();
    if needle.is_empty() {
        return Ok((Vec::new(), false));
    }
    let limit = limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);

    let repo = open(path).map_err(|error| error.to_string())?;
    let Some(tree) = repo.head().ok().and_then(|head| head.peel_to_tree().ok()) else {
        return Ok((Vec::new(), false)); // unborn HEAD (fresh repo) — nothing to suggest
    };

    let mut matches = Vec::new();
    let mut nodes_visited = 0;
    let mut node_budget_exhausted = false;
    let walk = tree.walk(TreeWalkMode::PreOrder, |root, entry| {
        if nodes_visited >= max_nodes_visited {
            node_budget_exhausted = true;
            return TreeWalkResult::Abort;
        }
        nodes_visited += 1;
        let Ok(name) = entry.name() else {
            return TreeWalkResult::Ok; // non-UTF-8 entry — skip it
        };
        let full = format!("{root}{name}");
        if full.to_lowercase().contains(&needle) {
            matches.push(full);
            if matches.len() >= limit {
                return TreeWalkResult::Abort;
            }
        }
        TreeWalkResult::Ok
    });
    // Aborting at either cap surfaces as a walk error — only real failures on
    // an otherwise complete result set should propagate.
    if matches.len() < limit && !node_budget_exhausted {
        walk.map_err(|error| error.to_string())?;
    }
    Ok((matches, node_budget_exhausted))
}

#[cfg(test)]
mod tests {
    use super::{suggest_tree_paths, suggest_tree_paths_with_budget};
    use git2::{Repository, Signature};
    use std::path::Path;

    fn commit_files(path: &Path, names: &[&str]) -> Repository {
        let repo = Repository::init(path).unwrap();
        let mut builder = repo.treebuilder(None).unwrap();
        for name in names {
            let blob = repo.blob(name.as_bytes()).unwrap();
            builder.insert(name, blob, 0o100644).unwrap();
        }
        let tree = repo.find_tree(builder.write().unwrap()).unwrap();
        let sig = Signature::now("GitLane", "gitlane@example.test").unwrap();
        repo.commit(Some("refs/heads/main"), &sig, &sig, "files", &tree, &[])
            .unwrap();
        repo.set_head("refs/heads/main").unwrap();
        drop(tree);
        drop(builder);
        repo
    }

    fn temp_path(tag: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("gitlane-paths-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn non_matching_walk_stops_at_the_node_budget() {
        let path = temp_path("budget");
        let repo = commit_files(&path, &["a.txt", "b.txt", "target.txt"]);

        let result =
            suggest_tree_paths_with_budget(path.to_str().unwrap(), "target", None, 2).unwrap();

        assert!(result.0.is_empty());
        assert!(result.1);
        drop(repo);
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn discovers_the_repository_from_a_subdirectory() {
        let path = temp_path("discover");
        let repo = commit_files(&path, &["src.rs"]);
        let nested = path.join("nested");
        std::fs::create_dir(&nested).unwrap();

        let matches = suggest_tree_paths(nested.to_str().unwrap(), "src", None).unwrap();
        assert_eq!(matches, vec!["src.rs".to_string()]);
        drop(repo);
        let _ = std::fs::remove_dir_all(path);
    }
}
