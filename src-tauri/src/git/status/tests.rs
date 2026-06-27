use super::commit_file_diff;
use super::diff::DIFF_LINE_LIMIT;
use git2::{Repository, Signature};
use std::fs;
use std::path::Path;

fn commit(repo: &Repository, dir: &Path, name: &str, content: &str) -> git2::Oid {
    fs::write(dir.join(name), content).unwrap();
    let mut index = repo.index().unwrap();
    index.add_path(Path::new(name)).unwrap();
    index.write().unwrap();
    let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
    let sig = Signature::now("Bench", "bench@example.test").unwrap();
    let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    let parents: Vec<&git2::Commit> = parent.iter().collect();
    repo.commit(Some("HEAD"), &sig, &sig, name, &tree, &parents)
        .unwrap()
}

#[test]
fn large_commit_diff_truncates_until_full_is_requested() {
    let dir = std::env::temp_dir().join("gitlane-diff-cap-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();
    commit(&repo, &dir, "seed.txt", "seed\n");

    let extra = 500;
    let big: String = (0..DIFF_LINE_LIMIT + extra)
        .map(|i| format!("line {i}\n"))
        .collect();
    let oid = commit(&repo, &dir, "big.txt", &big).to_string();
    let path = dir.to_str().unwrap();

    // Default: capped at the line limit, but the +add pill keeps the real total.
    let capped = commit_file_diff(path, &oid, "big.txt", false).unwrap();
    let shown: usize = capped.hunks.iter().map(|h| h.lines.len()).sum();
    assert!(capped.truncated);
    assert!(shown <= DIFF_LINE_LIMIT, "shown {shown}");
    assert_eq!(capped.add, DIFF_LINE_LIMIT + extra);

    // "Show full diff": uncapped, every line present.
    let full = commit_file_diff(path, &oid, "big.txt", true).unwrap();
    let full_shown: usize = full.hunks.iter().map(|h| h.lines.len()).sum();
    assert!(!full.truncated);
    assert_eq!(full_shown, DIFF_LINE_LIMIT + extra);

    let _ = fs::remove_dir_all(&dir);
}
