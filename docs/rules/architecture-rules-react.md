# Architecture Rules — React frontend (`src/`)

Frontend-specific rules. Read [architecture-rules.md](architecture-rules.md) first — the
**IPC contract** (Rule 1) governs how the frontend talks to Rust (`invoke()` only via
`lib/api`, never from a component).

---

## 1. State — Zustand, split by concern

Stores are split so churn in one domain never re-renders another. Put new state in the store
that owns its concern:

- `store/repo.ts` — git domain state (repo, graph, branches, worktrees, stashes, working
  changes, selection).
- `store/pulls.ts` — PR list + per-number detail/checks caches.
- `store/accounts.ts` — provider-aware GitHub account metadata, per-repo binding, commit identity.
- `store/ui.ts` — view/chrome state (theme + accent colour, density, panel widths, overlays, filters, drag).
  View prefs persist; transient overlays and git data do not.
- `store/selection.ts` — **pure** helpers (no Zustand, no IPC).

**Rules:**
- **Git/domain async actions live in the store** and call Rust through `lib/api` — never
  `invoke()` directly, never ad hoc git orchestration in a component. If a component needs repo
  data, it calls a store action; it does not import `api` to invent a second data path.
- **Cross-store reads are one-shot `getState()` calls inside actions**, never reactive
  `useX()` subscriptions across stores. That single rule is what keeps re-renders contained.
- **Pure logic (no IPC, no Zustand) goes in `selection.ts`-style modules or `lib/`** so it's
  reusable and trivial to test.
- **Don't widen a store with another concern's state.** If graph churn would flicker your new
  state, it's in the wrong store — extract a slice (the `accounts.ts` split out of `ui.ts` is
  the precedent). But **don't pre-split a cohesive store** — see §4.
- Account bindings persist only frontend-safe refs (`provider`, `host`, `accountId`, `login`).
  Never put tokens, OAuth codes, keychain locators, or raw provider credentials in Zustand or
  localStorage.

**Allowed `api` import sites:**
- `src/lib/api/*` owns raw `invoke()`.
- `src/store/*` owns domain data loading and mutations.
- A feature hook may import `api` only when it owns an isolated external resource/session that
  is not repo state, such as the PTY terminal session, and the hook is the boundary consumed by
  components. Name the hook as the boundary and test it or its pure helpers.
- A component may import `api` only for a deliberately local, disposable preview/probe that does
  not update shared app state. Add a short comment explaining why it is not a store action.

Anything else is a smell: move the call into a store action or feature hook before adding more
UI around it.

## 2. Components & styling

- **Placement mirrors role:**
  - `components/ui/` — reusable, **domain-free** primitives (no store imports, no git
    concepts). If it knows about commits or PRs, it doesn't belong here.
  - `chrome/` — window chrome + overlays. `navigation/` — branch navigator + PR list.
  - `features/<vertical>/` — cohesive feature workspaces (graph, changes, review,
    pull-requests, terminal). New feature UI gets its own `features/` folder, not a dump in
    `chrome/`.
- **New or touched components and hooks are arrow-function consts**, not `function`
  declarations:
  `export const ActionBar = (props) => { … }`, `export const useRepoForge = (path) => { … }`.
  Existing legacy `function` components should be converted when the file is already being
  materially edited. The icon library `components/ui/icons.tsx` is the pre-existing exception:
  a uniform file of `function *Icon` data exports. Match a file's established style, don't mix
  two declaration styles within one file.
- **Default to one component per file; group a cluster into a folder module.** A file that
  holds a container *plus* its sub-components *plus* a `derive/map/view` helper is the smell —
  split it into a folder up front, not after it grows. The precedents are
  `navigation/branch-navigator/` and `chrome/action-bar/`: a thin container (`ActionBar.tsx`)
  + one file per presentational sub-component (`SegTab.tsx`, `ToolbarAction.tsx`,
  `ProviderIndicator.tsx`, `Separator.tsx`) + pure logic with a co-located test
  (`provider.ts` + `provider.test.ts`) + an `index.ts` barrel. Reach for this
  shape from the start. Co-locating a sub-component is reserved for a *single, trivial, purely
  presentational* leaf. Two or more leaves, any hook, any helper with logic, or any store/API
  wiring means separate files.
