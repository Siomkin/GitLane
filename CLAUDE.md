# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

GitLane is a Tauri 2 desktop git client for macOS, Windows, and Linux: a swimlane-style visual commit
tree with drag-and-drop branch operations, working-tree staging/commit, stash and
worktree management, and pull-request browsing for GitHub, GitLab, Bitbucket, and Cursor Origin.
Rust core + React/TypeScript frontend.

## Commands

The package manager is **bun** (note `bun.lock`; `src-tauri/tauri.conf.json` runs `bun run dev`/`bun run build`). Don't use npm/yarn. GitLane requires **Git 2.36.0 or newer**; the write layer checks this before invoking Git.

```bash
bun install
bun run tauri dev            # launch the app; first run does a full Rust build (~1 min)
bun run build               # frontend only: tsc --noEmit + vite build
bun run dev                 # vite dev server alone — Rust invoke() commands WON'T work here
bunx tsc --noEmit           # typecheck frontend
(cd src-tauri && cargo check)   # fast Rust verify
(cd src-tauri && cargo fmt --all -- --check) # verify Rust formatting
(cd src-tauri && cargo clippy --all-targets --all-features -- -D warnings)
(cd src-tauri && cargo build)   # build the Rust binary
bun run test                # frontend unit/render tests (vitest; node + happy-dom projects)
bun run test:watch          # vitest in watch mode
bun run sizes               # file-size ceiling (react §4a / rust §6), ratcheted against a baseline
```

The repository pins Rust (including `rustfmt` and Clippy) in
`rust-toolchain.toml`; local Cargo commands and CI must use that toolchain.

Releases are tag-driven — push `vX.Y.Z` for a stable release or `vX.Y.Z-beta.N`
for the beta channel; see [`docs/release-channels.md`](docs/release-channels.md).

GitHub / PR features require `gh` **2.95.0 or newer**. The backend checks a
non-secret capability baseline before GitHub operations: `gh version`,
`gh auth status --json hosts`, `gh auth token --hostname <host> --user <login>`,
`gh pr diff --patch --color never`, and `gh api graphql`.
Cursor Origin PR features use the user's signed-in `origin` CLI session and require
`pr diff --patch`, `api`, and `pr thread` support.

