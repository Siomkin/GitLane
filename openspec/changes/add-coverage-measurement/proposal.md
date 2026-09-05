## Why

GitLane has 306 frontend test files, 1178 Rust `#[test]`s, an IPC smoke test, and a size ratchet — but no coverage measurement at all: no `@vitest/coverage-*` package, no `cargo-llvm-cov` or `tarpaulin` step in CI. Nobody can say which store slices, write modules, or forge transports the suites actually exercise, and co-location is not a proxy: `src/store/repoRefreshActions.ts` (392 lines) has no test that imports it directly yet is driven through the 88 test files that import `@/store/repo`, while `src-tauri/src/git/write/lifecycle/clone.rs` (373 lines) and `git/write/patch_staging/` appear only in fetch and support tests. The last three audits (GL-341, GL-366, `raise-command-test-coverage`) each hand-counted test files; a measured, per-file ratchet replaces guessing with a number that cannot regress unnoticed.

No Jira key (GL-xx) for this change. Touches tooling (`package.json`, `vitest.config.ts`, `scripts/`, `.github/workflows/ci.yml`, `rust-toolchain.toml`) and adds tests; no product behaviour change, so this change sets `skip_specs: true`.

## What Changes

- Frontend: add `@vitest/coverage-v8` (dev-only, pinned to the Vitest 4.1 line), a `test:coverage` script, and `scripts/check-coverage.mjs` — a per-file line-coverage ratchet with `scripts/coverage-baseline.json`, same shape and semantics as `scripts/check-file-sizes.mjs` (a file may not drop below its baseline; improvements update the baseline; new files must meet a floor; exempt list shared with the sizes script).
- Rust: run `cargo llvm-cov --lib --lcov` in the GitHub-hosted `rust-tests` lane (`llvm-tools` added to `rust-toolchain.toml` components), upload the lcov file as a job artifact, and render a per-module lines-% table into the job summary. Non-gating for the first month; ratcheted with the same script once the numbers are stable.
- First measured targets: the three lowest-covered files over 200 lines under `src/store` and `src/features`, and the two lowest `git/write` modules, get tests through their public seams — chosen from the first report, not guessed (audit candidates: `store/repoFilesActions.ts`, `store/repoSelection/commits.ts`, `store/accounts/credentials.ts`; `git/write/lifecycle/clone.rs`, `git/write/patch_staging/extract.rs`).
- Docs: `src/test/README.md`, `docs/rules/architecture-rules.md` §3, and CLAUDE.md's command list gain the coverage commands and the ratchet rule; `docs/tauri-plugin-decisions.md` records the dev-dependency decision.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- None — `skip_specs: true`: tooling and tests only; no user- or git-observable behaviour changes.

## Impact

- Dependencies: one dev package (`@vitest/coverage-v8`) with no runtime, bundle, or CSP surface; `cargo-llvm-cov` is installed in CI only (`cargo install --locked`, cached like `cargo-audit` in the `security` job).
- CI: the `frontend` job runs the suite under coverage (expected 1.5–2× test wall time, measured in task 1.4; if it threatens the 15-minute timeout, coverage runs only on `latest` pushes and trusted PRs); the GitHub-hosted `rust-tests` leg gains one step and one artifact.
- Secrets/auth/IPC risk: none.
- Pattern to copy: `scripts/check-file-sizes.mjs` + `file-size-baseline.json` + the `sizes`/`sizes:update` scripts; `ci.yml`'s `security` job for a cached `cargo install`; `src/test/README.md`'s inline `invoke` mock for the new tests.

## Non-goals

- A global percentage gate ("80 %") — per-file ratchet only.
- End-to-end or WebDriver tests (`tauri-driver` has no macOS support; `src-tauri/src/smoke.rs` remains the IPC round-trip check).
- Rewriting existing tests, or chasing 100 % on any file.
- Uploading to an external coverage service.
