//! Commit-graph construction and lane (column) layout.
//!
//! This is the heart of the visual client: we walk the commit DAG and assign
//! every commit a `lane` so the frontend can paint the swimlane columns.
//! The algorithm is the classic "reservation" approach — each lane holds the
//! id of the parent commit it is currently waiting to render.

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use git2::{Oid, Repository, Sort};

use super::types::{CommitNode, GraphEdge, RefLabel, RepoGraph, StashRef};

/// A stash whose base commit is inside the loaded window, ready to be injected
/// into the layout as a synthetic single-parent node (`oid` waiting on `base`).
struct StashMeta {
    oid: Oid,
    base: Oid,
    timestamp: i64,
    index: usize,
    message: String,
}

/// One node in the merged, date-ordered layout sequence: either a real commit
/// (by oid — the handle is re-opened once in the layout loop, a cheap ODB-cache
/// hit, so we don't retain every `git2::Commit` for the whole window) or an
/// injected in-window stash.
enum Entry<'a> {
    Commit(Oid),
    Stash(&'a StashMeta),
}

/// Read the stash reflog (`refs/stash`) via libgit2 and keep only the stashes
/// whose base (first parent) is inside `visible_oids`, so they can be laid out
/// inline. Out-of-window stashes are left to the frontend, which floats them by
/// time or rejoins them through a bounded context chain. Reading here (read side,
/// git2) keeps the graph self-contained and avoids coupling the skeleton to the
/// slower `git stash list` subprocess. Returns newest-first with the reflog index
/// preserved as the `stash@{index}` number.
fn read_in_window_stashes(repo: &Repository, visible_oids: &HashSet<Oid>) -> Vec<StashMeta> {
    let Ok(reflog) = repo.reflog("refs/stash") else {
        return Vec::new();
    };
    let mut metas = Vec::new();
    for (index, entry) in reflog.iter().enumerate() {
        let oid = entry.id_new();
        // If the stash commit itself is already in the revwalk (e.g. HEAD detached
        // at it, or otherwise reachable from a tip), it's laid out as a normal
        // commit — injecting it too would emit a duplicate node with the same id.
        if visible_oids.contains(&oid) {
            continue;
        }
        let Ok(commit) = repo.find_commit(oid) else {
            continue;
        };
        let Some(base) = commit.parent_ids().next() else {
            continue;
        };
        if !visible_oids.contains(&base) {
            continue;
        }
        metas.push(StashMeta {
            oid,
            base,
            timestamp: commit.time().seconds(),
            index,
            message: commit
                .summary_bytes()
                .map(|b| String::from_utf8_lossy(b).into_owned())
                .unwrap_or_default(),
        });
    }
    // Date-descending so the merge-interleave below can slot each stash in with a
    // single forward scan; the reflog index travels along as `stash@{index}`.
    metas.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    metas
}

/// Build the laid-out graph for `repo`, walking at most `limit` commits.
pub fn build(repo: &Repository, limit: usize) -> Result<RepoGraph, git2::Error> {
    build_profiled(repo, limit).map(|(graph, _metrics)| graph)
}

#[derive(Clone, Copy, Debug, Default)]
#[cfg_attr(not(test), allow(dead_code))]
pub struct GraphBuildMetrics {
    pub refs: Duration,
    pub revwalk: Duration,
    pub layout: Duration,
    pub edges: Duration,
    pub total: Duration,
}

