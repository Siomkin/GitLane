# Architecture Rules

The rules to follow when adding functionality to GitLane, so the codebase stays
consistent and avoids architecture drift. `CLAUDE.md` explains *how the system is
shaped*; these rules are the *checklist you apply while coding*.

This file holds the **cross-cutting contract both processes must honor**. The
side-specific rules live in two siblings — read the one(s) your change touches:

- **[architecture-rules-rust.md](architecture-rules-rust.md)** — the Rust core
  (`src-tauri/`): commands, the read/write/`gh` engines, threading, errors, secrets.
- **[architecture-rules-react.md](architecture-rules-react.md)** — the React frontend
  (`src/`): Zustand stores, components, styling, and **SOLID / module decomposition**.

> **Golden rule:** every change must look like it was written by the person who wrote
> the surrounding code. Match the existing module's structure, naming, comment density,
> and error style before you add anything new. When in doubt, copy the nearest existing
> example rather than inventing a new pattern.

---

## 1. The IPC contract is sacred — change all four layers together

Adding or changing a command means editing **all four**, in this order, and verifying
they agree:

1. **Impl** — the real work in the right module under `src-tauri/src/git/`
   (`read.rs` + `read/`, `status.rs` + `status/`, `conflicts.rs` + `conflicts/`,
   and `graph.rs` + `graph/` for reads; `write/` for real-`git` operations; the
   `forge/` directory for the providers). A module that outgrows one file becomes a
   facade over focused submodules rather than a longer file — see GL-341. These expose free functions that take a
   `path: &str` and return `Result<_, String>` or `Result<_, git2::Error>`; the command
   layer converts either into the one IPC error type, `CommandError` (`kind` + `message`
   + optional `code`/`detail`/`hook`/`path`) — see architecture-rules-rust.md §4 and the
   `ipc/commands` spec. Impl functions never build a `CommandError` themselves.

   **The write layer has no re-export facade (GL-356).** Callers name the owner —
   `git::write::branches::create_branch`, not `git::write::create_branch`. Still four
   edits, not five — see architecture-rules-rust.md §1.
2. **Command + registration** — the `pub` `#[tauri::command]` fn in its domain module
   under `src-tauri/src/commands/` (GL-360) **and** its path-qualified line in
   `src-tauri/src/lib.rs`'s `tauri::generate_handler![…]`. Forgetting the handler entry
   is the #1 "command not found" bug.
3. **Types** — `src-tauri/src/git/types.rs`: any struct returned to the frontend, with
   `#[derive(Debug, Clone, Serialize)]` + `#[serde(rename_all = "camelCase")]`. IPC input
   structs also derive `Deserialize` and use the same casing. The declarations live in
   per-domain modules under `types/` (`graph`, `repo`, `refs`, `worktree`, `status`,
   `diff`, `files`, `preview`, `conflicts`, `auth`, `forge`) and are re-exported flat from
   the facade, so callers always write `crate::git::types::Foo` (GL-341).
4. **TS wrapper + interface** — `src/lib/api/`: a typed
   `invoke<T>("command_name", { … })` wrapper on the matching `*Api` object, plus the
   `interface` mirroring the Rust struct. The git half mirrors the backend's own shape
   (GL-341): `git.ts` is a facade over `git/types.ts` (itself a facade over per-domain
   modules under `git/types/`, mirroring the Rust `git/types/` split) and one wrapper
   module per **owning command module** — `git/<name>.ts` wraps exactly the commands
   declared in `commands/<name>.rs`. `github.ts`, `providers.ts`, `terminal.ts`, and
   `updater.ts` are still flat. The `registration_tests` guard in `commands/mod.rs`
   walks `src/lib/api/` recursively, so a wrapper in a subdirectory is still checked.

**Rules:**
- Rust params are `snake_case`; the JS call passes `camelCase`; Tauri converts. The
  `api/*.ts` wrapper is the **only** place that mapping is spelled out (e.g. `authorName`
  → `{ name: authorName }`), never elsewhere.
- A new TS interface field **must** have a matching `serde` field, and vice versa. Nothing
  but you checks this — keep them in lockstep.
- Never call `invoke()` from a component. Always go through an `api/*.ts` wrapper.

---

## 2. Read/write split — pick the right engine, never mix

The central design decision. Before writing a backend function, decide which it is:

| Operation | Engine | Module | Sync/async |
|-----------|--------|--------|-----------|
| Read repo state (summary, branches, status, diffs, conflicts) | **libgit2** (`git2`) | `read.rs` + `read/`, `status.rs` + `status/`, `conflicts.rs` + `conflicts/` | **sync** command |
| Build the potentially large commit graph | **libgit2** (`git2`) | `graph.rs` + `graph/` | **async** + `blocking()` |
| Mutate the repo (checkout, branch, merge, rebase, reset, stage, commit, stash, pull, push) | **shell out to `git`** | `write/<module>.rs` | **async** + `blocking()` |
| Forge accounts / PRs / checks | **`forge::context()` → `GithubProvider` → provider CLI/REST** | `forge/` | **async** + `blocking()` |