The frontend test harness is **vitest + Testing Library**, split into two Vitest projects:
`node` for pure-logic `*.test.ts` files and `dom` (running **happy-dom**, ≈4× cheaper than
jsdom) for `*.test.tsx` plus an allowlist of DOM-needing `.test.ts` files (see
[`src/test/README.md`](src/test/README.md); a file needing jsdom fidelity opts out with a
`// @vitest-environment jsdom` docblock). Tests live
next to the code as `*.test.ts`/`*.test.tsx`; `src/test/setup.ts` wires jest-dom matchers +
RTL cleanup for the dom project (`setup.node.ts` covers node),
and the IPC boundary (`@tauri-apps/api/core`'s `invoke`) is mocked **inline per test file**
with the canonical `vi.hoisted` + `vi.mock` pattern — see [`src/test/README.md`](src/test/README.md).
Coverage is still partial — typechecks remain the primary safety net.

## Planning (OpenSpec)

Spec-driven planning lives in this repo: [`openspec/`](openspec/) plus
[`openspec/config.yaml`](openspec/config.yaml) (stack, conventions, nested
`area/capability` spec paths). This checkout is OpenSpec store `gitlane`
(`.openspec-store/store.yaml`). From GitLaneProject, pass `--store gitlane`;
inside this folder the nearest `openspec/` wins. Landing is `--store landing`
(referenced read-only). Do not create `openspec/` on the workspace parent.
Invocations: Cursor `/opsx-propose`, Claude Code `/opsx:propose`, Codex
`$openspec-propose` (also explore / apply / update / sync / archive). Cursor
adapters are generated locally and ignored. Claude commands are tracked in
[`.claude/commands/opsx/`](.claude/commands/opsx/); shared skills in
[`.agents/skills/`](.agents/skills/). One surface per agent: keep the OpenSpec CLI on
`openspec config set delivery commands` (a global setting). Codex still gets its skills
— they are its only surface — while Claude and Cursor get commands alone, so the same
workflow no longer loads twice into one session. Requires the `openspec`
CLI (`openspec --version`). Capability IDs are nested (`graph/search`, not a
flat kebab folder). Docs-only or pure-refactor changes may `skip_specs`
instead of inventing a behavioral spec.

## Tauri plugins

Installed Tauri plugins are intentionally narrow (`dialog`, `opener`, `window-state`,
`updater`, and `process:allow-restart`). The durable allow/defer/avoid record lives in
[`docs/tauri-plugin-decisions.md`](docs/tauri-plugin-decisions.md); check it before adding a
plugin, JS package, capability permission, CSP/config entry, or frontend plugin API call.

## Architecture

> The enforceable rules live in [`docs/rules/`](docs/rules/) — read the one your change
> touches: [`architecture-rules.md`](docs/rules/architecture-rules.md) for the cross-cutting
> IPC contract, read/write split, and definition of done;
> [`architecture-rules-rust.md`](docs/rules/architecture-rules-rust.md) for backend work;
> [`architecture-rules-react.md`](docs/rules/architecture-rules-react.md) for frontend work
> (stores, components, SOLID / module decomposition).
> This section is the map; those files are the rules.

Two processes bridged by Tauri IPC: the **Rust core** (`src-tauri/`) and the **React
frontend** (`src/`). The frontend calls Rust via `invoke()`.

### The IPC contract lives in four files that must stay in sync

One command spans four layers, and all four land in the same change:

1. **Impl** — the owning module under `src-tauri/src/git/`: `read`, `status`, `graph`,
   `conflicts`, `worktree_fs` for reads, `write/` for real-`git` operations, `forge/` for PR
   providers, `oauth/` for native provider sign-in.
2. **Command + registration** — the `pub` `#[tauri::command]` fn in
   `src-tauri/src/commands/<domain>.rs` **and** its path-qualified line in
   `src-tauri/src/lib.rs`'s `generate_handler!`. A missing handler entry is the classic
   "command not found".
3. **Types** — the serde struct in `src-tauri/src/git/types.rs`, declared in a per-domain
   module under `git/types/` and re-exported flat. Everything is camelCase on the wire.
4. **TS wrapper** — the typed `invoke()` wrapper and matching interface in `src/lib/api/`,
   where `git/<name>.ts` mirrors the Rust `commands/<name>.rs` that owns those commands.

The per-layer requirements, the snake_case/camelCase arg convention, and the `CommandError`
error contract are [architecture-rules.md §1](docs/rules/architecture-rules.md) and
[architecture-rules-rust.md §4](docs/rules/architecture-rules-rust.md).
`src-tauri/src/commands/registration_tests/` enforces most of them.

### Read/write split — the central design decision

- **Reads** use libgit2 via the `git2` crate. `read.rs` (repo summary, branches,
  fast-forward checks, repo identity), `status.rs` (working-tree, commit, and range diffs),
  `conflicts.rs` (conflict detection and conflicted-file reads), and `graph.rs` (commit graph
  layout) are the facades, each with focused helpers in a sibling folder. `git2` is built
  with `default-features = false`, so **network features (clone/fetch/push) are deliberately
  unavailable** through libgit2.
- **Writes** (checkout, branch create/delete/rename, merge, rebase, reset, cherry-pick,
  revert, stage/unstage, commit, stash, pull, push) shell out to the user's real `git` binary
  through focused modules under `git/write/`. That directory has no re-export facade —
  callers name the owning module, e.g. `git::write::branches::create_branch` (GL-356). The
  CLI is intentional: it honours hooks, credential helpers, `.gitconfig`, signing, and the
  full conflict machinery. **Do not reimplement write operations with libgit2.**
- **Forge pull requests** (`git/forge/`, split by provider/service/transport responsibility)
  go through the provider `forge::context()` selects from the detected remote: `gh` for
  GitHub, `glab` or REST for GitLab, REST for Bitbucket, and the user's `origin` session for
  Cursor Origin. Each CLI has exactly one subprocess boundary. `forge.rs` stays the stable
  facade, and its parsing helpers also classify Azure DevOps, Gitea, and Forgejo/Codeberg.

Which engine a given operation must use, the secret-handling rules, and the transport-auth
split are [architecture-rules.md §2](docs/rules/architecture-rules.md).

### Threading: every command is async

Sync Tauri commands run on the webview's main thread, so anything that scales with the
repository — a status walk as much as a subprocess — freezes the UI until it returns. Every
command is therefore `async fn` wrapping its work in `blocking(move || …)`. Because
`git2::Repository` is not `Send`, each read takes a path and opens, reads, and drops the repo
inside that closure rather than caching a handle. The closed `SYNC_BY_DESIGN` list is the only
exception and a test enforces it. Details:
[architecture-rules-rust.md §2–3](docs/rules/architecture-rules-rust.md).

### The graph layout is computed in Rust, painted in JS

`git/graph.rs` owns the layout algorithm: it walks the DAG topologically and assigns
each commit a **lane** (column) via a reservation scheme — each lane holds the oid of
the parent it's waiting to render; the first parent continues a commit's lane, merges
branch into fresh lanes. It emits resolved `(row, lane, color)` coordinates and edges.

The frontend is a dumb painter: `src/features/graph/GraphLayer.tsx` (the column-aligned canvas
used inside the history view) renders those coordinates on a `<canvas>`
(chosen over DOM/SVG so redraws stay cheap at thousands of rows). `palette.ts` holds all
geometry constants and lane colors; the `color` index from Rust is mod'd into the
palette. **Don't put layout logic in the frontend** — extend the `git/graph.rs` facade and
focused helpers under `git/graph/` instead.
`HistoryWorkspace` uses `@tanstack/react-virtual` for the fixed-height commit,
stash, WIP, and load-more rows. `GraphLayer` follows the same virtual window so
its canvas backing store is bounded by the viewport plus overscan.

### Live updates: the filesystem watcher

`src-tauri/src/watcher.rs` owns the watch registry and recursively watches the open
worktree (including `.git`, so terminal commits, checkouts, and staging all register).
`watcher/classification.rs` classifies those events and emits a `repo-changed` Tauri event.
macOS uses FSEvents (directory-level, cheap), and bursts are throttled in Rust
(300 ms) **and** debounced again in the frontend (`src/hooks/useRepoWatcher.ts`, ~400 ms)
per open tab before triggering a quiet re-sync. Switching repos replaces that tab's
watcher (the old one is dropped). This is what keeps the UI live when the repo changes
outside the app.

### GitHub / multi-account model

`gh` can be logged into several accounts at once across GitHub.com and GitHub Enterprise
hosts. Rather than mutating the user's global `gh auth switch` state, GitLane **binds each
repository to one account ref** (stored in the accounts store, `src/store/accounts.ts`) with
versioned metadata: `{ provider: "gh", host, accountId, login }`. Legacy username bindings
are migrated only after they resolve against the loaded `gh` accounts, so a temporarily
missing account does not silently switch identity.

The account ref crosses IPC for GitHub PR/API operations, but provider tokens are resolved in the
backend immediately before the PR operation through the `GithubProvider` adapter, passed to the
child process via `GH_TOKEN`, and dropped. Repository/account host mismatches fail before PR
operations. **Exactly two commands may carry a user-entered secret:** `approve_https_credential`
(the frontend sends the token/password once and Rust pipes it directly to `git credential
approve`) and `save_provider_token` (the token goes straight into the OS keychain). Each hands
the secret to its OS-backed store and must never persist, log, echo, or return it; no other
command may declare a credential parameter, and no store state, persisted setting, event
payload, or log line may contain one.

**Two-noun identity model: accounts authenticate, identities author.** Accounts drive
**PR / clone / fetch / pull / push auth only** — for git transport **per remote**, and
**git-natively**: the account is the HTTPS remote URL's username (gitcredentials(7) —
credential helpers resolve by that username), written by the Remotes picker via
`git remote set-url` and *derived* back from the remote list, so the same choice works in a
terminal. GitHub remotes can inject `gh auth git-credential` per invocation; GitLab,
Bitbucket, Azure Repos, Cursor Origin, and unknown HTTPS remotes use the user's configured git credential
helper / GCM. Never inject `gh` credentials for `origin.cursor.com`. The app can send a non-GitHub token/password once to `git credential approve`
so Git's helper stores it; GitLane itself must never store it. **GitLane can also *own* a
provider token itself** (`providerToken` transport mode, GL-132): a token stored in the OS
keychain (`src-tauri/src/secrets.rs`, `keyring` crate, GitLane-namespaced service) and fed to
git by pointing `GIT_ASKPASS` at this binary — the re-entrant credential bridge
(`src-tauri/src/git/credential_bridge.rs`) reads it from the keychain in a child process and
answers git's prompt, so the token never crosses IPC. That token can be captured in-app either
as a pasted PAT or via **native OAuth** (GL-139, `src-tauri/src/git/oauth/`): GitLab's device
flow (RFC 8628) or Bitbucket's PKCE loopback (RFC 8252), which store the resulting access token
in the same keychain — an OAuth account then authenticates git as a sentinel username
(`oauth2` / `x-token-auth`). The public client id is a compile-time default
(`GITLANE_GITLAB_OAUTH_CLIENT_ID` / `GITLANE_BITBUCKET_OAUTH_CLIENT_ID` in
`src-tauri/src/git/oauth/config.rs`), overridable per host by a Rust-owned app-data file
written through `src-tauri/src/git/oauth/client_ids.rs`. This is the backend's first outbound-HTTP dependency (`ureq`,
rustls) — confined to `oauth/http.rs` behind an `HttpTransport` trait so the flows unit-test
against a mock; it runs in the Rust process, so no CSP change. See `docs/provider-oauth-setup.md`.
Transport auth resolves to a
`TransportCredential` (`None` / `CredentialHelper` / `Gh` / `Glab` / `ProviderToken`) in `src-tauri/src/git/transport_auth.rs`; the ref
that crosses IPC carries only a non-secret `providerAccountId` locator. **Two distinct verbs:**
provider **sign-out** (`delete_provider_token`) deletes GitLane's keychain token; **forget
saved HTTPS credential** (`reject_https_credential` → `git credential reject`) erases what the
user's own Git helper stored. `git`/`gh` errors are secret-redacted (`src-tauri/src/redact.rs`)
before surfacing. SSH remotes select their account via the SSH key. Only the PR-API account keeps a small localStorage binding.
Accounts never set the commit identity. Who the repo commits as is an
**identity card** (GL-130): a plain name/email (+ optional signing) entry applied to the
repo's *local* git config via `set_repo_identity` (never global; `commit` can also pin
author/committer per commit), with "this computer" (global config) as the default when
nothing is pinned. Accounts and identities are fully decoupled — accounts do **not** prefill
or otherwise feed identity cards (the old "New identity from @login" account chips were
removed as needless coupling); the repo Identity panel is one freely-editable name/email card
with the saved cards as presets, and its only prefill is "adopt the repo's current git-config
identity as a card" (`CommitAsZone`, git-config-derived, not account-derived). A repo is fully
usable (commit/fetch/push) with no account at all. Cards live in `src/store/identities.ts`;
the per-remote account bindings live in `src/store/accounts.ts`. Picking an auth account
never rewrites `user.name`/`user.email`.