/// Build the graph while returning coarse phase timings for the repeatable
/// release benchmark. Production callers use [`build`] and discard metrics.
pub fn build_profiled(
    repo: &Repository,
    limit: usize,
) -> Result<(RepoGraph, GraphBuildMetrics), git2::Error> {
    let total_started = Instant::now();
    // Walk in date order (libgit2's `TOPOLOGICAL | TIME`): children before
    // parents, with commit time as the tie-breaker. In the common case this
    // keeps a run of trunk merges grouped near the top and lets each merged
    // topic branch cascade *below* them — the grouped swimlane shape.
    // It's a heuristic, not a guarantee: the grouping rides on commit
    // timestamps, so rebased or clock-skewed branches whose commits predate
    // their own merge can interleave differently. Tips still surface first, so
    // the newest commits land at the top.
    //
    // This pairs with the branch-root lane assignment below: each merge's second
    // parent gets its own column held open until the branch renders, so the
    // long merge connectors run down empty lanes instead of overlapping commits.
    // (Pure `Sort::TOPOLOGICAL` would tend to interleave each merge directly
    // above its own branch — a tidy staircase, but not the grouped look here.)
    let revwalk_started = Instant::now();
    let mut walk = repo.revwalk()?;
    walk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME)?;
    // Seed from every branch tip so branches outside HEAD's history still show.
    // Tolerate a failed seed (consistent with the remotes/HEAD seeds below); an
    // empty walk simply yields an empty graph rather than aborting the read.
    let _ = walk.push_glob("refs/heads/*");
    let _ = walk.push_glob("refs/remotes/*");
    let _ = walk.push_head();

    // Collect one extra to detect truncation.
    let mut oids: Vec<Oid> = Vec::new();
    for oid in walk {
        let oid = oid?;
        oids.push(oid);
        if oids.len() > limit {
            break;
        }
    }
    let truncated = oids.len() > limit;
    if truncated {
        oids.truncate(limit);
    }
    let revwalk_elapsed = revwalk_started.elapsed();
    let refs_started = Instant::now();
    let visible_oids: HashSet<Oid> = oids.iter().copied().collect();
    let refs_map = collect_refs(repo, &visible_oids);
    let refs_elapsed = refs_started.elapsed();
    let (head, _detached) = head_oid(repo);
    let head_target = head
        .as_deref()
        .and_then(|value| Oid::from_str(value).ok())
        .filter(|oid| visible_oids.contains(oid));

    // `lanes[i]` holds the parent oid that lane `i` is reserved for (or None),
    // plus whether that reservation is a *branch root* — i.e. opened because a
    // merge pulled the parent in as a topic branch, rather than a plain
    // first-parent continuation. The flag is what lets stacked branches keep
    // their own columns instead of collapsing onto one lane.
    // Collect just (oid, committer time) so we can interleave stashes by time
    // without holding every commit handle alive for the whole layout pass; the
    // full handle is re-opened once per commit in the loop below.
    let commit_times: Vec<(Oid, i64)> = oids
        .iter()
        .map(|oid| repo.find_commit(*oid).map(|c| (*oid, c.time().seconds())))
        .collect::<Result<_, _>>()?;

    // Inject stashes whose base is in the window. Merge them into the date-ordered
    // walk: emit each stash created at-or-after a commit's time just before that
    // commit, so it slots in where it was created — then the reservation algorithm
    // below holds its lane open down to the base (fan shifts right).
    // Tie-break: `>=` (not `>`). A stash's committer time is always >= its base's,
    // so on a tie the stash must still emit *above* the base — a synthetic child
    // has to render before its parent or the reserved lane/edge would invert.
    let stash_metas = read_in_window_stashes(repo, &visible_oids);
    let mut order: Vec<Entry> = Vec::with_capacity(commit_times.len() + stash_metas.len());
    let mut next_stash = 0usize;
    for &(oid, ct) in &commit_times {
        while next_stash < stash_metas.len() && stash_metas[next_stash].timestamp >= ct {
            order.push(Entry::Stash(&stash_metas[next_stash]));
            next_stash += 1;
        }
        order.push(Entry::Commit(oid));
    }
    while next_stash < stash_metas.len() {
        order.push(Entry::Stash(&stash_metas[next_stash]));
        next_stash += 1;
    }

    let layout_started = Instant::now();
    let mut lanes: Vec<Option<Lane>> = head_target
        .map(|oid| vec![Some(Lane::cont(oid))])
        .unwrap_or_default();
    let mut nodes: Vec<CommitNode> = Vec::with_capacity(order.len());
    let mut row_of: HashMap<Oid, usize> = HashMap::new();
    let mut lane_of: HashMap<Oid, usize> = HashMap::new();
    let mut lane_count = 0usize;
    let mut wip_lane: Option<usize> = None;
    let mut wip_color: Option<usize> = None;

    for (row, entry) in order.iter().enumerate() {
        // Re-open the commit handle once here (ODB-cache hit) and reuse it for both
        // the parent walk and node construction below.
        let commit = match entry {
            Entry::Commit(oid) => Some(repo.find_commit(*oid)?),
            Entry::Stash(_) => None,
        };
        // A stash node carries just its base as a single (synthetic) parent, so it
        // reserves one lane held open to the base — never fanning out to the
        // stash's index/untracked parents, which aren't real history.
        let (oid, parents): (Oid, Vec<Oid>) = match entry {
            Entry::Commit(oid) => {
                let commit = commit.as_ref().unwrap();
                (*oid, commit.parent_ids().collect())
            }
            Entry::Stash(stash) => (stash.oid, vec![stash.base]),
        };

        // Claim a lane for this commit. Several lanes may await it: a branch-root
        // reservation (a merge introduced it as a topic branch) wins so the
        // branch renders in its own column; otherwise the lowest first-parent
        // continuation wins. Every other lane awaiting this oid is freed — those
        // become connector edges resolved later from (row, lane).
        let mut root_lane: Option<usize> = None;
        let mut cont_lane: Option<usize> = None;
        for slot in 0..lanes.len() {
            if let Some(l) = &lanes[slot] {
                if l.waiting == oid {
                    if l.branch_root {
                        root_lane.get_or_insert(slot);
                    } else {
                        cont_lane.get_or_insert(slot);
                    }
                }
            }
        }
        let awaited_lane = if head_target == Some(oid) {
            cont_lane.or(root_lane)
        } else {
            root_lane.or(cont_lane)
        };
        let lane = awaited_lane.unwrap_or_else(|| alloc_lane(&mut lanes));
        if matches!(entry, Entry::Commit(_)) && head_target == Some(oid) {
            wip_lane = Some(lane);
            wip_color = Some(lane);
        }
        for slot in 0..lanes.len() {
            if slot != lane && matches!(&lanes[slot], Some(l) if l.waiting == oid) {
                lanes[slot] = None;
            }
        }

        // Reserve onward lanes for parents: the first parent continues this lane;
        // each additional (merge) parent opens its own branch-root lane *iff* its
        // commit isn't already spoken for. If some lane already awaits that parent,
        // the branch it belongs to has finished rendering above and handed the
        // lane off — so collapse into it instead of opening a redundant column.
        // This is what keeps a branch merged more than once (and the shallow
        // hand-off between sequential branches) in a single lane, while genuinely
        // concurrent stacked branches — whose merges are reached before their
        // commits render — still fan out into their own columns.
        if parents.is_empty() {
            lanes[lane] = None;
        } else {
            let first_parent_already_awaited = lanes
                .iter()
                .enumerate()
                .any(|(slot, s)| slot != lane && matches!(s, Some(l) if l.waiting == parents[0]));
            if head_target == Some(oid) && first_parent_already_awaited {
                lanes[lane] = None;
            } else {
                lanes[lane] = Some(Lane::cont(parents[0]));
            }
            for &p in &parents[1..] {
                if lanes.iter().any(|s| matches!(s, Some(l) if l.waiting == p)) {
                    continue; // already awaited → collapse, don't fan out
                }
                let l = alloc_lane(&mut lanes);
                lanes[l] = Some(Lane::root(p));
            }
        }

        lane_count = lane_count.max(lanes.len());
        row_of.insert(oid, row);
        lane_of.insert(oid, lane);

        let node = match entry {
            Entry::Commit(_) => {
                let commit = commit.as_ref().unwrap();
                let author = commit.author();
                CommitNode {
                    id: oid.to_string(),
                    short_id: oid.to_string().chars().take(7).collect(),
                    // Lossy-decode so a non-UTF-8 commit message degrades to a
                    // readable approximation instead of an empty summary/body.
                    summary: commit
                        .summary_bytes()
                        .map(|b| String::from_utf8_lossy(b).into_owned())
                        .unwrap_or_default(),
                    body: commit
                        .body_bytes()
                        .map(|b| String::from_utf8_lossy(b).trim().to_string())
                        .unwrap_or_default(),
                    author_name: author.name().ok().unwrap_or("").to_string(),
                    author_email: author.email().ok().unwrap_or("").to_string(),
                    timestamp: commit.time().seconds(),
                    parents: parents.iter().map(|p| p.to_string()).collect(),
                    lane,
                    row,
                    color: lane,
                    refs: refs_map.get(&oid).cloned().unwrap_or_default(),
                    stash: None,
                }
            }
            Entry::Stash(stash) => CommitNode {
                id: oid.to_string(),
                short_id: oid.to_string().chars().take(7).collect(),
                summary: stash.message.clone(),
                body: String::new(),
                author_name: String::new(),
                author_email: String::new(),
                timestamp: stash.timestamp,
                parents: parents.iter().map(|p| p.to_string()).collect(),
                lane,
                row,
                color: lane,
                refs: Vec::new(),
                stash: Some(StashRef {
                    index: stash.index,
                    message: stash.message.clone(),
                }),
            },
        };
        nodes.push(node);
    }
    let layout_elapsed = layout_started.elapsed();

    // Resolve edges now that every visible commit has a (row, lane).
    let edges_started = Instant::now();
    let mut edges: Vec<GraphEdge> = Vec::new();
    for node in &nodes {
        for (parent_index, parent) in node.parents.iter().enumerate() {
            let poid = match Oid::from_str(parent) {
                Ok(o) => o,
                Err(_) => continue,
            };
            let (Some(&to_row), Some(&to_lane)) = (row_of.get(&poid), lane_of.get(&poid)) else {
                continue; // parent beyond the truncation window
            };
            // Color diagonal (branch/merge) segments by their destination lane,
            // keep straight first-parent segments on the child's color.
            let color = if to_lane == node.lane {
                node.lane
            } else {
                to_lane
            };
            edges.push(GraphEdge {
                from_row: node.row,
                from_lane: node.lane,
                to_row,
                to_lane,
                parent_index,
                color,
            });
        }
    }

    let edges_elapsed = edges_started.elapsed();

    Ok((
        RepoGraph {
            commits: nodes,
            edges,
            lane_count,
            wip_lane,
            wip_color,
            head,
            truncated,
        },
        GraphBuildMetrics {
            refs: refs_elapsed,
            revwalk: revwalk_elapsed,
            layout: layout_elapsed,
            edges: edges_elapsed,
            total: total_started.elapsed(),
        },
    ))
}

