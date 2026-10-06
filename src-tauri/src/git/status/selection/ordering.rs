//! Ancestry-ordering the picked commits so the union diff derives the right
//! base/head regardless of commit timestamps.

use std::collections::{HashMap, HashSet};

use git2::{Commit, Oid, Repository, Sort};

/// Resolve the selected oids to commits ordered **oldest first by ancestry**, so
/// a parent always precedes its descendant regardless of commit timestamps —
/// which can run backwards after amend/rebase/import or clock skew, and would
/// otherwise make `collect_touches`/`compose_text` derive the wrong base/head.
///
/// One revwalk (`TOPOLOGICAL | TIME | REVERSE`) from the picked tips ranks each
/// pick by its position, so ancestors rank before descendants; picks with no
/// ancestry relationship fall back to committer time. The walk stops at the
/// picks' common ancestor (its parents are hidden), so it covers only the span
/// the selection lives in — not an ancestry walk per pair.
pub(super) fn ordered_commits<'r>(
    repo: &'r Repository,
    oids: &[String],
) -> Result<Vec<Commit<'r>>, git2::Error> {
    let mut commits: Vec<Commit<'r>> = Vec::with_capacity(oids.len());
    for oid in oids {
        commits.push(repo.find_commit(Oid::from_str(oid)?)?);
    }
    let ids: Vec<Oid> = commits.iter().map(|c| c.id()).collect();

    let mut walk = repo.revwalk()?;
    walk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME | Sort::REVERSE)?;
    for id in &ids {
        walk.push(*id)?;
    }
    // Nothing below the picks' common ancestor can reorder them. Unrelated
    // histories have none, and then the walk simply covers both. Octopus, not
    // `merge_base_many`: the latter is `git merge-base A B C` (A against a
    // hypothetical merge of the rest), which for a newest-first linear run is
    // the second-newest pick, and hiding below it drops the older picks.
    if ids.len() > 1 {
        if let Ok(base) = repo.merge_base_octopus(&ids) {
            for parent in repo.find_commit(base)?.parent_ids() {
                walk.hide(parent)?;
            }
        }
    }
    let wanted: HashSet<Oid> = ids.iter().copied().collect();
    let mut position: HashMap<Oid, usize> = HashMap::with_capacity(wanted.len());
    for (index, oid) in walk.enumerate() {
        let oid = oid?;
        if wanted.contains(&oid) {
            position.insert(oid, index);
        }
    }

    // Stable, so duplicate picks keep their input order.
    commits.sort_by_key(|commit| position.get(&commit.id()).copied().unwrap_or(usize::MAX));
    Ok(commits)
}
