## 1. Layer rules (PR 1)

- [x] 1.1 Move `Theme` to `src/lib/theme.ts` and re-export it from `src/store/ui/appearance.ts`; move `HandoffRequest` to `src/lib/worktreeHandoff.ts` and `PromptOption` to `src/lib/ui.ts` (it is the generic prompt-combobox option, not a handoff type; `lib/ui.ts` already hosts view types the ui store owns) and re-export them from `src/store/ui/dialogs.ts`; verify `grep -rn "@/store" src/lib --include='*.ts' | grep -v '\.test\.' | grep -v 'lib/api'` prints nothing and `bunx tsc --noEmit` passes
- [x] 1.2 Create `src/lib/aiActionScope.ts` with `AiActionScopeKind`, `AiActionScope`, `scopeCommits`, `scopeIncludesWorking`, `unhandledScope` moved verbatim from `src/features/agents/ai-actions/aiActions.ts`; `aiActions.ts` re-exports them; `src/store/ui/dialogs.ts` imports from `@/lib/aiActionScope`; verify `grep -rn "@/features" src/store | grep -v '\.test\.'` prints nothing and `bun run test -- src/features/agents` passes
- [x] 1.3 In `eslint.config.js` add `LIB_PURITY`, `STORE_PURITY`, `HOOKS_PURITY` pattern groups beside `UI_PURITY` and one block each for `src/lib/**`, `src/store/**` (extend the existing block), `src/hooks/**`, plus `LIB_PURITY` appended to the existing `src/lib/api/**` and `src/lib/api/invoke.ts` blocks (later blocks replace rule options, so `lib/api` would otherwise be unguarded), each re-listing the patterns that block already enforced; verify `bun run lint` passes on the tree
- [x] 1.4 Prove the rules bite: temporarily add `import { useUi } from "@/store/ui"` to `src/lib/paths.ts`, `import "@/features/graph/palette"` to `src/store/repo.ts`, and `import { invoke } from "@tauri-apps/api/core"` to `src/store/repo.ts`; verify `bun run lint` reports all three, then revert

## 2. Cycle ratchet (PR 2)

- [x] 2.1 Write `scripts/check-import-cycles.mjs` with exported `trackedSources()`, `importGraph(files)`, `cycleMembers(graph)` and a `--update` flag, mirroring `scripts/check-file-sizes.mjs`; verify `node scripts/check-import-cycles.mjs --update` writes `scripts/import-cycle-baseline.json` with 55 paths, all under `src/store/`
- [x] 2.2 Add `scripts/check-import-cycles.test.ts`: a two-file value cycle is reported; the same cycle through `import type` is not; `export { x } from "./b"` counts as an edge; `@/` and `./` specifiers resolve to `.ts`, `.tsx` and `/index.ts`; test files are excluded; verify `bun run test -- scripts` passes
- [x] 2.3 Add `"cycles"` and `"cycles:update"` to `package.json` and a `bun run cycles` step after lint in the `frontend` job of `.github/workflows/ci.yml` (not beside `sizes`: that check has its own job because it also covers Rust, while a cycle can only appear when `src/**` changes — the `frontend` gate); verify `bun run cycles` prints "55 known file(s) in import cycles, none added" and exits 0
- [x] 2.4 Prove the ratchet bites: temporarily add `import { usePulls } from "@/store/pulls"` to `src/store/notifications.ts`; verify `bun run cycles` fails naming `src/store/notifications.ts`, then revert

## 3. Rules and docs (PR 2)

- [x] 3.1 Add an "Import direction" subsection to `docs/rules/architecture-rules-react.md` (layer table: `lib` < `store` < `hooks` < `features`/`components/chrome`/`navigation` < `app-shell`, with `components/ui` beside `store` — measured at apply time: 6 hooks import stores, no store imports a hook, so `STORE_PURITY` also bans `@/hooks/**`; "no new runtime import cycle — `bun run cycles`"), one line in its "Review gate", and one ❌ entry in "Anti-patterns (frontend)"; verify each rule sentence names the ESLint group or script that enforces it
- [x] 3.2 In `CLAUDE.md`: add `bun run cycles` to the Commands block and reword the "Keeping the stores orthogonal…" sentence to state the enforced facts (no reactive cross-store subscriptions; module cycles are ratcheted and being removed in `break-store-import-cycles`); verify no sentence still claims the stores are import-independent

## 4. Definition of done (every PR)

- [x] 4.1 `bunx tsc --noEmit`, `bun run lint`, `bun run test`, `bun run build`, `bun run sizes`, `bun run cycles` (PR 2) and `openspec validate enforce-frontend-import-direction --strict` all pass