/// A lane reservation: the parent oid this lane is waiting to render, and whether
/// it was opened as a merge's topic branch (`branch_root`) rather than a plain
/// first-parent continuation. When a commit is awaited by both a branch-root lane
/// and a continuation, the branch-root lane wins — that's what gives a merged
/// branch its own column rather than collapsing onto the first parent's lane.
struct Lane {
    waiting: Oid,
    branch_root: bool,
}

impl Lane {
    fn cont(waiting: Oid) -> Self {
        Lane {
            waiting,
            branch_root: false,
        }
    }
    fn root(waiting: Oid) -> Self {
        Lane {
            waiting,
            branch_root: true,
        }
    }
}

/// Find a free lane slot, reusing the lowest gap if one exists, otherwise
/// appending a new lane.
fn alloc_lane(lanes: &mut Vec<Option<Lane>>) -> usize {
    match lanes.iter().position(|s| s.is_none()) {
        Some(i) => i,
        None => {
            lanes.push(None);
            lanes.len() - 1
        }
    }
}

/// Map each commit oid to the refs (branches/remotes/tags/HEAD) pointing at it.
fn collect_refs(repo: &Repository, visible_oids: &HashSet<Oid>) -> HashMap<Oid, Vec<RefLabel>> {
    let mut map: HashMap<Oid, Vec<RefLabel>> = HashMap::new();

    if let Ok(refs) = repo.references() {
        for r in refs.flatten() {
            let name = r.shorthand().ok().unwrap_or("").to_string();
            if name.is_empty() || name.ends_with("/HEAD") {
                continue;
            }
            let (kind, oid) = if r.is_remote() {
                ("remote", r.target())
            } else if r.is_tag() {
                // Lightweight tags have a direct commit target; annotated tags
                // need one peel through the tag object.
                let oid = r
                    .target()
                    .filter(|target| repo.find_commit(*target).is_ok())
                    .or_else(|| r.peel_to_commit().ok().map(|commit| commit.id()));
                ("tag", oid)
            } else if r.is_branch() {
                ("branch", r.target())
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
            });
        }
    }

    // Mark HEAD so the renderer can highlight the checked-out tip.
    if let (Some(oid_str), _) = head_oid(repo) {
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
            });
        }
    }

    map
}

