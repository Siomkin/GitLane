# Architecture Rules — React frontend (`src/`)

Frontend-specific rules. Read [architecture-rules.md](architecture-rules.md) first — the
**IPC contract** (Rule 1) governs how the frontend talks to Rust (`invoke()` only via
`lib/api`, never from a component).

> **Rule tiers — know what enforces each rule.**
> - **Tier 1 — invariants:** the import boundaries in §1–2, mechanically enforced by
>   `eslint.config.js` (GL-58) and `tsc`. Breaking one fails CI.
> - **Tier 2 — architecture:** error boundaries and IPC validation (GL-56/57) and the
>   decomposition guidance in §4. Reviewer-enforced; breaking one should fail review.
> - **Tier 3 — style:** taste (e.g. arrow-vs-`function`, see §2). Neither linted nor
>   mandated — internal consistency is the only ask.

---

## 1. State — Zustand, split by concern

Stores are split so churn in one domain never re-renders another. Put new state in the store
that owns its concern:

- `store/repo.ts` — git domain state (repo, graph, branches, worktrees, stashes, working
  changes, selection).
- `store/pulls.ts` — PR list + the normalized per-PR resource record (`prResources`:
  detail/checks/diff/threads/commits, each `{ data, slots, errors }`, loaded via the
  shared lazy loader in `store/pullsResource.ts`; GL-364).
- `store/accounts.ts` — provider-aware GitHub account metadata + the **per-remote
  clone/fetch/pull/push transport auth** (GL-129+). GitHub remotes can resolve to a `gh`
  account ref; non-GitHub HTTPS remotes use URL usernames plus system credential helpers /
  GCM; SSH uses keys. Does **not** own the commit identity; binding never writes
  `user.name`/`user.email`.
