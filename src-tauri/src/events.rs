//! The backend → webview event contract: every event name, declared once.
//!
//! An event name is a string on both sides of IPC, so a rename on one side
//! compiles and passes every test while silently going quiet at runtime. The
//! names live here as constants, `src/lib/api/events.ts` declares the same set
//! for the listeners, and the parity test in this module's `mod tests` asserts
//! the two sets are equal — the same technique
//! [`crate::commands::registration_tests`] uses to guard the command registry.
//!
//! [`emit`] is the crate's only `Emitter::emit` call site, so an event cannot
//! be published under an undeclared name. Emission is deliberately
//! fire-and-forget: every one of these events is progress or invalidation
//! signalling, and a dropped tick degrades a checklist rather than failing the
//! operation that reported it.
//!
//! Payloads: the small event-only DTOs live here next to their names. Three
//! payloads stay in their domain modules because they are also those modules'
//! function-signature types — [`crate::git::write::lifecycle::CloneProgress`],
//! [`crate::acp::AcpProgress`], and
//! [`crate::git::oauth::types::ProviderOauthProgress`]. All of them are
//! `rename_all = "camelCase"`, mirroring the TS payload types.

use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// A repository's worktree or git state changed on disk (filesystem watcher).
pub const REPO_CHANGED: &str = "repo-changed";
/// A PTY session produced output.
pub const PTY_DATA: &str = "pty-data";
/// A PTY session's shell exited.
pub const PTY_EXIT: &str = "pty-exit";
/// A clone advanced to the next phase / percentage.
pub const CLONE_PROGRESS: &str = "clone-progress";
/// An ACP agent turn reported what it is doing.
pub const ACP_PROGRESS: &str = "acp-progress";
/// A branch hand-off between worktrees advanced a step.
pub const HANDOFF_PROGRESS: &str = "handoff-progress";
/// A branch+worktree delete advanced a step.
pub const DELETE_WORKTREE_PROGRESS: &str = "delete-worktree-progress";
/// An in-app `gh auth login` advanced a step.
pub const GITHUB_SIGNIN_PROGRESS: &str = "github-signin-progress";
/// A native provider OAuth sign-in advanced a step.
pub const PROVIDER_OAUTH_PROGRESS: &str = "provider-oauth-progress";

/// Every name above, for the parity tests below. Keep in step with the
/// constants — `all_matches_the_declared_constants` fails if it drifts.
#[cfg(test)]
pub(crate) const ALL: &[&str] = &[
    REPO_CHANGED,
    PTY_DATA,
    PTY_EXIT,
    CLONE_PROGRESS,
    ACP_PROGRESS,
    HANDOFF_PROGRESS,
    DELETE_WORKTREE_PROGRESS,
    GITHUB_SIGNIN_PROGRESS,
    PROVIDER_OAUTH_PROGRESS,
];

/// Publish `payload` to the webview under a declared event `name`.
///
/// The result is intentionally discarded: every event here is advisory, and a
/// webview that has gone away must not fail the git operation reporting to it.
pub(crate) fn emit<P: Serialize + Clone>(app: &AppHandle, name: &str, payload: P) {
    let _ = app.emit(name, payload);
}

/// [`REPO_CHANGED`] payload: what changed, and which open path it belongs to
/// (`summary.path`) so the frontend can route it to the matching tab.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepoChangedEvent {
    pub(crate) kind: crate::watcher::ChangeKind,
    pub(crate) path: String,
}

/// [`PTY_DATA`] payload: raw bytes read from the session's master side.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PtyDataEvent {
    pub(crate) session_id: u64,
    pub(crate) data: Vec<u8>,
}

/// [`PTY_EXIT`] payload: the session whose shell exited.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PtyExitEvent {
    pub(crate) session_id: u64,
}

/// [`HANDOFF_PROGRESS`] payload — one per phase as it begins, so the hand-off
/// dialog can tick its step checklist live. `step` is one of the ids documented
/// on [`crate::git::write::worktrees::move_branch_to_worktree`].
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HandoffProgressEvent {
    pub step: String,
}

/// [`DELETE_WORKTREE_PROGRESS`] payload — one per phase as it begins. `step` is
/// one of the ids documented on
/// [`crate::git::write::worktrees::delete_branch_with_worktree`].
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteWorktreeProgressEvent {
    pub step: String,
}

