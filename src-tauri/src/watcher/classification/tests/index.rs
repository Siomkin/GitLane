//! Index-only events: a stat-cache rewrite by another tool's `git status` is
//! dropped, a real entry change still refreshes.

use super::super::fingerprints::{index_entries_changed, index_fingerprint};
use super::super::{ChangeKind, EmitState, handle_event};
use crate::watcher::{OnChange, WatchRoots};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

#[test]
fn an_unchanged_fingerprint_is_not_a_change_and_an_unreadable_one_always_is() {
    let mut previous = Some(7);
    assert!(!index_entries_changed(&mut previous, Some(7)));
    assert_eq!(previous, Some(7));
    assert!(index_entries_changed(&mut previous, Some(8)));
    assert_eq!(previous, Some(8));
    assert!(
        index_entries_changed(&mut previous, None),
        "an unreadable index refreshes"
    );
    assert!(
        index_entries_changed(&mut previous, None),
        "and keeps refreshing until readable"
    );
}

#[test]
fn a_stat_refresh_keeps_the_fingerprint_and_a_new_entry_changes_it() {
    let dir = std::env::temp_dir().join(format!("gitlane-index-fp-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let git = |args: &[&str]| {
        let out = Command::new("git")
            .arg("-C")
            .arg(&dir)
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    };
    git(&["init", "-q", "-b", "main"]);
    git(&["config", "user.name", "GitLane Test"]);
    git(&["config", "user.email", "gitlane@example.test"]);
    git(&["config", "commit.gpgsign", "false"]);
    std::fs::write(dir.join("tracked.txt"), "same\n").unwrap();
    git(&["add", "tracked.txt"]);
    git(&["commit", "-q", "-m", "seed"]);
    let before = index_fingerprint(&dir).expect("readable index");

    // Same content, newer mtime: a plain `git status` (optional locks on, as
    // any other tool runs it) rewrites the index with refreshed stat data.
    std::fs::File::options()
        .write(true)
        .open(dir.join("tracked.txt"))
        .unwrap()
        .set_modified(SystemTime::now() + Duration::from_secs(120))
        .unwrap();
    let index_bytes = std::fs::read(dir.join(".git/index")).unwrap();
    git(&["status", "--porcelain"]);
    assert_ne!(
        std::fs::read(dir.join(".git/index")).unwrap(),
        index_bytes,
        "precondition: the status rewrote the index"
    );
    assert_eq!(
        index_fingerprint(&dir),
        Some(before),
        "only stat data changed"
    );

    std::fs::write(dir.join("new.txt"), "new\n").unwrap();
    git(&["add", "new.txt"]);
    assert_ne!(
        index_fingerprint(&dir),
        Some(before),
        "a staged file is a real change"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn handle_event_drops_a_stat_only_index_write_and_emits_a_real_one() {
    let dir = std::env::temp_dir().join(format!("gitlane-index-emit-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let git = |args: &[&str]| {
        let out = Command::new("git")
            .arg("-C")
            .arg(&dir)
            .args(args)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}");
    };
    git(&["init", "-q", "-b", "main"]);
    std::fs::write(dir.join("tracked.txt"), "same\n").unwrap();
    git(&["add", "tracked.txt"]);

    let emitted: Arc<Mutex<Vec<ChangeKind>>> = Arc::default();
    let sink = Arc::clone(&emitted);
    let on_change: OnChange = Arc::new(move |kind, _| sink.lock().unwrap().push(kind));
    let roots = WatchRoots {
        workdir: dir.clone(),
        gitdir: None,
        commondir: None,
    };
    let state = Mutex::new(EmitState {
        // Outside the throttle window, so only the fingerprint decides.
        last: Instant::now()
            .checked_sub(Duration::from_secs(5))
            .expect("the clock is past five seconds"),
        last_kind: ChangeKind::Worktree,
        last_graph_fingerprint: None,
        last_index_fingerprint: index_fingerprint(&dir),
    });
    let index_write = notify::Event::new(notify::EventKind::Any).add_path(dir.join(".git/index"));
    let fire = || {
        handle_event(
            &on_change,
            "tab",
            &roots,
            &dir,
            |_| false,
            &state,
            &index_write,
        )
    };

    fire();
    assert!(
        emitted.lock().unwrap().is_empty(),
        "entries unchanged: no refresh"
    );

    std::fs::write(dir.join("new.txt"), "new\n").unwrap();
    git(&["add", "new.txt"]);
    fire();
    assert_eq!(
        *emitted.lock().unwrap(),
        vec![ChangeKind::Worktree],
        "a staged file refreshes status"
    );

    let _ = std::fs::remove_dir_all(&dir);
}