### Frontend state — Zustand stores (split by concern)

Split so churn in one domain never re-renders another:

- `src/store/repo.ts` — **git domain state**: open repo summary, graph, branches,
  worktrees, stashes, working changes, and selection (selected commit / WIP / file).
  All async actions call through `lib/api`.
- `src/store/pulls.ts` — **pull-request state**: the PR list plus one normalized per-PR
  resource record (`prResources`: detail/checks/diff/threads/commits, each
  `{ data, slots, errors }` keyed by PR number, loaded through the shared lazy loader in
  `pullsResource.ts`; GL-349/GL-364). Split out so PR consumers don't re-render on graph churn.
- `src/store/accounts.ts` — **account state**: the `gh` account list and the **per-remote**
  transport-auth resolution that drives clone/fetch/pull/push auth (GL-129+): GitHub can
  resolve to `gh auth git-credential`, non-GitHub HTTPS remotes resolve to URL username +
  system credential helper/GCM, and SSH remotes use keys. The default GitHub remote's binding
  is mirrored for the PR surface. Does **not** own commit identity.
- `src/store/identities.ts` — **identity cards (GL-130)**: saved name/email (+ optional
  signing) entries and how one applies to the open repo's local git config, plus the
  per-repo+card custom-email override. Git config is the source of truth; the effective
  identity is read back into `accounts.ts`'s `repoIdentity`.
