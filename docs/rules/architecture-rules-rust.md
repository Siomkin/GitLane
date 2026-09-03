# Architecture Rules — Rust core (`src-tauri/`)

Backend-specific rules. Read [architecture-rules.md](architecture-rules.md) first — the
**IPC contract** (Rule 1) and the **read/write/`gh` split** (Rule 2) are the cross-cutting
contract that governs every command and are not repeated here.

---

## 1. Engine specifics — how each side of the split is implemented

- **All shelling-out goes through the `run_git` / `run_git_env` / `run_gh` / `run_glab` /
  `run_origin` helpers** (`write/cli.rs`, `forge/cli.rs`, provider command modules) — never
  `Command::new("git")` ad hoc. `run_gh` is the only place under `git/forge/` that
  constructs a `gh` subprocess, and `origin/command.rs` is the only place that constructs an
  `origin` subprocess. Tauri forge commands
  enter through `forge::context()`, which selects the provider by detected forge and returns
  the authorised context to call it with; do not call `prs`,
  `threads`, `diff`, or `cli` directly from the command layer. They already set the augmented `PATH`
  (`crate::shell::path()`) that macOS GUI apps need to find a Homebrew `git`/`gh` and its
  credential/signing helpers.
- **Provider CLI output is hard-bounded while it is read.** `gh`, `glab`, and `origin` use
  `forge/bounded_output.rs` to drain stdout and stderr concurrently (a sequential
  drain can deadlock on a full pipe), with 4 MiB stdout for ordinary JSON/mutations,
  32 MiB for diffs, and 1 MiB stderr. Do not replace this with unbounded
  `Command::output` or a size check performed after capture. Teardown owns only the
  direct child; process-tree management is out of scope, so a descendant that inherits
  a pipe can delay EOF after that child exits.
- **The two streams overflow differently, on purpose.** stdout is the payload a parser
  consumes, so overflow (or any reader failure) kills and reaps the child and discards
  all partial output — a truncated body must never reach a caller. stderr is diagnostics
  that success discards outright, so overflow keeps the bounded prefix and lets the child
  finish: a verbose-but-successful CLI (`GH_DEBUG=api` alone can pass 1 MiB) must not fail
  an operation whose stdout arrived complete. Excess past `STDERR_DRAIN_CEILING` is a
  runaway and escalates to the stdout behaviour. A truncated stderr that reaches a failure
  message is disclosed (`stderr_truncated_notice`), never silently clipped.
- **Provider CLI success returns stdout only, untrimmed.** On a non-zero exit, concatenate
  stdout then stderr and trim the combined text before returning the error, so existing
  provider parsing and user-facing error copy remain unchanged.
- **One subprocess per logical operation when git supports it** (e.g. `cherry-pick A B C`),
  not a client-side loop — git stops cleanly on the first conflict instead of leaving a
  half-applied mess. Guard empty inputs (`return Err("no commits…")`).
- **libgit2 reads** stay in-process. Summary/status/diff reads remain synchronous;
  `commit_graph` is **async + `blocking()`** because large histories are measurably
  expensive. Open the repository inside the worker closure.
- **Read facades stay stable.** `read.rs`, `status.rs`, `conflicts.rs` and
  `graph.rs` are public facades for IPC callers: put implementation details in their
  focused sibling folders (`read/`, `status/`, `conflicts/`, `graph/`) and re-export
  only the command-facing functions. **`write.rs` is not one of them (GL-356)** — it
  declares modules only, and callers name the owning module
  (`git::write::branches::create_branch`); a re-export list there only hid which module
  owned a function. Keep a module `mod` rather than `pub mod` when nothing outside the
  layer calls it.
- **Integration tests follow the same split.** Prefer `write/tests/{domain}.rs`
  (with shared fixtures in `write/tests/support.rs`) over a single monolithic
  `write/tests.rs`. Co-locate small pure-unit tests in `#[cfg(test)] mod tests`
  inside the production module when they do not need sibling modules or
  `write/tests/support.rs`.
- **History-changing writes carry their subject — no HEAD-implicit mutations.** Frontend
  state is only a snapshot, so every IPC command that moves a branch tip or rewrites
  history (merge, rebase, reset, fast-forward, cherry-pick, revert, commit, squash, stash
  apply/pop, push/pull/publish/force-push) takes the **branch and oid the user acted on**
  and validates them against live Git state before mutating (`write/head.rs`:
  `ensure_expected_head` / `ensure_expected_branch_tip` / `ensure_revision_at` /
  `checkout_expected_branch`). Fail closed with "…changed. Refresh and try again." when
  they no longer match — never fall back to "whatever HEAD is now" (that caused a rebase
  onto the previously active branch). Operations that span a slow step re-validate after
  it (`pull_branch` re-checks HEAD after the network fetch); plain ref moves use git's own
  compare-and-swap (`update-ref <ref> <new> <old>`) so a concurrent move loses cleanly.
  The precondition and the mutation are still separate processes — a microsecond
  external-tool race remains by design; do not present these guards as a lock. **When
  adding a write command, follow this contract**: explicit subject + expected oid in the
  signature, guards first, and no new command that mutates an implicit HEAD.

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
  (the `spawn_blocking` helper in `commands/mod.rs`). In-process libgit2 reads stay plain sync
  commands unless profiling proves they can exceed the UI latency budget; `commit_graph`
  is the existing exception. **Adding a write/`gh` command as a sync command is a bug**,
  not a style nit.

