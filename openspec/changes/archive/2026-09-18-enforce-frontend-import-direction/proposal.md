## Why

The frontend layering (`components/ui` → nothing, `lib` → nothing above it, `store` → `lib`, `features`/`chrome` → everything) is described in `CLAUDE.md` and `docs/rules/architecture-rules-react.md`, but only two edges of it are enforced: `eslint.config.js` restricts `components/ui/**` (`UI_PURITY`, GL-58) and raw `invoke`. Nothing stops `src/lib/**` from importing a store, `src/store/**` from importing a feature, or any module from closing an import cycle. A 2026-09-18 audit measured the result:

- **One 55-file runtime import cycle (strongly connected component) covering every domain store** — `repo`, `ui`, `accounts`, `pulls`, `identities` and all their slices (`store/repoWriteActions/*`, `store/ui/*`, `store/accounts/*`, `store/pulls/*`, …). `CLAUDE.md` calls these stores "orthogonal"; at the module level they are a single unit. `madge` lists it as 42 distinct cycles. Type-only imports are excluded from both numbers.
- Three layer leaks, all `import type`: `src/lib/theme.ts` → `@/store/ui` (`Theme`), `src/lib/worktreeHandoff.ts` → `@/store/ui` (`HandoffRequest`, `PromptOption`), `src/store/ui/dialogs.ts` → `@/features/agents/ai-actions/aiActions` (`AiActionScope`).
- Everything else is clean: no runtime cycle outside `src/store`, no `lib → features/components`, no `components/ui → store/features`, no `hooks → features`.

The graph is healthy except for one knot, and nothing keeps it that way. This change adds the missing guard (cheap, lands first); untying the knot is the sibling change `break-store-import-cycles`, which ratchets against the baseline introduced here.

Jira: none yet (GL-368 "Hygiene sweep — dead ESLint grants…" touches the same `eslint.config.js` but not these rules). Process: frontend tooling + docs only; no Rust, no IPC. `skip_specs: true` — lint/tooling rules and three type moves; no user- or git-observable behaviour.

## What Changes

- **Layer rules in ESLint (no new dependency).** Extend the existing `no-restricted-imports` blocks in `eslint.config.js`:
  - `src/lib/**` (including `lib/api`) may not import `@/store/**`, `@/features/**`, `@/components/**`, `@/app-shell/**`, `@/hooks/**`.
  - `src/store/**` may not import `@/hooks/**`, `@/features/**`, `@/components/**`, `@/app-shell/**` (hooks sit above stores: 6 hooks import a store, no store imports a hook).
  - `src/hooks/**` may not import `@/features/**`, `@/components/**`, `@/app-shell/**`.
- **Fix the three leaks** by moving each type to the lower layer and re-exporting from its old home so no consumer changes: `Theme` → `src/lib/theme.ts`; `HandoffRequest` → `src/lib/worktreeHandoff.ts`; `PromptOption` → `src/lib/ui.ts` (the generic prompt-combobox option — `lib/ui.ts` already hosts view types the ui store owns); `AiActionScope` (+ the scope-kind types it needs) → `src/lib/aiActionScope.ts`.
- **Import-cycle ratchet**: `scripts/check-import-cycles.mjs` + `scripts/import-cycle-baseline.json`, the same shape as `scripts/check-file-sizes.mjs` — it lists tracked `src/**/*.ts(x)` via `git ls-files`, builds the runtime import graph (skipping `import type` / `export type`), computes strongly connected components (Tarjan), and fails when a file that is not in the baseline is part of a cycle. `bun run cycles` / `bun run cycles:update`; wired into `ci.yml`'s `frontend` job right after lint (a cycle can only appear when `src/**` changes, which is that job's gate; `sizes` has its own job because it also covers Rust).
- **Rule text**: a new "Import direction" subsection in `docs/rules/architecture-rules-react.md` §1/§2 stating the layer table and "no new runtime import cycles", a line in the §"Review gate", and `bun run cycles` in `CLAUDE.md`'s command list. Correct `CLAUDE.md`'s "stores are orthogonal" sentence to say what is true today (no reactive cross-store subscriptions) and point at the ratchet.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- None — `skip_specs: true`: lint rules, a CI script, three type relocations with re-exports, and docs.

## Impact

- Tooling: `eslint.config.js`, `scripts/check-import-cycles.mjs`, `scripts/check-import-cycles.test.ts`, `scripts/import-cycle-baseline.json` (55 entries on day one), `package.json` scripts, `.github/workflows/ci.yml`.
- Frontend: `src/lib/theme.ts`, `src/lib/ui.ts`, `src/lib/worktreeHandoff.ts`, new `src/lib/aiActionScope.ts`, `src/store/ui/appearance.ts`, `src/store/ui/dialogs.ts`, `src/features/agents/ai-actions/aiActions.ts` (type moves + re-exports only).
- Docs: `docs/rules/architecture-rules-react.md`, `CLAUDE.md`.
- Dependencies: **none added.** `madge` was used for the audit via `bunx` only; the ratchet is a ~80-line script over `git ls-files` + a regex import scan, because lint already bans parent-relative imports (`PARENT_RELATIVE_IMPORT`), so every specifier is `@/…` or `./…` and trivially resolvable.
- Secrets/auth/IPC risk: none. No command, wrapper, store state, or persisted setting changes.
- Pattern to copy: `scripts/check-file-sizes.mjs` (+ its test and baseline JSON) for the ratchet; the `UI_PURITY` pattern group in `eslint.config.js` for the layer rules.

## Non-goals

- Breaking the store cycle itself (that is `break-store-import-cycles`).
- Feature-to-feature import rules. Folder-level bidirectional pairs exist (`changes ↔ agents`, `agents ↔ terminal`, `changes ↔ review`) but form no file-level cycle; see design.md.
- Banning `components/chrome → features` — chrome composes features by design.
- Adding `eslint-plugin-import`, `madge`, or `dependency-cruiser` as a devDependency.
