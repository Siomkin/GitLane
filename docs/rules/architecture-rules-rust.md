# Architecture Rules — Rust core (`src-tauri/`)

Backend-specific rules. Read [architecture-rules.md](architecture-rules.md) first — the
**IPC contract** (Rule 1) and the **read/write/`gh` split** (Rule 2) are the cross-cutting
contract that governs every command and are not repeated here.

---

## 1. Engine specifics — how each side of the split is implemented

- **All shelling-out goes through the `run_git` / `run_git_env` / `run_gh` helpers**
  (`write/cli.rs`, `github/cli.rs`) — never `Command::new("git")` ad hoc. `run_gh` is the
  only place under `git/github/` that constructs a `gh` subprocess. Tauri GitHub commands
  enter through `GithubService`, which dispatches to `GhProvider`; do not call `prs`,
  `threads`, `diff`, or `cli` directly from `lib.rs`. They already set the augmented `PATH`
  (`crate::shell::path()`) that macOS GUI apps need to find a Homebrew `git`/`gh` and its
  credential/signing helpers.
- **Combine stdout+stderr** and return it trimmed: `Ok` on success, `Err` on non-zero exit,
  so the UI can surface git's own message verbatim.
- **One subprocess per logical operation when git supports it** (e.g. `cherry-pick A B C`),
  not a client-side loop — git stops cleanly on the first conflict instead of leaving a
  half-applied mess. Guard empty inputs (`return Err("no commits…")`).
- **libgit2 reads** stay in-process. Summary/status/diff reads remain synchronous;
  `commit_graph` is **async + `blocking()`** because large histories are measurably
  expensive. Open the repository inside the worker closure.
- **Git module facades stay stable.** `read.rs`, `status.rs`, `conflicts.rs`,
  `graph.rs`, and `write.rs` are public facades for IPC callers. Put implementation
  details in their focused sibling folders (`read/`, `status/`, `conflicts/`,
  `graph/`, `write/`) and re-export only the command-facing functions from the facade.

---

## 2. `Repository` is not `Send` — open fresh, every call

`git2::Repository` handles cannot cross the async Tauri command boundary. Every read
function takes a `path: &str` and does **open (`Repository::discover`) → read → drop**.

- Never cache a `Repository`, never store one in Tauri state, never thread one across a
  command. `discover` means opening any subdirectory of a repo works; `open_repo` returns a
  normalized path that all later calls reuse (the store passes `summary.path`, not the raw
  picked path).

---

## 3. Keep subprocesses off the main thread

Synchronous Tauri commands run on the webview's main thread, so a blocking subprocess there
freezes the whole UI (no repaint) until it returns.

- **Every command that shells out is `async fn` and wraps its work in `blocking(move || …)`**
  (the `spawn_blocking` helper in `lib.rs`). In-process libgit2 reads stay plain sync
  commands unless profiling proves they can exceed the UI latency budget; `commit_graph`
  is the existing exception. **Adding a write/`gh` command as a sync command is a bug**,
  not a style nit.

---

## 4. Errors, secrets, and docs

- **Errors are `Result<T, String>` at IPC.** GitHub internals use typed `GithubError`
  categories and map them back to strings at the `git::github` facade. Keep messages readable
  and actionable — match the bar set by the `gh`-not-found message in `github/cli.rs` (it
  names the fix and the install URL). The one deliberate exception is `open_repo`, which
  rejects with a serialized `RepoOpenError` (`kind` + `message` + `path`) so the frontend can
  give a moved/deleted repository its dedicated missing-repo state (GL-108) — don't add
  further structured errors without the same "the frontend must branch on the category" need.
- **Secrets never cross IPC.** GitHub commands accept a frontend-safe account ref
  (`provider`, `host`, `accountId`, `login`), never a token. `GithubService`/`GhProvider`
  resolve tokens server-side immediately before use and hand them to subprocesses via env
  (`GH_TOKEN`). **Do not add a command that returns a token to JS.**
- **Doc comments explain *why*, not *what*.** Module headers use `//!`, functions use `///`.
  Document the non-obvious rationale (the read/write split, the `PATH` workaround, the `Send`
  constraint, "callers should only offer fast-forward when it is one") the way the existing
  modules already do.

## 5. Layout/computation belongs in Rust, painting in JS

- The graph layout algorithm lives behind the `graph.rs` facade, with the actual DAG walk,
  lane assignment, ref labels, and stash injection in `graph/`: it assigns each commit a
  `(row, lane, color)` plus resolved edges. The frontend is a **dumb painter**. **Don't put
  layout logic in the frontend — extend the Rust graph modules.**
- Same principle generally: if a computation can be done once in Rust and shipped as resolved
  data, do it there rather than recomputing per-render in JS.

---

## Anti-patterns (Rust)

- ❌ A sync Tauri command that shells out (freezes the UI).
- ❌ Reimplementing a write with libgit2, or spawning `git`/`gh` outside the `run_*` helpers.
- ❌ Caching/threading a `git2::Repository` across calls.
- ❌ Returning a token or any secret across the IPC boundary.
- ❌ Layout/positioning math pushed to the frontend instead of `graph.rs`.
- ❌ A `#[tauri::command]` fn with no `generate_handler!` entry.