---

## 4. Errors, secrets, and docs

- **Every command rejects with `CommandError`** (`git/types/error.rs`; `ipc/commands`
  spec). Commands are `Result<T, CommandError>`, produced only by the `commands::blocking`
  / `commands::sync` adapters, which convert the impl's error (`String` diagnostics,
  `git2::Error`, `GithubError`, `HttpError`, `SecretError`, `CaptureError`) into the
  boundary type and **redact it once** — no command bypasses either step, and a test in
  `commands/mod.rs` fails any `Result<_, String>` command signature. Classification lives
  in Rust next to the failure: `git/write/classify.rs` turns a `git` diagnostic into
  `kind` (`git`, `hookRejected`, `auth`, `network`, `staleLease`, `indexLock`, `conflict`,
  `notARepository`, `missingPath`, `forge`, `internal`) plus a `code` / `hook`, and the
  `From` impls in `git/types/error.rs` map the typed enums by variant. The frontend never
  pattern-matches error text to decide a category — it only formats copy from `kind`.
  Impl functions keep returning `String` (readable, actionable — match the bar set by the
  `gh`-not-found message in `forge/cli.rs`) or their typed enum; a new user-visible
  category is a new `CommandErrorKind` + classifier rule + Rust test, not a new regex in JS.
- **Secrets are never returned or stored by IPC.** GitHub PR/API commands accept a
  frontend-safe account ref (`provider`, `host`, `accountId`, `login`), never a token. Git
  transport commands accept `GitTransportAuthRef`, which carries URL username/helper metadata
  only. The explicit HTTPS credential setup command is the only command that may receive a
  token/password from JS, and it must pass that value directly to `git credential approve`
  without logging or persisting it. The `GithubProvider` adapters resolve PR/API tokens
  server-side immediately before use and hand them to subprocesses via env (`GH_TOKEN`).
  **Do not add a command that returns a token to JS.**
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

## 6. Splitting an oversized module (GL-341)

A module that outgrows one file becomes a **facade plus focused submodules** —
`foo.rs` keeps the module doc, the shared types, and the public entry points;
`foo/` holds the rest. `read`, `status`, `graph`, `conflicts`, `worktree_fs`,
`types`, `write/discard_all`, `write/lifecycle` and `acp/session` all follow this
shape.

**"Outgrows" has a number.** Counting a file's production half and its inline
test module separately — the split is the `mod tests` that follows the
`#[cfg(test)]`, not the attribute itself, since plenty of production code carries
a test-only `use` or helper long before its tests:

| Lines | Status |
|-------|--------|
| ≤ 250 | Fine. |
| 251–400 | **Look.** Name the pieces in the PR description, or split. |
| > 400 | **Does not merge** — facade + `foo/`, no "one axis of change" defence. |

A `mod tests` block over ~150 lines splits too, into `foo/tests/{domain}.rs`
with shared fixtures in `foo/tests/support.rs` (§1). Small pure-unit tests stay
co-located — that co-location is the rule, not a lapse, because a child `mod
tests` can reach the module's private items without widening anything.

Both halves earn their place: `acp/session.rs` hit 1414 lines (593 production,
820 tests) while every function in it was individually defensible, which is
precisely why responsibility alone is not a sufficient gate.

Three rules, each learned by getting it wrong first:

- **Shared data types stay in the facade.** A parent module's private items —
  fields included — are visible to its children, so types every submodule reads
  belong in `foo.rs`, where they need no widening at all. Move them into a
  submodule and you must annotate every field `pub(super)` for the siblings, which
  is a much larger diff for no benefit. The corollary: a child's items *do* need
  `pub(super)` for the parent and siblings to reach them, so the visibility
  pressure runs upward only. Add `pub(super)` where the compiler demands it, never
  pre-emptively.
- **`cargo check` does not compile `#[cfg(test)]` code.** A `mod tests { use
  super::*; }` that stops resolving, or a test hook a sibling suite reaches through
  the module path, stays invisible until `cargo clippy --all-targets`. Both have
  happened. Gate on `--all-targets`, not `check`.
- **`cargo doc --no-deps` does not check intra-doc links on private items.** Moving
  a declaration one level down silently changes what `super::` means in its doc
  links and in any fully-qualified call it makes; a private-to-private link then
  dangles with zero warnings. Use `cargo doc --no-deps --document-private-items`
  and compare the unresolved-link count against the base branch — the tree carries
  a standing set of pre-existing ones, so the check is "no new links", not "none".

A split is only worth trusting if it is provably a pure move: compare the old file
against the new set line-by-line, sorted, with imports, `mod` lines, comments and
visibility keywords normalised away. Everything that survives should be explainable
in one sentence. If it isn't, that is the bug.

---

## Anti-patterns (Rust)

- ❌ A sync Tauri command that shells out (freezes the UI).
- ❌ Reimplementing a write with libgit2, or spawning `git`/`gh` outside the `run_*` helpers.
- ❌ Caching/threading a `git2::Repository` across calls.
- ❌ Returning, logging, storing, or surfacing a token or any secret across the IPC boundary.
  The HTTPS credential-save command is the exception: it may receive a user-entered secret only
  long enough to pass it to `git credential approve`.
- ❌ Layout/positioning math pushed to the frontend instead of `graph.rs`.
- ❌ A `#[tauri::command]` fn with no `generate_handler!` entry.
