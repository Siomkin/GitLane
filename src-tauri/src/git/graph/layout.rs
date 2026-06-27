//! Commit graph construction and swimlane layout.

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use git2::{Oid, Repository, Sort};

use crate::git::types::{CommitNode, GraphEdge, RepoGraph, StashRef};

use super::refs::{collect_refs, head_oid};
use super::stashes::{read_in_window_stashes, Entry};

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
    // Tags are also seeds: release tags can point at commits that were never
    // merged back to a branch. They still compete inside the same `limit`
    // window as branch tips, but tag-only commits should be eligible to appear.
    // Tolerate a failed seed (consistent with the remotes/HEAD seeds below); an
    // empty walk simply yields an empty graph rather than aborting the read.
    let _ = walk.push_glob("refs/heads/*");
    let _ = walk.push_glob("refs/remotes/*");
    let _ = walk.push_glob("refs/tags/*");
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
