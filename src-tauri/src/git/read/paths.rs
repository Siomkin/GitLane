//! HEAD-tree path suggestions for the advanced search's "File path" field.

use std::path::Path;

use git2::{Repository, TreeWalkMode, TreeWalkResult};

const DEFAULT_LIMIT: usize = 25;
const MAX_LIMIT: usize = 100;

/// Case-insensitive substring matches for `filter` over the HEAD tree's file
/// and directory paths, in tree (depth-first) order. An empty filter, unborn
/// HEAD, or bare error yields no suggestions — the field is best-effort.
pub fn suggest_tree_paths(
    path: &str,
    filter: &str,
    limit: Option<usize>,
) -> Result<Vec<String>, String> {
    let needle = filter.trim().to_lowercase();
    if needle.is_empty() {
        return Ok(Vec::new());
    }
    let limit = limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);

    let repo = Repository::open(Path::new(path)).map_err(|error| error.to_string())?;
    let Some(tree) = repo.head().ok().and_then(|head| head.peel_to_tree().ok()) else {
        return Ok(Vec::new()); // unborn HEAD (fresh repo) — nothing to suggest
    };

    let mut matches = Vec::new();
    let walk = tree.walk(TreeWalkMode::PreOrder, |root, entry| {
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
    // Aborting at the cap surfaces as a walk error — only real failures on an
    // incomplete result set should propagate.
    if matches.len() < limit {
        walk.map_err(|error| error.to_string())?;
    }
    Ok(matches)
}
