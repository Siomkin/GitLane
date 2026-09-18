## Why

`CLAUDE.md` and `docs/rules/architecture-rules-react.md` §1 describe the Zustand stores as split by concern and orthogonal. At the module level they are one unit: a 2026-09-18 audit found a single runtime import cycle (strongly connected component) of **55 files** spanning `repo`, `ui`, `accounts`, `pulls`, `identities` and every slice under them. Store-to-store runtime import edges (files, `import type` excluded, `@/` and `./` specifiers both resolved):

| forward edge | files | | back-edge | files |
|---|---|---|---|---|
| `repo → ui` | 16 | | `ui → repo` | 5 |
| `repo → accounts` | 8 | | `accounts → repo` | 7 |
| `repo → pulls` | 6 | | `pulls → repo` | 4 |
| `accounts → ui` | 6 | | `accounts → pulls` | 2 |
| `pulls → accounts` | 4 | | `ui → pulls` | 1 |
| `identities → accounts` / `→ ui` | 2 / 1 | | `identities → repo` | 1 |
| `repo → identities` | 1 | | | |

It works today only because every cross-store access is a `getState()` inside an action body, never at module scope. The costs are real but quiet: importing any one store (in a test, a story, a worker) evaluates all 55 modules and everything they import, so no store can be unit-tested without the others' `lib/api` mocks; one future module-scope read (`const x = useRepo.getState()…`) becomes an import-order-dependent TDZ crash; Vite HMR cannot find a boundary inside `src/store`; and the documented claim that UI chrome is independent of git data is unverifiable.

The right-hand column is **20 edges in 18 files**, and what they do is narrow: read three fields of the open repo (`summary` ×21, `remotes` ×7, `forge` ×2), or ask a higher store to refresh after finishing their own work (`repo.listRemotes` ×7, `pulls.loadPullRequests` ×4, `repo.refresh` ×2), plus one misplaced piece of async (`ui/composer.ts` driving `repo.acpPrompt`). Removing them turns the store graph into a DAG with `repo` as the top-level orchestrator — the shape the rules already describe ("the repo lifecycle calls `ui.onRepoSwitched()`").

Jira: none yet. Process: frontend only (`src/store` plus one feature test); no Rust, no IPC. `skip_specs: true` — a behaviour-preserving refactor. Depends on `enforce-frontend-import-direction`, whose `bun run cycles` baseline is the progress meter and the regression guard.

## What Changes

- **Declare the store direction** in `architecture-rules-react.md` §1: leaves (`notifications`, `terminals`, `operation`, `selection`, `toolProbes`) < `ui` < `accounts` < `pulls` < `identities` < `repo`. A store imports only stores to its left. (`updates` and `forgeCredentials` sit right of `ui`/`accounts` respectively and are already acyclic.)
- **One late-bound leaf for everything that points up**: new import-free `src/store/links.ts` exporting `storeLinks = { openRepo, refreshRepo, listRemotes, reloadPulls }` — `openRepo()` returns the live `{ summary, remotes, forge }` (the only three fields any back-edge reads; unbound default: `{ summary: null, remotes: [], forge: null }`), the three verbs default to async no-ops. Its types are `import type` from `lib/api`, so the module has no runtime imports. `repo.ts` and `pulls.ts` bind them right after `create()`. Capped at these four entries by a rules sentence and a key-snapshot test.
- **Back-edge reads → `storeLinks.openRepo()`** in the 18 files: `ui.ts`, `ui/{navigator,toasts,terminalChrome}.ts`, `accounts.ts`, `accountsMigrations.ts`, `accounts/{credentials,ghAccounts,oauth,repoMutation,transportAuth}.ts`, `pulls/{list,writes}.ts`, `pullsActionOwner.ts`, `pullsResource.ts`, `identities/storage.ts`. Post-`await` staleness guards (`if (useRepo.getState().summary?.path !== path) return` — `accounts.ts:219,242`, `ui/toasts.ts:69`) keep reading the **live** value, which is why these cannot become function arguments.
- **Upward action calls → link verbs**: the 13 `listRemotes` / `loadPullRequests` / `refresh({ prs: false })` sites in `accounts*`, `pulls/writes.ts`, `ui/prView.ts`.
- **`ui/composer.ts` calls `api` directly**: `startAgentCommitDraft`/`cancelAgentCommitDraft` reached `acpPrompt`/`acpCancel` through `useRepo`, but those repo actions are pure pass-throughs to `api.acpPrompt`/`api.acpCancel` with no repo state behind them. The slice imports `api` instead (as `ui/toasts.ts` already does); nothing moves between stores and no component changes.
- **Slices stop importing their own facade**: `pulls/list.ts`, `pulls/writes.ts`, `accounts/repoMutation.ts` use the `get` that `create*Actions(set, get)` already receives.
- The `bun run cycles` baseline shrinks to `[]`.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- None — `skip_specs: true`: pure refactor; no user-, git- or IPC-observable behaviour changes.

## Impact

- Frontend store: new `src/store/links.ts` (+ test); the 18 files above; `src/store/repo.ts` and `src/store/pulls.ts` (bind links); `src/store/ui/{composer,prView}.ts`.
- Frontend features: no production file outside `src/store` changes — no action moves, no signature changes. `features/changes/commit-modal/CommitComposer.test.tsx` stubs `api.acpPrompt` instead of the repo action.
- Tests: store tests that seed `useRepo` so an `accounts`/`pulls`/`ui` action can see the open repo either keep doing so (importing `@/store/repo` binds the links) or bind `storeLinks.openRepo` directly and drop the repo mocks — the isolation this change exists to allow.
- Size ceiling: `accounts.ts` (384) only swaps call expressions — net zero lines. No other touched file is near the ceiling.
- Secrets/auth/IPC risk: none. No command or wrapper changes; `accounts` transport-auth resolution keeps its inputs, outputs and guards — only the expression that fetches the open repo changes. `storeLinks.openRepo()` exposes the same non-secret repo summary/remotes the stores already read; no credential passes through `links.ts`.
- Pattern to copy: `repo.ts` slices (`create*Actions(set, get)` — none imports `useRepo`); `ui.onRepoSwitched()` as the existing top-down notification.

## Non-goals

- Merging or splitting stores, changing any store's state shape, action signatures, or persistence keys.
- An event bus, a `services/` layer, or reactive cross-store subscriptions.
- Reducing forward `getState()` calls — `repo → ui` stays as is.
- Growing `links.ts` into a general service locator: four entries, fixed.
- Reworking feature-to-feature imports.