- `src/store/ui.ts` — **view & chrome state** (composer over `src/store/ui/` slices:
  `appearance`, `panels`, `menus`, `dialogs`, `navigator`, `prView`, `graphFilter`,
  `historySearch`, `terminalChrome`, `updatePrefs`, `reviewNotes`, `toasts`, `tooltip`,
  `composer`, `viewRouting`, `windows`, `settings`, `repoLabels`): theme (dark/light/system) + accent colour,
 density, panel widths, collapsed
 groups, overlays (one exclusive `menu: OpenMenu | null` slot for all context/action menus — opened via `openMenu`, read via per-kind selectors like `commitMenuOf` (GL-363) — plus dialogs), PR filter/tab, and the
 in-flight drag (`draggingFrom`). View prefs are persisted; transient overlays and git data
 are not. This is the cohesion watch-list item (theme + panels + overlays + PR filters +
 drag + pins in one store); do not add a new concern here without splitting first.
- `src/store/notifications.ts` — toast / notification queue.
- `src/store/commitAgentMessages.ts` — cached commit-agent instruction defaults (Rust app-data is the source of truth).
- `src/store/terminals.ts` — integrated terminal session chrome.
- `src/store/updates.ts` — updater channel / available-update state.
- `src/store/acpAgents.ts` — ACP agent session state.
- `src/store/selection.ts` — **pure** commit-selection + squash-range helpers (no Zustand,
  no IPC), called by `repo.ts`.

