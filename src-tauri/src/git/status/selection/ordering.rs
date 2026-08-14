//! Ancestry-ordering the picked commits so the union diff derives the right
//! base/head regardless of commit timestamps.

use git2::{Commit, Oid, Repository};

/// Resolve the selected oids to commits ordered **oldest first by ancestry**, so
/// a parent always precedes its descendant regardless of commit timestamps —
/// which can run backwards after amend/rebase/import or clock skew, and would
/// otherwise make `collect_touches`/`compose_text` derive the wrong base/head.
///
/// Order key per commit: the number of *other selected* commits that are its
/// ancestors (so ancestors rank before descendants). Commits with no ancestry
/// relationship in the pick share a rank and fall back to committer time, then
/// input order, for a deterministic result.
pub(super) fn ordered_commits<'r>(
    repo: &'r Repository,
    oids: &[String],
) -> Result<Vec<Commit<'r>>, git2::Error> {
    let mut commits: Vec<Commit<'r>> = Vec::with_capacity(oids.len());
    for oid in oids {
        commits.push(repo.find_commit(Oid::from_str(oid)?)?);
    }
    let ids: Vec<Oid> = commits.iter().map(|c| c.id()).collect();
    let times: Vec<i64> = commits.iter().map(|c| c.time().seconds()).collect();
    let n = commits.len();

    // `graph_descendant_of(a, b)` is true when a descends from b, i.e. b is an
    // ancestor of a — so this counts selected ancestors of each commit.
    let mut rank = vec![0usize; n];
    for i in 0..n {
        for j in 0..n {
            if i != j && repo.graph_descendant_of(ids[i], ids[j]).unwrap_or(false) {
                rank[i] += 1;
            }
        }
    }

    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by(|&a, &b| {
        rank[a]
            .cmp(&rank[b])
            .then(times[a].cmp(&times[b]))
            .then(a.cmp(&b))
    });

    // Reorder the owned commits by `order` without cloning.
    let mut slots: Vec<Option<Commit<'r>>> = commits.into_iter().map(Some).collect();
    Ok(order
        .into_iter()
        .map(|i| slots[i].take().expect("each index used once"))
        .collect())
}