- **Subscribe narrowly:** one field per `useStore((s) => s.field)` call, so a component
  re-renders only on the slices it uses. Don't destructure the whole store.
- **Styling is Tailwind, class-based dark mode.** Compose conditional classes with `cn()`
  (`lib/cn.ts`); reach for shared tokens (`focusRing`, `lib/ui.ts`, `palette.ts`) instead of
  hardcoding. Every interactive element needs its `dark:` variant and a focus ring — copy a
  sibling component.
- **Non-React helpers go in `lib/`** (`paths.ts`, `highlight.ts`, `prs.ts`), not inline.
  View-model mapping (e.g. PR shaping in `prs.ts`) is a `lib/` job, not a component's.
- History row virtualization is owned by `@tanstack/react-virtual`; keep graph
  canvas clipping synchronized to its virtual items instead of adding another
  scroll/resize observer or custom list-window implementation.

**Default folder shape for non-trivial UI:**
- `FeatureContainer.tsx` selects store state, owns layout, and dispatches actions.
- `SubView.tsx` / `Row.tsx` files are presentational leaves.
- `useFeatureThing.ts` owns local effects that are not shared store state.
- `featureViewModel.ts` / `featureRules.ts` holds pure mapping/derivation.
- `featureRules.test.ts` covers the pure logic; render tests cover user-visible branching.

Do not wait for a file to become painful before using this shape. If the feature has more than
one reason to change on day one, start with the folder module.

**Quality ratchet for existing debt:**
- New files must follow these rules.
- Touched files should move toward these rules in the same change when the cleanup is local and
  low-risk.
- If a cleanup would become its own refactor, do not hide it inside feature work. Track it as a
  `GL` ticket with the concrete file and reason to split.

---

## 3. Live updates & async hygiene

- Repo mutations are picked up by the filesystem watcher (`watcher.rs` → `repo-changed`,
  debounced in `App.tsx`). After a write action, prefer a **`refresh()`** of repo state over
  optimistically hand-patching the store — watcher + refresh keep the UI truthful. Use
  `refresh({ quiet: true })` for background re-syncs and `{ prs: false }` to skip the slow
  `gh` fetch when PRs aren't affected.
- Don't add new polling loops or your own file watchers — extend the existing watcher path.

---

## 4. SOLID & module decomposition — split by responsibility, not line count

The point of these rules is **one module = one reason to change**, not a line budget. A long
file that changes for one reason is fine; a short file that mixes fetching, mapping, and
rendering is not. **Line count is a prompt to look, never the verdict.** Apply this before you
reach for the toolkit below.

Quality here means:
- **Small public surfaces:** modules export the minimum needed by their siblings.
- **Pure core, impure shell:** parsing, grouping, filtering, menu eligibility, and view-model
  mapping are pure `.ts` functions with tests; components and stores only call them.
- **One data owner:** shared repo/account/PR state has exactly one store action path. Local
  component state is for UI affordances only: open/closed, focused row, draft text, measured
  sizes.
- **Boundary-first tests:** test pure helpers heavily, store actions for async ownership/races,
  and components for the user-visible branch. Do not make a huge component more testable by
  exporting its internals; extract the logic instead.

### What "too big" actually means

A file is too big when it has **more than one axis of change** — when a PR-layout tweak, a
styling change, and a data-fetch change would all edit the same function. Judge by
responsibilities, not lines:

| File | Lines | Verdict | Why |
|------|-------|---------|-----|
| `store/repo.ts` | thin composer + slices | **Keep one git-domain store; split by responsibility, never by line count** | `repo.ts` is a thin `create()` composing typed action slices (`repoLifecycleActions`/`repoSelectionActions`/`repoWriteActions` over `repoTypes`) plus pure `selection.ts`-style siblings — `repoSession.ts` (localStorage tab persistence) and `repoRequests.ts` (graph-generation/open-intent tokens + the deferred-refresh queue). These are same-domain slices, **not** reactive micro-stores, so cross-store `getState()` chatter is still avoided. New graph-request guards, selection math, persistence helpers, operation labels, or batch-action rules move to such modules with tests instead of making the store body absorb every concept. |
| `features/changes/RightPanel.tsx` | ~380 | **Should split** | Holds *two* unrelated inspectors (`WorkingInspector` staging + `CommitInspector` commit-review) under a layout-slot name → two axes of change. Internal sub-components are clean; the file isn't. Contrast `PullRequestDetail` (below). |
| `components/ui/icons.tsx` | ~460 | **Fine — it's data** | 22 prop-only SVG icon exports. No logic, one axis of change. |
| `features/pull-requests/PullRequestDetail.tsx` | ~110 | **Fine — thin container** | Selects the active PR, drives the detail fetch, gates the body on load state. Each tab body is its *own* fetch/render responsibility, so they live in sibling files (`PrHeader`, `PrInfoTab`, `PrDiffTab`, `PrChecksTab`, `PrCommitsTab`) — once a tab grew its own `useEffect` + store slice, co-location would have been four axes of change in one file. |
| `features/terminal/TerminalPanel.tsx` | ~450 | **Look harder** | A single ~330-line `TerminalLayer` function (multiple concerns) + 5 inline icon components that belong in `icons.tsx`. This is the real smell — a *function* doing too much, not a long file. |
| `chrome/action-bar/` (folder) | — | **The component-split precedent** | Container `ActionBar.tsx` + one file per sub-component (`SegTab`/`ToolbarAction`/`ProviderIndicator`/`Separator`) + pure `provider.ts` (+ co-located `provider.test.ts`) + `index.ts` barrel. The default shape for any non-trivial toolbar/panel — built split from the start, not refactored later. |

> The real smell is **a single function/component doing too much**, not a long file made of
> many small, focused pieces.

> **For components, default to splitting.** This codebase's owner treats each sub-component,
> hook, and helper as its own reason to change — so the bar for "co-locate" is high: a *single,
> trivial, purely presentational* leaf may stay inline; **two or more sub-components, or any
> helper with logic, get their own files** in a folder module (container + per-component file +
> hook + pure `.ts` + test + `index.ts`). This is stricter than a pure axis-of-change reading
> on purpose — splitting up front keeps each piece small, arrow-functional, and testable.
> (Stores are the opposite: split them by *domain* only, never by line count — see §1 / the
> `repo.ts` row — because splitting a store multiplies cross-store `getState()` chatter.)

> **Promotion trigger — when co-location stops being free.** A co-located sub-component must
> move to its own file the moment it grows its **own data-fetching** — its own `useEffect`,
> its own store slice/subscription, or its own lazy-load + error/loading state. At that point
> it has a distinct *reason to change* (its data source) independent of its siblings, so
> keeping N of them in one file means N axes of change in one file. This is exactly how
> `PullRequestDetail` regressed: four tab bodies (`InfoTab`/`DiffTab`/`ChecksTab`/`CommitsTab`),
> each with its own `loadPr*` effect, accumulated in one 510-line file before being split into
> `Pr*Tab.tsx` siblings. Reused-elsewhere is **not** the only promotion trigger (§-toolkit item
> 5) — a self-fetching tab gets its own file even if it's used once.

### The decomposition toolkit (what this codebase already uses)

When a component genuinely has multiple responsibilities, reach for these — in order of
preference — instead of leaving a god-component or inventing a new abstraction:

1. **Extract a custom hook** (`hooks/`) for stateful logic / effects shared by ≥2 components
   or a gnarly effect in one. Precedents: `useLazyDiffs` (keyed diff cache), `useDismiss`
   (Escape/outside-click), `useRepoWatcher`. The hook receives a `fetcher` when possible; raw
   `invoke` still stays in `lib/api`.
2. **Extract a pure helper** (`lib/`) for transforms/mapping with no React and no IPC
   (`prs.ts`, `paths.ts`, `selection.ts`). Testable in isolation.
3. **Move async orchestration into a store action**, not the component (§1).
4. **Split container vs presentational:** a leaf takes props and renders; data wiring lives in
   the container/workspace. Memoize hot presentational leaves (`React.memo(UnifiedLine)`,
   `useMemo(highlight(...))` in `DiffBody`).
5. **Co-locate small sub-components** in the same file before creating new files — *while they
   stay purely presentational* (props in, JSX out). Promote a sub-component to its own file
   when **either** it's reused elsewhere **or** it grows its own data-fetching (its own
   `useEffect` / store slice / lazy-load state — the promotion trigger above). A container that
   dispatches between several self-fetching sub-views keeps only the dispatch; each sub-view is
   its own file (the `PullRequestDetail` → `Pr*Tab.tsx` shape).
