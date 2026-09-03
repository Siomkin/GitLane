//! Thread placement audit (`ipc/commands` spec, "Repository reads keep the
//! interface responsive"): a synchronous Tauri command runs on the webview's
//! main thread, so any repository-sized read or subprocess declared as a plain
//! `fn` freezes the UI until it returns. The compiler cannot tell the two
//! shapes apart; this test can.

use std::collections::BTreeSet;
use std::fs;

use super::{command_signatures, command_source_files};

/// The only commands that deliberately stay synchronous. Each is an
/// in-process lock-and-signal or settings-file operation that returns in
/// microseconds — and a cancel must never queue behind the blocking pool that
/// the operation it cancels is holding. Every other command is `async fn` +
/// `blocking()`.
///
/// The list is exact in both directions: a sync command missing from it fails
/// the test, and so does a listed command that is already async or no longer
/// exists, so stale entries cannot accumulate. Adding a name here is a design
/// decision — say in the command's doc comment why it is instant.
const SYNC_BY_DESIGN: &[&str] = &[
    "cancel_clone",
    "cancel_github_sign_in",
    "cancel_provider_oauth_sign_in",
    "commit_agent_messages_get",
    "commit_agent_messages_reset",
    "commit_agent_messages_set",
    "pty_kill",
    "pty_resize",
    "pty_write",
    "terminal_agents_set",
];

#[test]
fn every_command_is_async_unless_sync_by_design() {
    let allowed: BTreeSet<&str> = SYNC_BY_DESIGN.iter().copied().collect();
    let mut declared = BTreeSet::new();
    let mut unlisted_sync = Vec::new();
    let mut listed_but_async = Vec::new();
    for file in command_source_files() {
        let source = fs::read_to_string(&file).unwrap();
        for sig in command_signatures(&source) {
            let listed = allowed.contains(sig.name.as_str());
            match (sig.is_async, listed) {
                (false, false) => {
                    unlisted_sync.push(format!("{} ({}:{})", sig.name, file.display(), sig.line))
                }
                (true, true) => listed_but_async.push(sig.name.clone()),
                _ => {}
            }
            declared.insert(sig.name);
        }
    }
    let unknown: Vec<_> = allowed
        .iter()
        .filter(|name| !declared.contains(**name))
        .collect();
    assert!(
        unknown.is_empty(),
        "SYNC_BY_DESIGN names commands that are not declared: {unknown:?}"
    );
    assert!(
        listed_but_async.is_empty(),
        "stale SYNC_BY_DESIGN entries — these commands are already async: {listed_but_async:?}"
    );
    assert!(
        unlisted_sync.is_empty(),
        "sync commands run on the webview thread and freeze the UI; make them \
         `async fn` + `blocking()` (or, if genuinely instant, add them to \
         SYNC_BY_DESIGN with a reason): {unlisted_sync:?}"
    );
}
