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
- **Async actions live in the store** and call Rust through `lib/api` — never `invoke()`
  directly, never fetch in a component.
- **Cross-store reads are one-shot `getState()` calls inside actions**, never reactive
  `useX()` subscriptions across stores. That single rule is what keeps re-renders contained.
- **Pure logic (no IPC, no Zustand) goes in `selection.ts`-style modules or `lib/`** so it's
  reusable and triv/testable.
- **Don't widen a store with another concern's state.** If graph churn would flicker your new
  state, it's in the wrong store — extract a slice (the `accounts.ts` split out of `ui.ts` is
  the precedent). But **don't pre-split a cohesive store** — see §4.
- Account bindings persist only frontend-safe refs (`provider`, `host`, `accountId`, `login`).
  Never put tokens, OAuth codes, keychain locators, or raw provider credentials in Zustand or
  localStorage.

---

## 2. Components & styling

- **Placement mirrors role:**
  - `components/ui/` — reusable, **domain-free** primitives (no store imports, no git
    concepts). If it knows about commits or PRs, it doesn't belong here.
  - `chrome/` — window chrome + overlays. `navigation/` — branch navigator + PR list.
  - `features/<vertical>/` — cohesive feature workspaces (graph, changes, review,
    pull-requests, terminal). New feature UI gets its own `features/` folder, not a dump in
    `chrome/`.
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

### What "too big" actually means

A file is too big when it has **more than one axis of change** — when a PR-layout tweak, a
styling change, and a data-fetch change would all edit the same function. Judge by
responsibilities, not lines:

| File | Lines | Verdict | Why |
|------|-------|---------|-----|
| `store/repo.ts` | ~700 | **Fine — leave it** | ~84 store actions, 18 of them the uniform `runOp`+`refresh` write wrappers; the rest are thin read/selection setters. Long, not overloaded. Splitting multiplies cross-store `getState()` chatter for zero gain. |
| `features/changes/RightPanel.tsx` | ~380 | **Should split** | Holds *two* unrelated inspectors (`WorkingInspector` staging + `CommitInspector` commit-review) under a layout-slot name → two axes of change. Internal sub-components are clean; the file isn't. Contrast `PullRequestDetail` (below). |
| `components/ui/icons.tsx` | ~460 | **Fine — it's data** | 22 prop-only SVG icon exports. No logic, one axis of change. |
| `features/pull-requests/PullRequestDetail.tsx` | ~110 | **Fine — thin container** | Selects the active PR, drives the detail fetch, gates the body on load state. Each tab body is its *own* fetch/render responsibility, so they live in sibling files (`PrHeader`, `PrInfoTab`, `PrDiffTab`, `PrChecksTab`, `PrCommitsTab`) — once a tab grew its own `useEffect` + store slice, co-location would have been four axes of change in one file. |
| `features/terminal/TerminalPanel.tsx` | ~450 | **Look harder** | A single ~330-line `TerminalLayer` function (multiple concerns) + 5 inline icon components that belong in `icons.tsx`. This is the real smell — a *function* doing too much, not a long file. |

> The real smell is **a single function/component doing too much**, not a long file made of
> many small, focused pieces. Co-locating *purely presentational* sub-components in one file
> is a feature, not a debt.

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
   (Escape/outside-click), `useRepoWatcher`. The hook receives a `fetcher`; `invoke` stays in
   `lib/api`.
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

- **Don't split a file to hit a line count.** Keep `repo.ts` long (uniform wrappers); a
  per-menu split of `menus.tsx` and a speculative `src/types/` folder were both weighed and
  rejected as abstraction-for-its-own-sake.
- **Don't extract a one-off** into a "reusable" hook/component used once — that's
  abstraction-for-its-own-sake. Extract on the **second** real use, or when it removes a
  genuine multi-responsibility tangle.
- **Leaf rows reading stores directly is fine at this app size** — don't blanket-prop-drill.

> Track concrete decomposition work as `GP` Jira tickets and reference the key in the branch
> and commit — don't accumulate standing "refactor plan" docs that drift out of sync with the
> code (the rules here are the durable guidance; the tickets are the backlog).

---

## Anti-patterns (frontend)

- ❌ `invoke()` / `fetch` / git logic inside a component (go through `lib/api` + a store action).
- ❌ Cross-store reactive subscriptions; dumping unrelated state into a store.
- ❌ Domain-aware components under `components/ui/`; hardcoded colors instead of tokens/`cn()`.
- ❌ Splitting a file to hit a line count, or extracting a one-off into a "reusable" abstraction.
- ❌ Keeping multiple *self-fetching* sub-components (each with its own `useEffect` / store slice)
  co-located in one file — promote each to its own file (see §4 promotion trigger). Co-location
  is for purely presentational leaves only.
- ❌ Layout/positioning math in the frontend instead of `graph.rs`.