6. **Extract a store slice** only when a store mixes domains (the `accounts.ts`-from-`ui.ts`
   precedent) — by domain, never to hit a line count.

### SOLID, concretely in this codebase

- **S — Single Responsibility:** one module, one axis of change. `icons.tsx` = icon data;
  `repo.ts` = git-domain actions; `prs.ts` = PR view-model mapping. A component that *fetches +
  maps + paints* is three axes → push fetch into a store/hook, mapping into `lib/`, leave it
  rendering.
- **O — Open/Closed:** extend by adding, not editing the consumer. New lane colors go in
  `palette.ts` and the canvas painter consumes the `color` index unchanged; a new command
  follows the four-layer pattern rather than special-casing an existing one.
- **L — Liskov:** keep contracts uniform. Every `api` wrapper has the same `invoke<T>` shape;
  `FileStatus` is a closed union; a presentational component honours its prop contract for
  every input (handle empty/error/loading, don't crash on an unexpected status).
- **I — Interface Segregation:** depend only on what you use. Per-concern stores +
  one-field-per-selector mean a component never re-renders on state it doesn't read.
  `components/ui/` primitives are prop-only and domain-free.
- **D — Dependency Inversion:** depend on the boundary, not the detail. Components/stores
  depend on the `api` abstraction (`lib/api`), never on `invoke`/Tauri directly; `useLazyDiffs`
  takes a `fetcher` rather than importing `invoke`.

### Don't cargo-cult it

- **Don't split a file to hit a line count.** Split because concepts are mixed. `repo.ts`'s
  uniform `runOp` write wrappers stay together (splitting them buys nothing), and a per-menu
  split of `menus.tsx` is justified only when each menu gets its own behavior, helpers, or
  tests; a speculative `src/types/` folder is still abstraction-for-its-own-sake. Extracting a
  genuinely separate concern *by responsibility* — e.g. `repoSession.ts` / `repoRequests.ts`
  out of `repo.ts` — is the opposite move and is encouraged.
- **Don't extract a one-off** into a "reusable" hook/component used once — that's
  abstraction-for-its-own-sake. Extract on the **second** real use, or immediately when it
  creates a pure/testable boundary or removes a genuine multi-responsibility tangle.
- **Leaf rows reading stores directly is fine at this app size** — don't blanket-prop-drill.

### Review gate for frontend changes

Before approving a React change, ask these in order:

1. Does every shared repo/account/PR data mutation enter through exactly one store action?
2. Are parsing, grouping, filtering, menu eligibility, and view-model mapping extracted into
   pure modules with focused tests?
3. Does each component file have one reason to change, or is it mixing container wiring,
   effects, helpers, and rendering?
4. Are `api` imports limited to `src/lib/api/*`, stores, or an explicitly documented local
   preview/probe/session boundary?
5. Did the change add or update tests at the cheapest useful boundary: pure helper first,
   store action for async ownership, render test for visible branching?

> Track concrete decomposition work as `GL` Jira tickets and reference the key in the branch
> and commit — don't accumulate standing "refactor plan" docs that drift out of sync with the
> code (the rules here are the durable guidance; the tickets are the backlog).

---

## Anti-patterns (frontend)

- ❌ New `function Foo()` component/hook declarations — components and hooks are arrow consts
  (`const Foo = () => …`); see §2 (only `icons.tsx` keeps its legacy `function` style).
- ❌ A container file that also defines its sub-components *and* a `derive/map/view` helper
  inline — split into a folder module (container + per-component files + hook + pure `.ts` +
  co-located test + `index.ts`), like `chrome/action-bar/`.
- ❌ `invoke()` / repo fetch / git logic inside a component (go through `lib/api` + a store action).
- ❌ Cross-store reactive subscriptions; dumping unrelated state into a store.
- ❌ Domain-aware components under `components/ui/`; hardcoded colors instead of tokens/`cn()`.
- ❌ Splitting a file to hit a line count, or extracting a one-off into a "reusable" abstraction.
- ❌ Keeping multiple *self-fetching* sub-components (each with its own `useEffect` / store slice)
  co-located in one file — promote each to its own file (see §4 promotion trigger). Co-location
  is for purely presentational leaves only.
- ❌ Layout/positioning math in the frontend instead of `graph.rs`.
