//! Shared fixtures for the graph tests: a fixed signature, a commit builder,
//! and the benchmark repository.

pub(super) use super::super::{build, build_profiled};
pub(super) use git2::{ObjectType, Oid, Repository, Signature, Time};
pub(super) use std::env;
pub(super) use std::fs;
pub(super) use std::path::Path;
pub(super) use std::time::{Duration, Instant};

pub(super) fn sig(seconds: i64) -> Signature<'static> {
    Signature::new("Bench", "bench@example.test", &Time::new(seconds, 0)).unwrap()
}

pub(super) fn commit_on(
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

#[test]
#[ignore = "run explicitly against a generated fixture in release mode"]
pub(super) fn benchmark_fixture() {
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