The split is "can libgit2 do it?", not literally "read vs write". A few **read-shaped**
commands still shell out to `git` because libgit2 doesn't cover them well — `list_worktrees`
and `list_stashes` live in the write layer (`write/worktrees.rs` and
`write/stashes.rs`) and are therefore `async` + `blocking()`, returning structs like
any read. The engine dictates sync-vs-async, not the read/write label.

- **Do not reimplement write operations with libgit2.** The CLI honours hooks, credential
  helpers, `.gitconfig`, signing, and conflict machinery; libgit2 reimplements those only
  partially. `git2` is built `default-features = false` — clone/fetch/push aren't even
  available there.
- Most reads remain synchronous. `commit_graph` is the measured exception: it opens the
  non-`Send` repository inside `blocking()` so ref collection/revwalk/layout cannot freeze
  the webview on large histories.
- Reads return rich serializable structs; writes return the raw combined stdout/stderr
  `String` so the UI can surface git's own message verbatim.
- Forge PR/API commands must enter through `forge::context()`, which resolves the provider
  and the authorised `GithubContext` in one step; the command then calls the returned
  `GithubProvider` directly. The optional account argument is
  a frontend-safe account ref (`provider`, `host`, `accountId`, `login`), never a token. The
  provider resolves tokens immediately before use and validates repository/account host
  compatibility before PR operations.
- Git transport auth (clone/fetch/pull/push/tag/delete-remote) uses `GitTransportAuthRef`,
  never provider tokens. GitHub may inject `gh auth git-credential`; GitLab/Bitbucket/Azure/
  Cursor Origin and other HTTPS remotes use URL usernames plus the user's configured git
  credential helper / GCM. SSH remotes use SSH keys. Never inject `gh` credentials for an
  Origin remote.
- The explicit HTTPS credential setup flow may receive a token/password once and must pass it
  directly to `git credential approve`. GitLane must not persist it in app state, localStorage,
  logs, or command errors.
- Use `git/forge.rs` for remote forge detection. Do not infer Bitbucket/GitLab/Azure/Gitea
  support from the GitHub provider boundary; unsupported forges should fail explicitly until
  their own provider contract is implemented. Cursor Origin is implemented by `OriginProvider`:
  all subprocesses cross the single `run_origin` boundary, structured reads use documented
  `origin api` JSON, and credentials stay in the Origin CLI session.
- Non-GitHub provider auth status lives in `auth_providers.rs` and Settings only. It must not
  return tokens; each forge needs its own provider implementation before it appears in PR
  workflows. Basic git transport auth still works through Git's credential helpers.

### Tauri plugin allowlist

Native platform dependencies are governed by
[`docs/tauri-plugin-decisions.md`](../tauri-plugin-decisions.md). Before adding or changing a
Tauri plugin, JS package, capability permission, CSP/config entry, or frontend plugin API call,
check that decision record and update it in the same change. It is the single detailed source
for installed plugins, avoided `shell`/broad `fs` access, non-secret Store use, and deferred
native secret storage.

The how (the `run_git`/`run_gh` helpers, threading, `Repository`-is-not-`Send`) is in
[architecture-rules-rust.md](architecture-rules-rust.md).

---

## 3. Definition of done — run before every commit

A change isn't finished until:

```bash
bunx tsc --noEmit                 # frontend typechecks
bun run lint                      # eslint: the load-bearing import boundaries (GL-58)
(cd src-tauri && cargo check)     # Rust compiles (cargo build for a real binary)
(cd src-tauri && cargo fmt --all -- --check)
(cd src-tauri && cargo clippy --all-targets --all-features -- -D warnings)
bun run build                     # tsc --noEmit + vite build passes
bun run test                      # vitest: node + dom projects
(cd src-tauri && cargo test)      # the Rust suite
bun run sizes                     # §4a ratchet: no *new* file over 400 (1 200 for tests), none grown
```

- **`bun run lint` mechanically enforces the Tier-1 import invariants** — raw
  `invoke()` only in `src/lib/api/*` (Rule 1), the `api` object confined to stores /
  `lib/api` / documented session-or-probe boundaries, and `components/ui/*` purity
  (architecture-rules-react.md §2). The rules are encoded in `eslint.config.js`; CI
  runs it in the frontend job. A legitimate boundary exception is an explicit
  `// eslint-disable-next-line no-restricted-imports -- <reason>` at the import, never
  a silent one.

- For an IPC change, re-verify all four layers of Rule 1 agree (Rust fn ↔ handler entry ↔
  types ↔ TS wrapper/interface).
