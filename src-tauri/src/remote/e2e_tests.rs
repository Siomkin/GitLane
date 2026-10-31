//! End to end over real `ssh`: install this build's agent on a host, connect,
//! read a repository, and see a change made on the server arrive as an event.
//! Opt-in, since it needs a reachable host and a Linux agent build:
//!
//! GITLANE_E2E_HOST=<ssh alias> GITLANE_AGENT_PATH=<musl agent> \
//!   cargo test --lib remote::e2e_tests -- --nocapture

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::connect::{connect, ssh_command};
use super::install::{ensure_installed, Step};
use super::locator::Locator;

fn run<F: std::future::Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap()
        .block_on(future)
}

fn on_host(locator: &Locator, script: &str) -> String {
    let out = ssh_command(locator)
        .arg(format!("sh -c '{script}'"))
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

#[test]
fn install_connect_read_and_watch_over_real_ssh() {
    let Ok(host) = std::env::var("GITLANE_E2E_HOST") else {
        eprintln!("skipped: set GITLANE_E2E_HOST and GITLANE_AGENT_PATH to run");
        return;
    };
    let probe = Locator::parse(&format!("ssh://{host}/tmp")).unwrap();
    let repo = format!("/tmp/gitlane-e2e-{}", std::process::id());
    on_host(
        &probe,
        &format!(
            "rm -rf {repo} && git init -q {repo} && cd {repo} && echo one > a.txt && git add a.txt && git -c user.name=e2e -c user.email=e2e@example.test commit -qm first"
        ),
    );
    let locator = Locator::parse(&format!("ssh://{host}{repo}")).unwrap();

    let cache = std::env::temp_dir().join(format!("gitlane-e2e-cache-{}", std::process::id()));
    let steps: Arc<Mutex<Vec<Step>>> = Arc::default();
    let seen = steps.clone();
    let started = Instant::now();
    ensure_installed(&locator, &cache, &move |s| seen.lock().unwrap().push(s)).unwrap();
    eprintln!(
        "install: {:?}, {} progress steps",
        started.elapsed(),
        steps.lock().unwrap().len()
    );

    let events: Arc<Mutex<Vec<(String, Value)>>> = Arc::default();
    let sink = events.clone();
    let started = Instant::now();
    let (session, hello) = connect(
        &locator,
        Arc::new(move |name, payload| sink.lock().unwrap().push((name.to_string(), payload))),
        Box::new(|| {}),
    )
    .unwrap();
    eprintln!("connect: {:?}, hello {hello:?}", started.elapsed());

    let summary = run(session.request("open_repo", json!({ "path": repo }))).unwrap();
    assert_eq!(summary["path"], json!(repo));
    let status = run(session.request("working_changes", json!({ "path": repo }))).unwrap();
    assert!(status.get("unstaged").is_some(), "{status}");

    run(session.request("watch_repo", json!({ "path": repo }))).unwrap();
    on_host(&probe, &format!("echo two >> {repo}/a.txt"));
    let deadline = Instant::now() + Duration::from_secs(10);
    while events.lock().unwrap().is_empty() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(100));
    }
    let first = events.lock().unwrap().first().cloned();
    assert_eq!(
        first.map(|(name, payload)| (name, payload["path"].clone())),
        Some((crate::events::REPO_CHANGED.to_string(), json!(repo)))
    );

    // Already installed: the second check uploads nothing.
    let again: Arc<Mutex<Vec<Step>>> = Arc::default();
    let seen = again.clone();
    ensure_installed(&locator, &cache, &move |s| seen.lock().unwrap().push(s)).unwrap();
    assert!(again.lock().unwrap().is_empty());

    session.close();
    on_host(&probe, &format!("rm -rf {repo}"));
    let _ = std::fs::remove_dir_all(cache);
}