/// [`GITHUB_SIGNIN_PROGRESS`] payload. `code`/`url` are present only on the
/// initial `"code"` step.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SignInProgress {
    /// `"code"` | `"browser"` | `"authorized"`.
    pub(crate) step: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) url: Option<String>,
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::fs;
    use std::path::{Path, PathBuf};

    fn manifest_dir() -> &'static Path {
        Path::new(env!("CARGO_MANIFEST_DIR"))
    }

    fn read(path: PathBuf) -> String {
        fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
    }

    /// `(identifier, event name)` for every `pub const NAME: &str = "…";` in
    /// this file — the declarations [`super::ALL`] is supposed to mirror.
    fn rust_event_consts() -> Vec<(String, String)> {
        let mut out = Vec::new();
        for line in read(manifest_dir().join("src/events.rs")).lines() {
            let Some(rest) = line.strip_prefix("pub const ") else {
                continue;
            };
            let Some((ident, value)) = rest.split_once(": &str = ") else {
                continue;
            };
            let Some(name) = value
                .strip_suffix(';')
                .and_then(|v| v.strip_prefix('"'))
                .and_then(|v| v.strip_suffix('"'))
            else {
                continue;
            };
            out.push((ident.to_string(), name.to_string()));
        }
        out
    }

    /// The event names `src/lib/api/events.ts` declares, per the parse contract
    /// documented at the top of that file: one line of exactly
    /// `export const SCREAMING_SNAKE = "the-event-name";`. Everything else the
    /// module exports (payload schemas, `listenTyped`) has a non-ALL-CAPS
    /// identifier and is skipped.
    fn ts_event_names() -> Vec<String> {
        let mut out = Vec::new();
        for line in read(manifest_dir().join("../src/lib/api/events.ts")).lines() {
            let Some(rest) = line.strip_prefix("export const ") else {
                continue;
            };
            let Some((ident, value)) = rest.split_once(" = ") else {
                continue;
            };
            let screaming = ident.starts_with(|c: char| c.is_ascii_uppercase())
                && ident
                    .bytes()
                    .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == b'_');
            if !screaming {
                continue;
            }
            let Some(name) = value
                .strip_suffix(';')
                .and_then(|v| v.strip_prefix('"'))
                .and_then(|v| v.strip_suffix('"'))
            else {
                panic!("{ident} must be one line of `export const {ident} = \"…\";`");
            };
            out.push(name.to_string());
        }
        out
    }

    fn unique(names: &[String], side: &str) -> BTreeSet<String> {
        let set: BTreeSet<String> = names.iter().cloned().collect();
        assert_eq!(set.len(), names.len(), "duplicate event names in {side}");
        set
    }

    fn all_names() -> BTreeSet<String> {
        let names: Vec<String> = super::ALL.iter().map(|s| (*s).to_string()).collect();
        unique(&names, "events::ALL")
    }

    #[test]
    fn all_matches_the_declared_constants() {
        let declared: Vec<String> = rust_event_consts().into_iter().map(|(_, v)| v).collect();
        assert!(
            !declared.is_empty(),
            "parsed no `pub const` — parser broken?"
        );
        assert_eq!(
            unique(&declared, "events.rs"),
            all_names(),
            "events::ALL drifted from the constants above it",
        );
    }

    /// The guard this module exists for: an event name is a plain string on
    /// both sides of IPC, so renaming one side alone compiles, passes every
    /// other test, and silently stops delivering at runtime.
    #[test]
    fn event_names_match_the_typescript_declarations() {
        let ts = ts_event_names();
        assert!(
            !ts.is_empty(),
            "found no event names in src/lib/api/events.ts — parser broken, or \
             the file stopped following its documented parse contract",
        );
        let ts = unique(&ts, "src/lib/api/events.ts");
        let rust = all_names();
        let missing_in_ts: Vec<_> = rust.difference(&ts).collect();
        assert!(
            missing_in_ts.is_empty(),
            "emitted by Rust, not declared in src/lib/api/events.ts: {missing_in_ts:?}",
        );
        let missing_in_rust: Vec<_> = ts.difference(&rust).collect();
        assert!(
            missing_in_rust.is_empty(),
            "declared in src/lib/api/events.ts, not in events.rs: {missing_in_rust:?}",
        );
    }

    /// A constant nothing emits is a name the frontend listens to forever in
    /// silence — the same drift, one step earlier.
    ///
    /// Textual, and so it also pins the house call style: every emit site
    /// names the constant path-qualified as `crate::events::NAME` (they all do
    /// today). Importing a name and passing it bare would fail here — fix the
    /// call site rather than this test, so the emit sites stay greppable.
    #[test]
    fn every_declared_event_is_emitted() {
        let mut sources = String::new();
        let mut pending = vec![manifest_dir().join("src")];
        while let Some(dir) = pending.pop() {
            for entry in fs::read_dir(&dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    pending.push(path);
                } else if path.extension().is_some_and(|e| e == "rs")
                    && path != manifest_dir().join("src/events.rs")
                {
                    sources.push_str(&read(path));
                }
            }
        }
        let unused: Vec<String> = rust_event_consts()
            .into_iter()
            .map(|(ident, _)| ident)
            .filter(|ident| !sources.contains(&format!("crate::events::{ident}")))
            .collect();
        assert!(
            unused.is_empty(),
            "declared but never passed to events::emit: {unused:?}",
        );
    }
}
