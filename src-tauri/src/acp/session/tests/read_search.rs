//! Unattended `read` / `search` approvals: decided by the paths the adapter
//! reports, never by the kind. Payload shapes follow what Claude
//! (`rawInput.file_path` + `locations`), Codex (`locations` only) and Cursor
//! (`rawInput.path` + `locations`) report for their read and search tool calls.

use super::support::*;
use std::path::Path;

/// A throwaway repository with one tracked-looking file, a subdirectory, a
/// `.git` holding a config, and a sibling directory outside it.
struct Fixture {
    base: PathBuf,
    repo: PathBuf,
    outside: PathBuf,
}

impl Fixture {
    fn new(tag: &str) -> Self {
        let base = std::env::temp_dir().join(format!(
            "gitlane-acp-read-search-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&base);
        let repo = base.join("repo");
        let outside = base.join("outside");
        std::fs::create_dir_all(repo.join("src")).unwrap();
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(repo.join("README.md"), "# demo\n").unwrap();
        std::fs::write(repo.join("src/app.rs"), "// TODO\n").unwrap();
        std::fs::write(repo.join(".git/config"), "[core]\n").unwrap();
        std::fs::write(outside.join("secret.txt"), "secret\n").unwrap();
        Self {
            base,
            repo,
            outside,
        }
    }

    fn abs(&self, rel: &str) -> String {
        self.repo.join(rel).to_string_lossy().into_owned()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.base);
    }
}

fn decide(kind: &str, tool_call: Value, cwd: &Path) -> String {
    let mut call = tool_call;
    call["toolCallId"] = json!("c1");
    call["kind"] = json!(kind);
    let ask = json!({
        "toolCall": call,
        "options": [
            { "optionId": "reject-once", "kind": "reject_once" },
            { "optionId": "allow-once", "kind": "allow_once" },
        ],
    });
    permission_outcome(Some(&ask), cwd)["outcome"]["optionId"]
        .as_str()
        .unwrap()
        .to_owned()
}

fn allowed(kind: &str, tool_call: Value, cwd: &Path) -> bool {
    decide(kind, tool_call, cwd) == "allow-once"
}

#[test]
fn reads_of_a_file_inside_the_repository_are_allowed_in_every_adapter_shape() {
    let fx = Fixture::new("inside");
    let readme = fx.abs("README.md");
    for call in [
        json!({ "rawInput": { "file_path": readme }, "locations": [{ "path": readme, "line": 1 }] }),
        json!({ "rawInput": null, "locations": [{ "path": readme }] }),
        json!({ "rawInput": { "path": readme }, "locations": [{ "path": readme }] }),
        json!({ "rawInput": { "path": "src/app.rs" } }),
    ] {
        assert!(allowed("read", call.clone(), &fx.repo), "{call}");
    }
}

#[test]
fn searches_inside_the_repository_are_allowed() {
    let fx = Fixture::new("search");
    for call in [
        // A subdirectory under `directory` or `path`, relative or absolute.
        json!({ "rawInput": { "pattern": "TODO", "directory": "src" } }),
        json!({ "rawInput": { "pattern": "TODO", "path": fx.abs("src") } }),
        // The repository root itself.
        json!({ "rawInput": { "pattern": "TODO", "path": fx.repo.to_string_lossy() } }),
        // Only a search term, or nothing at all (Codex reports neither).
        json!({ "rawInput": { "pattern": "TODO", "output_mode": "content", "-n": true } }),
        // A glob that names no existing path stays inside the repository.
        json!({ "rawInput": { "pattern": "TODO", "glob": "src/**/*.rs" } }),
        json!({ "rawInput": null }),
        json!({}),
    ] {
        assert!(allowed("search", call.clone(), &fx.repo), "{call}");
    }
}

#[test]
fn reads_and_searches_outside_the_repository_are_rejected() {
    let fx = Fixture::new("outside");
    let secret = fx.outside.join("secret.txt").to_string_lossy().into_owned();
    let readme = fx.abs("README.md");
    for kind in ["read", "search"] {
        for call in [
            json!({ "rawInput": { "file_path": "~/.ssh/id_rsa" } }),
            json!({ "rawInput": { "path": "/etc/passwd" } }),
            json!({ "rawInput": { "path": "../outside/secret.txt" } }),
            json!({ "rawInput": { "file_path": secret.clone() }, "locations": [{ "path": secret.clone() }] }),
            // Codex reports only `locations`.
            json!({ "rawInput": null, "locations": [{ "path": secret.clone() }] }),
            // Under a key GitLane has never seen, or nested in an array/object,
            // beside an in-repo path that would otherwise approve it.
            json!({ "rawInput": { "path": readme.clone(), "zzUnfamiliar": "/etc/passwd" } }),
            json!({ "rawInput": { "path": readme.clone(), "extra": [{ "more": ["/etc/passwd"] }] } }),
            // A `..` through a directory that does not exist cannot be resolved.
            json!({ "rawInput": { "path": "src/missing/../../../outside/secret.txt" } }),
            // A path embedded in a longer value, or given as a file URI.
            json!({ "rawInput": { "path": readme.clone(), "command": "cat /etc/passwd" } }),
            json!({ "rawInput": { "path": readme.clone(), "uri": "file:///etc/passwd" } }),
            // NTFS aliases of `.git`.
            json!({ "rawInput": { "path": "GIT~1/config" } }),
        ] {
            assert!(!allowed(kind, call.clone(), &fx.repo), "{kind} {call}");
        }
    }
}

#[test]
fn reads_and_searches_of_repository_metadata_are_rejected() {
    let fx = Fixture::new("metadata");
    for kind in ["read", "search"] {
        for call in [
            json!({ "rawInput": { "path": ".git/config" } }),
            json!({ "rawInput": { "path": ".GIT/hooks/pre-commit" } }),
            json!({ "rawInput": { "path": fx.abs(".git/config") } }),
            json!({ "rawInput": { "pattern": "url", "directory": "src/../.git" } }),
        ] {
            assert!(!allowed(kind, call.clone(), &fx.repo), "{kind} {call}");
        }
    }
}

#[test]
fn a_read_that_names_no_existing_repository_file_is_rejected() {
    let fx = Fixture::new("no-path");
    for call in [
        // Claude's first `tool_call` frame, before its update fills the input.
        json!({ "rawInput": {}, "locations": [] }),
        json!({ "rawInput": null }),
        json!({}),
        json!({ "rawInput": { "path": "src/missing.rs" } }),
        // A directory is not a file to read.
        json!({ "rawInput": { "path": "src" } }),
    ] {
        assert!(!allowed("read", call.clone(), &fx.repo), "{call}");
    }
}

#[cfg(unix)]
#[test]
fn symlinks_leaving_the_repository_or_entering_git_are_rejected() {
    use std::os::unix::fs::symlink;

    let fx = Fixture::new("symlink");
    symlink(fx.outside.join("secret.txt"), fx.repo.join("leaf-link")).unwrap();
    symlink(&fx.outside, fx.repo.join("dir-link")).unwrap();
    symlink(fx.repo.join(".git"), fx.repo.join("meta")).unwrap();
    for kind in ["read", "search"] {
        for call in [
            json!({ "rawInput": { "path": "leaf-link" } }),
            json!({ "rawInput": { "path": "dir-link/secret.txt" } }),
            json!({ "rawInput": { "directory": "dir-link" } }),
            // An absolute path to an in-repo symlink into `.git`.
            json!({ "rawInput": { "path": fx.abs("meta/config") } }),
            json!({ "rawInput": { "path": "meta/config" } }),
            // A glob or missing child under the link resolves through it.
            json!({ "rawInput": { "pattern": "x", "glob": "dir-link/*.txt" } }),
            json!({ "rawInput": { "pattern": "x", "path": "dir-link/missing" } }),
            json!({ "rawInput": { "pattern": "url", "glob": "meta/*" } }),
        ] {
            assert!(!allowed(kind, call.clone(), &fx.repo), "{kind} {call}");
        }
    }
}

#[test]
fn kinds_other_than_think_are_never_approved_on_the_kind_alone() {
    let fx = Fixture::new("kinds");
    assert!(allowed("think", json!({}), &fx.repo));
    for kind in ["fetch", "edit", "delete", "move", "other", "switch_mode"] {
        let call = json!({ "rawInput": { "path": fx.abs("README.md") } });
        assert!(!allowed(kind, call, &fx.repo), "{kind}");
    }
}

#[cfg(windows)]
#[test]
fn a_drive_relative_value_is_resolved_on_its_own_drive() {
    let fx = Fixture::new("drive");
    let call = json!({ "rawInput": { "pattern": "x", "path": "Z:notes" } });
    assert!(!allowed("search", call, &fx.repo));
}
