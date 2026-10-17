## 1. Frontend coverage (PR 1)

- [x] 1.1 Add `@vitest/coverage-v8` (matching the installed Vitest 4.1.x) as a devDependency and a `test:coverage` script (`vitest run --coverage`); configure `test.coverage` in `vitest.config.ts` (provider `v8`, reporters `text-summary` + `json`, `include: ["src/**"]`, `exclude` for tests, `src/test/**`, `*.d.ts`, `icons.tsx`); verify `bun run test:coverage` writes `coverage/coverage-final.json` containing files from both projects — done 2026-10-16 with `@vitest/coverage-v8` 5.0.5 (exact, matches Vitest 5.0.5) and the `json-summary` reporter (`coverage/coverage-summary.json`), which already carries per-file line %; 760 files from both projects
- [x] 1.2 Write `scripts/check-coverage.mjs` plus `coverage` and `coverage:update` scripts, reading `coverage/coverage-final.json` and comparing per-file line % against `scripts/coverage-baseline.json` with the sizes-script semantics and shared `EXEMPT` list; verify `scripts/check-coverage.test.ts` covers "drop fails", "improvement updates the baseline", "new file below the floor fails", "exempt path ignored" — improvements are reported and recorded only by an explicit `coverage:update` (Risks: CI never writes the baseline)
- [x] 1.3 Generate the initial baseline with `bun run coverage:update` and commit it; verify `bun run coverage` prints "none regressed"
- [ ] 1.4 Add the coverage run and check to the `frontend` job in `ci.yml` and record the wall-time delta in the PR description; verify the job stays under its 15-minute timeout, else add a `trusted` output on `changes` (the `TRUSTED_CI_USER` runner check) and gate the coverage step on that — ci.yml edited; local delta 24.8s → 28.6s (+15 %). The CI wall time is unverified until the first run (the job timeout is 25 min today)

## 2. Rust coverage (PR 2)

- [ ] 2.1 Add `llvm-tools` to `rust-toolchain.toml` components and a `cargo llvm-cov --lib --lcov --output-path lcov.info` step (cargo-llvm-cov installed `--locked` and cached like cargo-audit) to the GitHub-hosted `rust-tests` leg, uploading `lcov.info` as an artifact; verify the step is green and the artifact is attached to the run — implemented as its own report-only `rust-coverage` job (see design "Implementation notes"); the exact commands ran green locally with cargo-llvm-cov 0.9.1. A green CI run and the attached artifact are still unverified
- [ ] 2.2 Render a per-module lines-% table from the lcov file into `$GITHUB_STEP_SUMMARY`; verify rows for `git/write/lifecycle`, `git/write/patch_staging`, and `git/forge/*` appear — uses `cargo llvm-cov report --summary-only` (a per-file table, rows include those paths locally); unverified in a CI job summary

## 3. First measured targets (PR 3+)

- [x] 3.1 Read the first frontend report and pick the three lowest-covered files over 200 lines under `src/store` and `src/features`; add tests through the store facades with the inline `invoke` mock per `src/test/README.md`; verify each file's line % rises and `bun run coverage:update` moves its baseline entry up — `store/repoWriteActions/files.ts` 30 → 90 %, `features/agents/AiAgentRow.tsx` 65 → 95 %, `features/conflicts/conflict-workspace/ConflictWorkspace.tsx` 69.6 → 86.1 %
- [x] 3.2 Read the Rust summary and add tests under `git/write/tests/` for the two lowest `git/write` modules; verify the `cargo test` count increases and the summary row rises — `lifecycle/init.rs` 54.2 → 94.8 %, `state_lease.rs` 69.0 → 73.6 % (the rest is defensive canonicalize-failure paths); +11 tests

## 4. Docs and definition of done

- [x] 4.1 Document `test:coverage`, `coverage`, and `coverage:update` and the ratchet rule in `src/test/README.md`, `docs/rules/architecture-rules.md` §3, and CLAUDE.md's command list; record the dev-dependency decision in `docs/tauri-plugin-decisions.md`; verify each command named in the docs runs
- [x] 4.2 `bunx tsc --noEmit`, `bun run lint`, `bun run test`, `bun run build`, `bun run sizes`, `(cd src-tauri && cargo fmt --all -- --check && cargo clippy --all-targets --all-features -- -D warnings && cargo test)`, and `openspec validate add-coverage-measurement --strict` all pass
