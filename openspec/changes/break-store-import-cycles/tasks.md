## 0. Precondition

- [x] 0.1 `enforce-frontend-import-direction` is in place (committed on `chore/enforce-frontend-import-direction`; this work is stacked on that branch rather than waiting for the merge); verify `bun run cycles` exists and reports 55 known files

## 1. `links.ts` and `ui` leaves the cycle (PR 1)

- [x] 1.1 Create `src/store/links.ts` (runtime-import-free; `import type` only) exporting `storeLinks = { openRepo, refreshRepo, listRemotes, reloadPulls }` with the empty-snapshot / async no-op defaults from design.md §2; bind `openRepo`/`refreshRepo`/`listRemotes` in `src/store/repo.ts` and `reloadPulls` in `src/store/pulls.ts` right after `create()`; verify `grep -E "^import " src/store/links.ts | grep -vc "^import type"` prints 0
- [x] 1.2 Add `src/store/links.test.ts`: `Object.keys(storeLinks)` equals the four names; unbound `openRepo()` returns `{ summary: null, remotes: [], forge: null }`; after importing `@/store/repo` and `@/store/pulls`, `openRepo()` reflects `useRepo.setState` and `reloadPulls` calls `loadPullRequests`; verify `bun run test -- src/store/links` passes
- [x] 1.3 Replace `useRepo.getState().summary?.path` with `storeLinks.openRepo().summary?.path` at the same call point in `ui.ts:300`, `ui/navigator.ts:43`, `ui/toasts.ts:69`, `ui/terminalChrome.ts:69,127,162`; drop their `useRepo` imports; verify `grep -rnE 'store/repo"|"\./repo"' src/store/ui.ts src/store/ui/` lists only `ui/composer.ts`
- [x] 1.4 `ui/composer.ts`: call `api.acpPrompt` / `api.acpCancel` directly instead of `useRepo.getState().acpPrompt/acpCancel` (those repo actions are pure pass-throughs — design.md §3, revised; nothing moves between stores); switch the composer tests in `src/store/ui.test.ts` and `features/changes/commit-modal/CommitComposer.test.tsx` to `vi.spyOn(api, …)`; verify the commit-modal and ui store tests pass and `ui/composer.ts` no longer imports `useRepo`
- [x] 1.5 `ui/prView.ts:63`: call `storeLinks.reloadPulls()` instead of `usePulls.getState().loadPullRequests()`; verify the PR-list filter tests pass and `src/store/ui/` has no import of `@/store/pulls`
- [x] 1.6 Fix `ui` store tests that relied on `vi.mock("@/store/repo")` to set `storeLinks.openRepo` instead; run `bun run cycles:update`; verify the baseline drops by exactly the six `src/store/ui*` files

## 2. Own-facade imports and `pulls → repo` (PR 2)

- [x] 2.1 (as built: `createPrWriteActions(set, get)` threads `set` into `runPrAction`, the last `usePulls.setState` user; `captureRepoMutationTarget` is a plain helper, not a slice creator, so it takes `repoBindingKey` from its five callers' `get()` — typed by a local `RepoBindingKeyRead`) In `pulls/list.ts`, `pulls/writes.ts`, `accounts/repoMutation.ts` replace `usePulls.getState()` / `useAccounts.getState()` with the `get` passed to the slice creator (thread `get` into module-level helpers such as `pulls/list.ts:33`'s request-id check); verify none of the three imports its own facade
- [x] 2.2 Replace `useRepo.getState().summary` reads with `storeLinks.openRepo().summary` in `pulls/list.ts`, `pulls/writes.ts:197`, `pullsActionOwner.ts:26,46`, `pullsResource.ts:30,212`, and `useRepo.getState().refresh({ prs: false })` with `storeLinks.refreshRepo({ prs: false })` at `pulls/writes.ts:118,133`; verify `grep -rn "useRepo" src/store/pulls src/store/pulls*.ts | grep -v '\.test\.'` prints nothing (the in-app "merging a PR still refreshes the graph" check moved to the manual task 3.4; the pulls store tests cover the `refresh` call through the link)

## 3. `accounts` (PR 3)

- [x] 3.1 Replace the `useRepo.getState().{summary,remotes,forge}` reads with `storeLinks.openRepo().…` — each at the exact point of the old call, never hoisted above an `await` — in `accounts.ts` (159, 169, 219, 242, 335, 346, 357), `accountsMigrations.ts`, `accounts/transportAuth.ts` (33, 35, 159, 217), `accounts/repoMutation.ts` (23, 26, 32), `accounts/oauth.ts` (193), `accounts/ghAccounts.ts` (126, 132), `accounts/credentials.ts`; verify `bunx tsc --noEmit` passes and the PR diff shows no guard moved relative to its `await`
- [x] 3.2 Replace upward calls: `listRemotes` at `accounts.ts:305,331`, `accountsMigrations.ts:127`, `accounts/oauth.ts:160,195`, `accounts/credentials.ts:165,258` → `storeLinks.listRemotes()`; `loadPullRequests` at `accounts.ts:308,367`, `accounts/ghAccounts.ts:132` → `storeLinks.reloadPulls()`; verify `grep -rnE "use(Repo|Pulls)\b" src/store/accounts.ts src/store/accountsMigrations.ts src/store/accounts/ | grep -v '\.test\.'` prints nothing
- [x] 3.3 Update accounts store tests to bind `storeLinks.openRepo`/spy the verbs instead of mocking `@/store/repo`/`@/store/pulls`; verify `bun run test -- src/store/accounts` passes and at least one accounts test file drops a repo-only `lib/api` mock
- [ ] 3.4 (NOT RUN — needs a human: real provider sign-ins) Manual in `bun run tauri dev`: merge a PR and confirm the graph refreshes; bind an account to a remote in the Remotes picker (remote URL username updates, PR list reloads for the default remote), fetch over HTTPS, provider-token sign-in, OAuth sign-in then switch repo tabs before it completes (no remotes refresh lands on the wrong tab); verify each matches `latest`
- [x] 3.5 Run `bun run cycles:update`; verify the `accounts*` and `pulls*` files (15) leave the baseline

## 4. `identities`, zero baseline, rules (PR 4)

- [x] 4.1 `identities/storage.ts:131,137`: read `storeLinks.openRepo().summary`; verify `src/store/identities*` has no `useRepo` import and the identities tests pass
- [x] 4.2 Run `bun run cycles:update`; verify `scripts/import-cycle-baseline.json` is `[]` and `bun run cycles` prints "0 known file(s)"
- [x] 4.3 Add `STORE_DIRECTION` to `eslint.config.js` (`no-restricted-imports` per store folder/file group forbidding stores to its right) so the direction is lint-enforced, not only cycle-enforced (a `regex` pattern, because top-level store files import siblings as `./repo`; `allowTypeImports`; `repoRequests` exempt — an import-free leaf that `pullsActionOwner.ts` uses); verify adding `import { useRepo } from "@/store/repo"` to `src/store/accounts/oauth.ts` fails `bun run lint`
- [x] 4.4 Update `docs/rules/architecture-rules-react.md` §1 with the store direction and `links.ts` as the only sanctioned upward channel (four named entries, getter-not-copy, never cache across an `await`); update `CLAUDE.md`'s store section ("Cross-store reads…") to match; verify neither doc still describes a back-edge that no longer exists

## 5. Definition of done (every PR)

- [x] 5.1 `bunx tsc --noEmit`, `bun run lint`, `bun run test`, `bun run build`, `bun run sizes`, `bun run cycles` and `openspec validate break-store-import-cycles --strict` all pass; `bun run cycles` reports no added file
