## Context

See proposal.md — Why. Engine: none (no git read/write/forge work). Store: none changes state; `store/ui/appearance.ts` and `store/ui/dialogs.ts` lose three type declarations and re-export them. No folder-module split is due; every touched file stays under the 400-line ceiling (`eslint.config.js` is 185 lines and exempt from `sizes`).

Existing enforcement to build on (`eslint.config.js`): `restrict()` wraps the core `no-restricted-imports`; pattern groups `UI_PURITY`, `API_OBJECTS`, `WRAPPED_INVOKE`, `PARENT_RELATIVE_IMPORT`; one flat-config block per folder. `bun run lint` already runs in `ci.yml` ("architecture import boundaries"). Because `PARENT_RELATIVE_IMPORT` bans `../`, every in-repo specifier is `@/<path>` or `./<path>`.

## Goals / Non-Goals

**Goals:**

- A layer leak or a new import cycle fails CI with a message naming the file.
- The existing 55-file store cycle is recorded as known debt that can only shrink.
- Zero new dependencies; zero consumer-visible type changes.

**Non-Goals:**

- Detecting cycles through dynamic `import()` or through `vi.mock` factories.
- Policing test files (`*.test.ts(x)`, `src/test/**`) — they may import anything.

## Decisions

### 1. Layer rules stay in `no-restricted-imports`; type imports are not exempt

Add three pattern groups (`LIB_PURITY`, `STORE_PURITY`, `HOOKS_PURITY`) next to `UI_PURITY` and one block per folder. Flat-config blocks for the same file *replace* a rule's options rather than merge them, so each new block must re-list the patterns the general `src/**` block applies (`API_OBJECTS`/`WRAPPED_INVOKE`/`PARENT_RELATIVE_IMPORT` as appropriate) — copy how the `src/components/ui/**` block does it. `src/lib/api/**` has its own later block, which therefore replaces whatever the `src/lib/**` block set — so `LIB_PURITY` is added to the `src/lib/api/**` block's patterns as well (and to `src/lib/api/invoke.ts`'s). Both are clean today (`grep -rnE '"@/(store|features|components|hooks)' src/lib` finds only the two type imports this change removes), so the rule is free.

Type-only imports are restricted too. Alternative: switch to `@typescript-eslint/no-restricted-imports` with `allowTypeImports: true` — rejected: a `lib` type that names a store type still makes `lib` unreadable without the store, and only three such imports exist, each fixed by moving ~10 lines down a layer.

### 2. Moved types are re-exported from their old module

`store/ui/appearance.ts` does `export type { Theme } from "@/lib/theme"`, etc. 16 non-test files name these types and 12 import them from the old paths (5 from `@/store/ui`, 7 from `@/features/agents/ai-actions`); re-exporting keeps this change to seven files. `AiActionScopeKind` (a `const` object) and the pure helpers `scopeCommits`/`scopeIncludesWorking`/`unhandledScope` move with `AiActionScope` to `src/lib/aiActionScope.ts`; `aiActions.ts` re-exports them with `export * from`.

### 3. Cycle ratchet: hand-rolled SCC script, not a dependency

`scripts/check-import-cycles.mjs`, modelled line-for-line on `check-file-sizes.mjs`:

- `trackedSources()` — `git ls-files 'src/*.ts' 'src/*.tsx'` minus tests, `src/test/**`, `*.d.ts`.
- Import scan — one multiline regex over `import`/`export … from` statements; statements beginning `import type` / `export type` are skipped. Resolve `@/x` → `src/x` and `./x` relative, trying `.ts`, `.tsx`, `/index.ts`, `/index.tsx`.
- Tarjan SCC; every file in a component of size > 1 is "in a cycle".
- Baseline = sorted file list. Fail when a file outside the baseline is in a cycle; print a notice (not a failure) when a baseline file no longer is, prompting `bun run cycles:update`. `--update` rewrites the baseline.

The metric is **SCC membership, not a cycle count**: `madge --circular` reports 42 or 63 cycles for the same graph depending on traversal and options, so a count would be an unstable ratchet; membership is deterministic and answers the useful question ("did this PR pull a new file into the knot?"). A prototype of this script reproduced the audit numbers (737 files, 1 SCC, 55 members) in under a second.

Alternatives: `madge` devDependency — adds ~90 transitive packages for what 80 lines do; `eslint-plugin-import`'s `no-cycle` — new plugin, slow on 1 000 files, and has no baseline concept so it would need 55 disable comments. Inline `import { type X }` specifiers in an otherwise value-less import are counted as runtime edges (false positive, conservative); if one ever matters, write it as `import type`.

### 4. Feature-to-feature imports: documented, not enforced

Measured pairs: `changes ↔ agents` (4/4), `agents ↔ terminal` (3/3), `changes ↔ review` (5/2). None forms a file-level cycle, so the ratchet passes. The root cause is misplaced ownership (`agentRun.ts`, `AgentRunStatus`, `AgentActionControl` live in `features/changes` but are agent UI; `agentRowParts` lives in `features/terminal` but is consumed by `features/agents`). That is a move-files change with no guard to write; it is left as backlog rather than inventing a feature-dependency matrix nobody asked for.

## Risks / Trade-offs

- Regex import scanning can miss exotic syntax (multi-line `export {…} from` is covered; template-literal dynamic imports are not) → acceptable: the ratchet is a tripwire, `tsc` remains the source of truth, and the script's test pins the syntaxes used in this repo.
- A 55-entry baseline normalises the debt → mitigated by the sibling change, whose tasks each end with "baseline shrinks".
- Flat-config option replacement could silently drop an existing restriction from `src/store/**` → task 1.4 asserts the old violations still fail via a fixture check.