/// Resolve HEAD to a commit oid string and whether it is detached.
fn head_oid(repo: &Repository) -> (Option<String>, bool) {
    let detached = repo.head_detached().unwrap_or(false);
    let oid = repo
        .head()
        .ok()
        .and_then(|h| h.peel_to_commit().ok())
        .map(|c| c.id().to_string());
    (oid, detached)
}

#[cfg(test)]
mod tests {
    use super::{build, build_profiled};
    use git2::{Oid, Repository, Signature, Time};
    use std::env;
    use std::fs;
    use std::path::Path;
    use std::time::{Duration, Instant};

    fn sig(seconds: i64) -> Signature<'static> {
        Signature::new("Bench", "bench@example.test", &Time::new(seconds, 0)).unwrap()
    }

    fn commit_on(
        repo: &Repository,
        dir: &Path,
        reference: &str,
        name: &str,
        content: &str,
        parents: &[Oid],
        seconds: i64,
    ) -> Oid {
        fs::write(dir.join(name), content).unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new(name)).unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let parent_commits: Vec<git2::Commit> = parents
            .iter()
            .map(|p| repo.find_commit(*p).unwrap())
            .collect();
        let parent_refs: Vec<&git2::Commit> = parent_commits.iter().collect();
        let signature = sig(seconds);
        repo.commit(
            Some(reference),
            &signature,
            &signature,
            name,
            &tree,
            &parent_refs,
        )
        .unwrap()
    }

    /// An in-window stash is injected as a node that reserves its own lane: a
    /// concurrent branch commit rendered between the stash and its base is pushed
    /// off the stash's lane, and the stash carries a dashed edge to the base.
    #[test]
    fn in_window_stash_reserves_a_lane_to_its_base() {
        let dir = std::env::temp_dir().join("gitlane-stash-lane-test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let mut repo = Repository::init(&dir).unwrap();

        let c1 = commit_on(&repo, &dir, "HEAD", "a.txt", "v1\n", &[], 100);
        let base = commit_on(&repo, &dir, "HEAD", "a.txt", "v2\n", &[c1], 200);
        // A concurrent branch tip whose time (220) lands between the base (200)
        // and the stash (250), so it shares the stash's vertical span.
        let b1 = commit_on(&repo, &dir, "refs/heads/b", "a.txt", "vb\n", &[base], 220);

        // Dirty the worktree (HEAD is still `base`) and stash at t=250.
        fs::write(dir.join("a.txt"), "dirty\n").unwrap();
        repo.stash_save2(&sig(250), Some("WIP on master"), None)
            .unwrap();
        // A newer commit on top so history extends above the stash too.
        let _c3 = commit_on(&repo, &dir, "HEAD", "a.txt", "v3\n", &[base], 300);

        let graph = build(&repo, 100).unwrap();

        let stash_node = graph
            .commits
            .iter()
            .find(|node| node.stash.is_some())
            .expect("stash injected as a graph node");
        let stash_ref = stash_node.stash.as_ref().unwrap();
        assert_eq!(stash_ref.index, 0, "most-recent stash is stash@{{0}}");
        assert_eq!(
            stash_node.parents,
            vec![base.to_string()],
            "stash's only layout parent is its base",
        );

        let base_node = graph
            .commits
            .iter()
            .find(|node| node.id == base.to_string())
            .expect("base commit is in the window");
        let b1_node = graph
            .commits
            .iter()
            .find(|node| node.id == b1.to_string())
            .expect("concurrent branch tip is in the window");

        // The reserved lane is held from the stash down to its base: no other node
        // in that span reuses it — in particular the concurrent branch is shoved off.
        assert_ne!(
            b1_node.lane, stash_node.lane,
            "concurrent branch is pushed off the stash's reserved lane",
        );
        for node in &graph.commits {
            if node.row > stash_node.row && node.row < base_node.row {
                assert_ne!(
                    node.lane, stash_node.lane,
                    "node {} reused the held stash lane",
                    node.id,
                );
            }
        }

        // The dashed connector to the base exists as a real edge from the stash row.
        assert!(
            graph
                .edges
                .iter()
                .any(|edge| edge.from_row == stash_node.row && edge.to_row == base_node.row),
            "stash node has an edge to its base",
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// A stash whose committer time equals its base's still renders *above* the
    /// base (synthetic child before parent), so the reserved lane/edge don't invert.
    #[test]
    fn stash_sharing_its_base_timestamp_renders_above_the_base() {
        let dir = std::env::temp_dir().join("gitlane-stash-eqts-test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let mut repo = Repository::init(&dir).unwrap();

        let c1 = commit_on(&repo, &dir, "HEAD", "a.txt", "v1\n", &[], 100);
        let base = commit_on(&repo, &dir, "HEAD", "a.txt", "v2\n", &[c1], 200);
        fs::write(dir.join("a.txt"), "dirty\n").unwrap();
        // Stash committer time == base committer time (200).
        repo.stash_save2(&sig(200), Some("WIP same second"), None)
            .unwrap();
        let _c3 = commit_on(&repo, &dir, "HEAD", "a.txt", "v3\n", &[base], 300);

        let graph = build(&repo, 100).unwrap();
        let stash_node = graph
            .commits
            .iter()
            .find(|n| n.stash.is_some())
            .expect("stash node");
        let base_node = graph
            .commits
            .iter()
            .find(|n| n.id == base.to_string())
            .expect("base node");

        assert!(
            stash_node.row < base_node.row,
            "stash (row {}) must render above its base (row {})",
            stash_node.row,
            base_node.row,
        );
        assert!(
            graph
                .edges
                .iter()
                .any(|e| e.from_row == stash_node.row && e.to_row == base_node.row),
            "stash edge runs down to the base",
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// A stash commit that is itself reachable (HEAD detached at it) is laid out as
    /// a normal commit and must NOT also be injected — no duplicate node id.
    #[test]
    fn stash_already_in_the_walk_is_not_injected_twice() {
        let dir = std::env::temp_dir().join("gitlane-stash-dup-test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let mut repo = Repository::init(&dir).unwrap();

        let c1 = commit_on(&repo, &dir, "HEAD", "a.txt", "v1\n", &[], 100);
        let _base = commit_on(&repo, &dir, "HEAD", "a.txt", "v2\n", &[c1], 200);
        fs::write(dir.join("a.txt"), "dirty\n").unwrap();
        repo.stash_save2(&sig(250), Some("WIP detached"), None)
            .unwrap();
        let stash_oid = repo.find_reference("refs/stash").unwrap().target().unwrap();
        // Detach HEAD onto the stash commit so the revwalk sees it as a commit.
        repo.set_head_detached(stash_oid).unwrap();

        let graph = build(&repo, 100).unwrap();
        let with_stash_id = graph
            .commits
            .iter()
            .filter(|n| n.id == stash_oid.to_string())
            .count();
        assert_eq!(
            with_stash_id, 1,
            "the stash commit appears exactly once, not duplicated"
        );
        assert!(
            graph.commits.iter().all(|n| n.stash.is_none()),
            "the reachable stash commit is laid out as a plain commit, not injected",
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn checked_out_head_ancestor_stays_on_wip_mainline() {
        let dir = std::env::temp_dir().join("gitlane-head-lane-test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let repo = Repository::init(&dir).unwrap();

        let c1 = commit_on(&repo, &dir, "HEAD", "a.txt", "v1\n", &[], 100);
        let c2 = commit_on(&repo, &dir, "HEAD", "a.txt", "v2\n", &[c1], 200);
        let feature = commit_on(
            &repo,
            &dir,
            "refs/heads/feature",
            "a.txt",
            "feature\n",
            &[c2],
            300,
        );
        let merge = commit_on(
            &repo,
            &dir,
            "refs/heads/staging",
            "a.txt",
            "merge\n",
            &[c2, feature],
            400,
        );
        let _staging_tip = commit_on(
            &repo,
            &dir,
            "refs/heads/staging",
            "a.txt",
            "staging\n",
            &[merge],
            500,
        );
        repo.set_head("refs/heads/feature").unwrap();

        let graph = build(&repo, 100).unwrap();
        let head_node = graph
            .commits
            .iter()
            .find(|node| node.id == feature.to_string())
            .expect("feature HEAD is in the graph");
        let merge_node = graph
            .commits
            .iter()
            .find(|node| node.id == merge.to_string())
            .expect("staging merge is in the graph");
        let base_node = graph
            .commits
            .iter()
            .find(|node| node.id == c2.to_string())
            .expect("shared base is in the graph");

        assert_eq!(graph.head.as_deref(), Some(feature.to_string().as_str()));
        assert_eq!(
            graph.wip_lane,
            Some(head_node.lane),
            "WIP continues the checked-out HEAD mainline",
        );
        assert!(
            merge_node.lane > head_node.lane,
            "newer first-parent staging lane goes right of the checked-out mainline",
        );
        assert_eq!(
            base_node.lane, merge_node.lane,
            "checked-out branch hands off to the already-open staging first-parent lane below HEAD",
        );
        assert!(
            graph.edges.iter().any(|edge| {
                edge.from_row == merge_node.row
                    && edge.to_row == head_node.row
                    && edge.parent_index == 1
            }),
            "the merge reaches the checked-out branch as a second-parent edge",
        );
        assert!(
            head_node
                .refs
                .iter()
                .any(|r| r.kind == "head" && r.name == "feature"),
            "the checked-out branch still labels the real HEAD commit",
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    #[ignore = "run explicitly against a generated fixture in release mode"]
    fn benchmark_fixture() {
        let path = env::var("GITLANE_BENCH_REPO")
            .expect("set GITLANE_BENCH_REPO to a generated benchmark repository");
        let limit = env::var("GITLANE_BENCH_LIMIT")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(10_000);
        let iterations = env::var("GITLANE_BENCH_ITERATIONS")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(5);
        let repo = Repository::discover(&path).expect("open benchmark repository");

        let mut refs = Duration::ZERO;
        let mut revwalk = Duration::ZERO;
        let mut layout = Duration::ZERO;
        let mut edges = Duration::ZERO;
        let mut total = Duration::ZERO;
        let mut serialization = Duration::ZERO;
        let mut payload_bytes = 0usize;
        let mut commits = 0usize;
        let mut lanes = 0usize;

        for _ in 0..iterations {
            let (graph, metrics) = build_profiled(&repo, limit).expect("build graph");
            let serialize_started = Instant::now();
            let payload = serde_json::to_vec(&graph).expect("serialize graph");
            serialization += serialize_started.elapsed();
            payload_bytes = payload.len();
            commits = graph.commits.len();
            lanes = graph.lane_count;
            refs += metrics.refs;
            revwalk += metrics.revwalk;
            layout += metrics.layout;
            edges += metrics.edges;
            total += metrics.total;
        }

        let average_ms = |duration: Duration| duration.as_secs_f64() * 1_000.0 / iterations as f64;
        println!(
            "GITLANE_GRAPH_BENCH {}",
            serde_json::json!({
                "path": path,
                "limit": limit,
                "iterations": iterations,
                "commits": commits,
                "lanes": lanes,
                "payloadBytes": payload_bytes,
                "averageMs": {
                    "refs": average_ms(refs),
                    "revwalk": average_ms(revwalk),
                    "layout": average_ms(layout),
                    "edges": average_ms(edges),
                    "graphTotal": average_ms(total),
                    "serialization": average_ms(serialization),
                }
            })
        );
    }
}
