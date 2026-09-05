## Context

Vitest 4.1 runs two projects (`node`, `happy-dom`); a root `--coverage` run merges both into one report. Rust has 1178 unit tests and no integration-test directory; `cargo llvm-cov` needs the `llvm-tools` rustup component on the pinned 1.97.1 toolchain. CI already installs a cargo tool with `--locked` and caches it (`cargo-audit` in `security`), and already splits Rust lanes between the self-hosted Linux runner (warm cache) and a GitHub-hosted leg. The sizes ratchet (`check-file-sizes.mjs`, baseline JSON, `sizes`/`sizes:update`) is the pattern the team already trusts for "known debt may not grow".

## Goals / Non-Goals

**Goals:**
- One command and one CI step per side that produce a per-file number.
- A ratchet that fails only on regression and updates itself on improvement.
- The first tests aimed by the report rather than by file size.

**Non-Goals:**
- Branch-coverage precision, global thresholds, external dashboards, E2E.

## Decisions

1. **v8 provider over istanbul** — no Babel instrumentation, faster, and accurate enough for line and function ratchets; istanbul only matters for branch-level precision in TSX, which is not gated.
2. **Per-file ratchet, not a global threshold** — a global number hides regressions in the modules that matter (stores and the write layer); the per-file rule mirrors the sizes ratchet. New-file floor: 60 % lines (a constant in the script). Exemptions reuse the sizes script's `EXEMPT` list plus `*.d.ts`, `src/test/**`, `src/components/ui/icons.tsx`, generated code.
3. **Rust is non-gating first** — llvm-cov numbers move with inlining and `#[cfg]` boundaries; collect four weeks of data, then extend `check-coverage.mjs` to read lcov and ratchet the same way. The job-summary table (module → lines %) is the immediate value.
4. **Where it runs** — frontend: the `frontend` job always, measured first; fallback gate `needs.changes.outputs.trusted == 'true'` if the wall time is unacceptable. Rust: only the GitHub-hosted `rust-tests` leg, so the self-hosted box's cargo cache stays free of profiling artifacts. Alternative considered: Codecov upload — adds an external service and a token; rejected for now, revisit if PR annotations are wanted.
5. **Targets chosen by the first report** — the proposal's candidates are the audit's best guess; the task list requires reading the report before writing tests so effort goes to real gaps. New tests go through the store facades (`@/store/repo`, `@/store/accounts`) with the inline `invoke` mock, and under `git/write/tests/` for Rust, matching where the existing suites live.

## Risks / Trade-offs

- [Coverage slows the `frontend` job] → measure in the first PR; the job takes ~5 minutes today with a 15-minute timeout; gate to trusted runs if needed.
- [Baseline churn on refactors and file moves] → improvements auto-update via `coverage:update`; only drops fail; a moved file needs its baseline key renamed in the same PR (documented in `src/test/README.md`).
- [`llvm-tools` component on the pinned toolchain] → added to `rust-toolchain.toml`; local `cargo check` is unaffected; the self-hosted runners pick it up through `rustup` via `setup-rust` on their next run.
- [A flaky or failing run must never lower the bar] → the baseline is written only by an explicit `coverage:update` on a green run, never by CI.

## Migration Plan

PR 1: frontend tooling + baseline (no new tests) — CI green by construction. PR 2: Rust llvm-cov step + summary. PR 3+: targeted tests, each raising a baseline entry. Rollback is a revert of any single PR; the baseline file makes CI tolerant of partial progress.