- `store/identities.ts` — **identity cards** (GL-130): saved name/email (+ optional signing)
  entries and how one applies to the open repo's local git config, plus the per-repo+card
  custom-email override. Owns commit identity; git config is the source of truth (the
  effective identity is read back into `accounts.ts`'s `repoIdentity`). Accounts are not an
  identity kind — they only prefill new cards.
- `store/ui.ts` — view/chrome state (theme + accent colour, density, panel widths, overlays, filters, drag).
  View prefs persist; transient overlays and git data do not.
- `store/selection.ts` — **pure** helpers (no Zustand, no IPC).

**Rules:**
- **Git/domain async actions live in the store** and call Rust through `lib/api` — never
  `invoke()` directly, never ad hoc git orchestration in a component. If a component needs repo
  data, it calls a store action; it does not import `api` to invent a second data path.
- **Cross-store reads are one-shot `getState()` calls inside actions**, never reactive
  `useX()` subscriptions across stores. That single rule is what keeps re-renders contained.
- **Store actions own state transitions — no `useEffect` whose body is only store/state
  writes.** An effect shaped `useEffect(() => { if (x) setY(…) }, [x])` is a transition hiding
  in a component: it fires a render late, is untestable without mounting, and usually means the
  state it writes lives in the wrong place (React's "you might not need an effect"). Put the
  transition in the action that *causes* it. Precedents (GL-155): `revealCommit`/`revealStash`
  surface the history tab themselves; `refresh` calls `ui.onWorkingTreeClean()` where it
  publishes an empty change set; the repo lifecycle calls `ui.onRepoSwitched()` at every point
  the displayed repo identity changes — `App.tsx` no longer effect-syncs any of this. A
  corollary: cross-cutting resets get **one named transition action** (`onRepoSwitched`,
  `returnToGraph`) rather than callers composing individual setters — new transient state then
  has exactly one place to join the reset. Effects remain for genuinely external work:
  subscriptions, event listeners, timers, measurement (`useRepoWatcher`, `useDismiss`).
- **Pure logic (no IPC, no Zustand) goes in `selection.ts`-style modules or `lib/`** so it's
  reusable and trivial to test.
- **Shared string discriminants are typed constants, not repeated literals.** When an action,
  status, mode, or pending key is written and compared in more than one place, define one
  exported `as const` object and derive its union type from that object. Callers use the named
  members for writes and comparisons so renames fail at compile time and refactors cannot leave
  stale magic strings behind. Keep a literal inline only when it is local to one expression or
  is an external wire value already typed by the API contract.
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

These boundaries are **lint-enforced** (`eslint.config.js`, GL-58): raw `invoke` only in
`src/lib/api/*`, and the `api` object only in stores, `lib/api`, or a site that opts out with an
explicit `// eslint-disable-next-line no-restricted-imports -- <reason>` — which is exactly how
a feature-hook or component-probe exception above documents itself.

## 2. Components & styling

- **Placement mirrors role:**
  - `components/ui/` — reusable, **domain-free** primitives (no store imports, no git
    concepts). If it knows about commits or PRs, it doesn't belong here. Lint-enforced
    (`eslint.config.js`, GL-58): no `store`/`features`/`lib/api` imports.
  - `chrome/` — window chrome + overlays. `navigation/` — branch navigator + PR list.
  - `features/<vertical>/` — cohesive feature workspaces (graph, changes, review,
    pull-requests, terminal). New feature UI gets its own `features/` folder, not a dump in
    `chrome/`.
- **Components and hooks may be `function` declarations *or* arrow-function consts** —
  both are idiomatic here and neither is enforced (Tier 3). `function Foo()` is the
  de-facto house style across the feature layer (`features/*`, which is `function`-first
  better than 2:1); arrow consts are common in `chrome/` and `components/ui/`. The one
  firm rule is **consistency within a file**: match the style already established in the
  file you're editing and don't mix the two in one (`components/ui/icons.tsx`, a uniform
  file of `function *Icon` data exports, is the clearest single-style example). Don't do a
  drive-by conversion of a file from one style to the other.
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
- **Every dialog is a `ModalFrame`** (`chrome/overlays/dialogs/frame.tsx`, GL-350). The frame
  owns the whole modality contract — `role="dialog"` + `aria-modal` + an accessible name
  (`label` or `labelledBy`), the Tab focus trap, Escape (arbitrated across open dialogs by
  mount order), and backdrop-click dismissal. Do **not** hand-roll any of those in a dialog:
  no `useFocusTrap`/`useDismiss` call, no `window` Escape listener, no `fixed inset-0`
  backdrop. Pick a stacking layer from `DIALOG_LAYER` and a treatment from `DIALOG_SURFACE`
  rather than a literal `z-[…]`/background class. A window that raises a nested overlay
  passes `active={false}` so one Escape doesn't tear down both; a long-running dialog passes
  `backdropDismiss={false}` mid-run. Add every new dialog to `overlays/modality.test.tsx`.
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

Judge by the *pattern*, not a line count (counts rot — these rows deliberately carry none):

| Pattern | Verdict | Why |
|---------|---------|-----|
| A git-domain store that's a thin `create()` composing **same-domain** action slices | **Keep it as one store — split a store by *domain*, never by line count** | `repo.ts` is a thin composer over typed slices (`repoLifecycleActions`/`repoSelectionActions`/`repoWriteActions` + `repoTypes`) plus pure siblings (`repoSession.ts` tab persistence, `repoRequests.ts` graph-generation/open-intent tokens + the deferred-refresh queue). Same-domain slices, **not** reactive micro-stores, so cross-store `getState()` chatter is still avoided. New graph-request guards, selection math, persistence helpers, operation labels, or batch rules go to such modules with tests — not into the store body. |
| A prop-only **data** file (e.g. the SVG icon set) | **Fine — one axis of change** | No logic; it changes only when the data does. `components/ui/icons.tsx` is a long file of prop-only icon exports and is right as one file. |
| A **thin container** that selects state and dispatches to self-fetching sibling views | **Fine** | Each sub-view owns its fetch/render, so it gets its own file and the container keeps only the dispatch. `PullRequestDetail` → `Pr*Tab.tsx` (`PrInfoTab`/`PrDiffTab`/`PrChecksTab`/`PrCommitsTab`) is the model; the working-tree inspector likewise lives in `WorkingInspector`/`CommitInspector`, not one `RightPanel` file. |
| One file holding **two unrelated** views under a single layout-slot name | **Split** | Two axes of change even when each view's internals are clean — a staging inspector and a commit-review inspector don't belong in one file. |
| A single **function** doing fetch + map + paint | **The real smell — extract** | A long file made of many small focused pieces is fine; a long *function* doing too much is not. Push fetch into a store/hook, mapping into `lib/`, leave it rendering (the toolkit below). |
| A non-trivial toolbar/panel | **Folder module — the default shape** | Container + one file per sub-component + a hook + pure `.ts` + co-located test + `index.ts`, built split from the start. Precedents: `chrome/action-bar/`, `navigation/branch-navigator/`. |

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
> each with its own `loadPr*` effect, accumulated in one oversized file before being split into
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

- ❌ A container file that also defines its sub-components *and* a `derive/map/view` helper
  inline — split into a folder module (container + per-component files + hook + pure `.ts` +
  co-located test + `index.ts`), like `chrome/action-bar/`.
- ❌ `invoke()` / repo fetch / git logic inside a component (go through `lib/api` + a store action).
- ❌ A `useEffect` whose body is only store/state writes (a state-syncing effect) — put the
  transition in the action that causes it (§1).
- ❌ Cross-store reactive subscriptions; dumping unrelated state into a store.
- ❌ Domain-aware components under `components/ui/`; hardcoded colors instead of tokens/`cn()`.
- ❌ Splitting a file to hit a line count, or extracting a one-off into a "reusable" abstraction.
- ❌ Keeping multiple *self-fetching* sub-components (each with its own `useEffect` / store slice)
  co-located in one file — promote each to its own file (see §4 promotion trigger). Co-location
  is for purely presentational leaves only.
- ❌ Layout/positioning math in the frontend instead of `graph.rs`.