Cross-store reads are one-shot `getState()` calls inside actions, never reactive
subscriptions — so there is no render-cycle risk. Keeping the stores orthogonal stops
graph/file churn from flickering the toolbar.

### Frontend layout

`src/App.tsx` is the top-level dispatcher: `TitleBar` → `chrome/ActionBar` (the toolbar:
History/PRs tab toggle, the "Checked out" branch trigger, Pull/Push/Branch/Stash/Terminal)
→ a resizable grid → global overlays. Shell layout and which center view is showing live in
`src/app-shell/` (`CenterWorkspace`, `useCenterView`, `shellLayout`). The grid shape depends
on the active tab: in **History/Changes** it's `center workspace | RightPanel` (no left panel —
the graph spans the width); in **PRs** mode it's `navigation/LeftPanel | center workspace`
(the docked PR list, no right inspector).

The branch/worktree/stash navigator is **not a persistent pane** — it lives in
`navigation/branch-navigator/` (split by concern: `refs.ts` pure helpers,
`pinning.ts` pure pin ordering, `navItems.ts` the flat item model the list is virtualized
over, `useNavigatorSections` view-model hook, `useRowActions` row-behaviour hooks, `rows/`
presentational rows, `CategorySidebar`/`NavEmptyState`, and the `BranchNavigator.tsx`
container), shown in a 560px two-pane dropdown anchored under
the "Checked out" trigger (transient `navOpen` state in `ui.ts`): a category rail (All /
Branches / Remotes / Worktrees / Tags / Stashes with counts) beside the matching list,
grouped under headers in "All". Picking a branch/remote/tag/worktree navigates the graph
to its tip (`revealCommit`). Branches and remotes order by `tipTime` (the tip commit's
committer time — git records no branch creation time) with the checked-out branch and
pinned rows above; pins persist per repo in `ui.ts`'s `pinnedNavRefsByRepo`. Like the
history view, the list pane is virtualized (`@tanstack/react-virtual`) — but over mixed
row heights, so `navItems.ts` flattens headers, separators and rows into one sequence with
a declared height each. The PR list is rendered in PRs mode.

