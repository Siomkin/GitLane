## Context

See proposal.md — Why. Engine: none. Stores touched: `ui`, `pulls`, `accounts`, `identities`, `repo` — no new store, no state-shape or action-signature change. Measured with the SCC script from `enforce-frontend-import-direction` (737 non-test source files, 1 component, 55 members, all under `src/store`) plus a per-domain edge count that resolves both `@/store/…` and `./…` specifiers (top-level store files import siblings relatively).

Three facts make this cheaper than the number suggests:

1. `repo`'s own slices are already clean — none imports `@/store/repo`; they use the composer's `set`/`get`. Only three slices back-import their own facade (`pulls/list.ts`, `pulls/writes.ts`, `accounts/repoMutation.ts`), and each already receives `get`.
2. The 18 back-edge files read only three fields of the repo store (`summary` ×21, `remotes` ×7, `forge` ×2) and call only three actions upward (`listRemotes` ×7, `loadPullRequests` ×4, `refresh` ×2). The one exception is `ui/composer.ts`, which drives `acpPrompt`/`acpCancel`.
3. SCC membership is transitive, so files leave in blocks: once `ui` has no edge to `repo`/`pulls`, all 6 `ui` files leave at once; once `accounts` has none, its 8 files leave; then `pulls` (7), `identities` (3); what remains (`repo*`, 31 files) is only in the component *because of* those stores and leaves with the last back-edge.

## Goals / Non-Goals

**Goals:**

- `bun run cycles` reports zero files; the store import graph matches the declared direction.
- Each PR is independently shippable and shrinks (or holds) the baseline; stopping after any PR leaves the tree better and guarded.
- No behaviour change: same actions fire in the same order after the same user gestures; every staleness guard reads the same live value it reads today.

**Non-Goals:**

- Fewer forward `getState()` calls. `repo → ui` (16 files) is the designed direction.
- Making stores DI-driven. One late-bound object with four entries is the ceiling on indirection here.

## Decisions

### 1. Direction: leaves < `ui` < `accounts` < `pulls` < `identities` < `repo`

Chosen by counting: it makes every majority direction legal (`repo → ui` 16, `repo → accounts` 8, `repo → pulls` 6, `accounts → ui` 6, `pulls → accounts` 4, `identities → accounts` 2) and leaves 20 back-edges in 18 files. `repo` on top matches its role — the repo lifecycle (`repoLifecycleActions`, `repoLifecycle/sideEffects.ts`) already fans out to every other store on open/switch/close. Alternative `ui` on top ("view orchestrates") was rejected: it inverts 23 forward files to legalise 6.

### 2. Everything that points up goes through one late-bound leaf

`src/store/links.ts`, zero runtime imports:

```ts
export const storeLinks = {
  openRepo: (): OpenRepoSnapshot => ({ summary: null, remotes: [], forge: null }),
  refreshRepo: async (_opts?: { prs?: boolean }) => {},
  listRemotes: async () => {},
  reloadPulls: async () => {},
};
```

`repo.ts` assigns `openRepo`/`refreshRepo`/`listRemotes` and `pulls.ts` assigns `reloadPulls` immediately after `create()`. `openRepo()` is a **getter, not a copy** — it returns `useRepo.getState()`'s three fields at call time.

Alternatives considered:

- **Pass the open repo as action arguments** — the first draft of this design. Rejected on evidence: many reads are post-`await` staleness guards (`accounts.ts:219,242` `if (useRepo.getState().summary?.path !== path) return`, `ui/toasts.ts:69`, `accounts/oauth.ts:160` `target.isCurrent()`), which need the value *now*, not the value at call time; an argument would silently turn a guard into a tautology. It would also change ~15 action signatures and their component callers.
- **`ui.activeRepoPath` set by `onRepoSwitched`** — a second source of truth for "which repo is open", needing a lifecycle contract and a drift test, and it covers only `path`, not `remotes`/`forge`.
- **`await import("@/store/repo")` at each site** — equally invisible to the static graph with no new module, but 20 of the 30 reads are synchronous (inside `set()` reducers such as `toggleNavPin`, or guard expressions), so they cannot await.
- **Event bus / subscriptions** — rejected by the existing rules.

`links.ts` hides four dependencies from the import graph on purpose. That is the trade: the runtime coupling is inherent (an account action must know which repo is open), the module coupling is not. It is capped — a rules sentence names the four entries and `links.test.ts` snapshots `Object.keys(storeLinks)`; a fifth needs a rules edit.

### 3. Async orchestration lives with the store that owns the IPC

`startAgentCommitDraft` in `ui/composer.ts` awaits `useRepo.getState().acpPrompt(…)` and then writes composer state; `cancelAgentCommitDraft` calls `acpCancel`. That is `repo`-domain async in a view-state slice, and routing it through `links.ts` would add two more verbs for one feature. It moves beside `acpPrompt` (repo commits slice) and writes `ui` via setters — forward direction, consistent with §1 "stores own async". Two call sites change which store they select the action from.

### 4. PR order follows block departure

PR 1 `links.ts` + `ui` (6 files leave) → PR 2 own-facade imports + `pulls → repo` (mechanical; baseline may hold, since `pulls → accounts → repo → pulls` survives until PR 3) → PR 3 `accounts` (8 files, the most call sites: transport-auth chains) → PR 4 `identities`, baseline `[]`, rules.

## Risks / Trade-offs

- A link used before it is bound returns the empty snapshot / no-ops → in the app `main.tsx` → `App.tsx` imports `useRepo` before any action can run; add a dev-only assertion in `links.test.ts` that importing `@/store/repo` and `@/store/pulls` binds all four. In tests an unbound link is the desired isolation.
- A mechanical replace changes guard semantics if `openRepo()` were cached in a local across an `await` → task text requires each guard to call `storeLinks.openRepo()` at the same point the old code called `useRepo.getState()`; review the diff for `const … = storeLinks.openRepo()` hoisted above an `await`.
- Moving `startAgentCommitDraft` changes which store a component selects from → two call sites, both in `features/changes/commit-modal/`; covered by the existing commit-modal tests.
- `vi.mock("@/store/repo")` in existing store tests stops affecting `accounts`/`pulls`/`ui` code that no longer imports it → those tests set `storeLinks.openRepo = () => fixture` instead; call this out in each PR description so failures are read correctly.