- **The typechecks do not catch IPC wiring.** The command name is a string on both sides,
  so a forgotten `generate_handler!` entry or a name mismatch between `invoke("…")` and the
  Rust fn compiles clean and fails only at runtime. After any IPC change, **launch the app
  (`bun run tauri dev`) and actually exercise the new command** — green typechecks alone
  don't prove the wire is connected.
- The suite covers a lot but **cannot prove the wire is connected end to end**. Three
  source-text audits in `commands/registration_tests` do catch the common wiring slips —
  a command missing from `generate_handler!`, an `invoke("…")` naming a command that does
  not exist, a parameter renamed on one side only (`argument_names.rs`), and a command
  declared sync that should be async. A fourth (`runtime.rs`) invokes the state-bound
  commands over `tauri::test`'s mock IPC, but only a subset: 22 commands take
  `tauri::AppHandle` (= `AppHandle<Wry>`), which does not satisfy
  `CommandArg<MockRuntime>`, so the real handler list cannot boot against the mock
  runtime without making the command layer generic over `R`. Anything those audits miss
  still fails at runtime, so the in-app check above stands.

### CI platform coverage

- **Linux is the gate; macOS is advisory.** `frontend` and `rust-tests` run on the
  always-on self-hosted Linux runners and must pass. `frontend-macos` and
  `rust-tests-macos` run the same suites on `[self-hosted, macOS, ARM64]` so the
  `#[cfg(target_os = "macos")]` code (the `lib.rs` menu, `shell.rs`'s opener, the
  apple-native keyring) executes somewhere — GitLane's primary platform had no CI at all
  before.
- **They are `continue-on-error: true` on purpose, and that has a cost.** Those macOS
  runners are started by hand on a developer Mac (release runbook, `CLAUDE.local.md`), so
  the label is offline most of the time. While it is offline these two checks sit
  *pending* on a pull request rather than reporting; they are not required checks, so a
  merge is never blocked, but the PR page will show them unresolved. The alternative
  considered was GitHub-hosted `macos-14` as a required job, which is always available but
  bills macOS minutes at 10x on a private repository for a full Rust + Tauri build.
- **A green Linux run does not mean macOS passed.** Before a release, start a Mac runner
  and confirm both macOS jobs actually ran.
- The macOS jobs are gated on `changes.outputs.trusted`, not on `runner`: that box has no
  GitHub-hosted fallback, so it must never be offered contributor-controlled code.
- Commits are GPG-signed with the repo's pinned identity (see `CLAUDE.local.md`). When a
  Jira issue exists, reference the key (`GL-xx`) in the branch, commit message, and PR title.
- Commit messages and PR titles use short human summaries. With a Jira issue, put the key
  first: `GL-32 Persist graph and commit column widths per repository` or
  `GL-32 fix(graph): Persist graph width per repository`. Without one, omit the key.
  The same typed style is allowed when useful, e.g. `docs(rules): Document commit and PR
  title style`.
- For non-trivial changes, include a commit body / PR description that explains what changed,
  why, and how it was validated, matching the practical style of the surrounding history.

---

## 4. Anti-patterns — do not do these

**Cross-process / Rust**
- ❌ `invoke()` inside a React component, or `fetch`/git logic in a component.
- ❌ Reimplementing a write with libgit2, or spawning `git`/`gh` outside the `run_*` helpers.
- ❌ Calling `gh` module internals directly from Tauri commands, or calling a `GithubProvider`
  method with a `GithubContext` that did not come from `forge::context()`.
- ❌ A sync Tauri command that shells out (freezes the UI).
- ❌ Caching/threading a `git2::Repository` across calls.
- ❌ Returning, logging, storing, or surfacing a token (or any secret) across the IPC boundary.
  The explicit HTTPS credential-save command may receive a user-entered token/password only to
  pipe it directly into `git credential approve`.
- ❌ Adding a TS interface field with no matching `serde` field (or vice versa).
- ❌ Layout/positioning math in the frontend instead of `graph.rs`.

**Frontend**
- ❌ Cross-store reactive subscriptions; dumping unrelated state into a store.
- ❌ Domain-aware components under `components/ui/`; hardcoded colors instead of tokens/`cn()`.
- ❌ Landing a file over the size ceiling (architecture-rules-react.md §4a / -rust.md §6),
  whatever the "it's one concern" argument — but equally ❌ chopping one at the line number
  instead of at a seam, or extracting a one-off into a "reusable" abstraction.
- ❌ A container that holds its own rows, its own hook, and its own mapping helpers instead of
  a folder module (`rows/` + `use*.ts` + `*Model.ts` + `index.ts`).

**Always**
- ❌ Committing without `tsc --noEmit` + `cargo check` green (and an in-app check for IPC changes).
