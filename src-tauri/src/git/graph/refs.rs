//! Ref and HEAD labels for visible graph commits.

use std::collections::{HashMap, HashSet};

use git2::{Oid, Repository};

use crate::git::types::RefLabel;

/// Map each commit oid to the refs (branches/remotes/tags/HEAD) pointing at it.
pub(super) fn collect_refs(
    repo: &Repository,
    visible_oids: &HashSet<Oid>,
) -> HashMap<Oid, Vec<RefLabel>> {
    let mut map: HashMap<Oid, Vec<RefLabel>> = HashMap::new();

    if let Ok(refs) = repo.references() {
        for r in refs.flatten() {
            let name = r.shorthand().ok().unwrap_or("").to_string();
            if name.is_empty() || name.ends_with("/HEAD") {
                continue;
            }
            let (kind, oid, target_oid) = if r.is_remote() {
                ("remote", r.target(), None)
            } else if r.is_tag() {
                // Lightweight tags have a direct commit target; annotated tags
                // need one peel through the tag object. Keep the unpeeled target
                // too: deletion must CAS the exact tag object the user saw.
                let target = r.target();
                let oid = target
                    .filter(|target| repo.find_commit(*target).is_ok())
                    .or_else(|| r.peel_to_commit().ok().map(|commit| commit.id()));
                ("tag", oid, target.map(|oid| oid.to_string()))
            } else if r.is_branch() {
                ("branch", r.target(), None)
            } else {
                continue;
            };
            let Some(oid) = oid else { continue };
            if !visible_oids.contains(&oid) {
                continue;
            }
            map.entry(oid).or_default().push(RefLabel {
                name,
                kind: kind.to_string(),
                target_oid,
            });
        }
    }

    // Mark HEAD so the renderer can highlight the checked-out tip.
    if let Some(oid_str) = head_oid(repo) {
        if let Ok(oid) = Oid::from_str(&oid_str) {
            if !visible_oids.contains(&oid) {
                return map;
            }
            let label = repo
                .head()
                .ok()
                .and_then(|h| h.shorthand().ok().map(|s| s.to_string()))
                .unwrap_or_else(|| "HEAD".to_string());
            map.entry(oid).or_default().push(RefLabel {
                name: label,
                kind: "head".to_string(),
                target_oid: None,
            });
        }
    }

    map
}

/// Resolve HEAD to a commit oid string.
pub(super) fn head_oid(repo: &Repository) -> Option<String> {
    repo.head()
        .ok()
        .and_then(|h| h.peel_to_commit().ok())
        .map(|c| c.id().to_string())
}