The center pane swaps by active tab/state between feature workspaces under
`src/features/` (routed from `src/app-shell/CenterWorkspace.tsx`):

- `features/graph/HistoryWorkspace` — the commit DAG with resizable columns; branch refs
  here are the primary drag sources.
- `features/changes/changes-workspace/` — multi-file staging/unstaging.
- `features/review/ReviewWorkspace` — single-file diff (unified/split).
- `features/review/StackedReview` — all files of one commit in a scrollable review.
- `features/pull-requests/PullRequestDetail` — PR body, files, and lazily-loaded CI checks.
- `src/features/conflicts/conflict-workspace/ConflictWorkspace.tsx` — merge/rebase conflict UI.
- `src/features/history-inspect/HistoryInspectWorkspace.tsx` — commit/range inspector.
- `src/features/repo-files/` — worktree file tree (`FilesPanel`) and
  `src/features/repo-files/file-workspace/RepoFileWorkspace.tsx` (source / preview / editor).

The shared diff renderer is `features/review/DiffBody`; the working-changes inspector
(`RightPanel`) and the commit modal (`CommitModal`) live in `features/changes/`. Per-file
diff fetching across these panes goes through the `hooks/useLazyDiffs` cache.
Keyboard chords are registered in `src/lib/shortcuts.ts`.

Components are grouped: `components/ui/` (reusable, domain-free primitives), `chrome/`
(window chrome + overlays), `navigation/` (the floating branch navigator + the PR list
panel), and cohesive verticals under `features/`. `src/lib/` holds non-React helpers:
`api/` (typed IPC wrappers), `prs.ts` (PR view-model mapping), `highlight/` (diff syntax
highlighting), `paths.ts`/`ui.ts`/`cn.ts`/`palette.ts` (helpers + tokens).

### Drag-and-drop branch operations

Implemented (no longer "planned"). Dragging a branch ref onto another (`HistoryWorkspace`
or the `BranchNavigator` dropdown) sets `draggingFrom`, and the drop opens the action menu
(`src/components/chrome/overlays/menus/`), which probes `canFastForward` in both directions to decide which
operations to offer (fast-forward, merge, rebase, reset). The chosen op calls the matching
`lib/api` write command, then refreshes.

## Jira

This project is tracked in Jira under project key `GL` (Task / Epic / Subtask issue
types). Reference the issue key (e.g. `GL-12`) in branch names, commit messages, and PR
titles so Jira's development panel links the work automatically.

When a Jira issue exists, commit messages and PR titles start with the ticket key:

```text
GL-12 Short human summary
GL-12 feat(scope): Short human summary
```

When there is no Jira issue, omit the key and use the same summary style:

```text
Short human summary
docs(rules): Short human summary
```

For non-trivial changes, include a commit body / PR description that explains the
implementation and validation in the same practical style as the surrounding history.

The `jira-implementation-comment` skill posts a structured, audience-aware
implementation summary to a ticket after coding work lands.

> **Connection details** (Atlassian site, cloudId, board URL, MCP usage) live in the
> uncommitted `CLAUDE.local.md` — they're per-account and intentionally kept out of the
> public repo.
