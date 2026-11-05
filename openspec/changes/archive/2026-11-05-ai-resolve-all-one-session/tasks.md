# Tasks

Frontend only (`src/features/conflicts/ai-resolve/`). No Rust, IPC, or store change.

## 1. Prompt and answer model (`aiResolveModel.ts`)

- [x] 1.1 Replace `buildResolvePrompt` with a multi-file builder: each target as `=== FILE: <path> ===` … `=== END FILE ===`, with its note beside it, keeping the read-only instructions, plus an answer-format instruction using the same sentinels. Verify with `aiResolveModel.test.ts` cases for one file, three files, and a note on one file only.
- [x] 1.2 Add `splitResolvedAnswer(answer, paths)` that returns, per requested path, `{ text }` or `{ error }`. Match by exact path at line start, ignore unknown paths, return "The agent didn't return this file." for a missing block, and run the existing empty and marker checks on each body. Remove the fence-unwrap helpers. Verify with tests for a missing block, markers in one block, reordered blocks, an unknown path, and a Markdown body that contains fences.
- [x] 1.3 Add `MAX_SWEEP_BYTES` with a `shortcut:` comment and a pure `sweepTooLarge(contents)` check. Verify with tests just under and just over the budget.

## 2. Run model (`useAiResolveRuns.ts`)

- [x] 2.1 Replace the per-path queue and `CONCURRENCY` workers with one job per `start` call: read every target, skip binaries with their existing per-file error, refuse over budget (no run state, an error the caller can show), one `acpPrompt` call, then land per path with the existing stale re-read and `applyToEditor`. Verify with `useAiResolveRuns.test.tsx`: three paths make exactly one `acpPrompt` call whose prompt contains all three.
- [x] 2.2 Share one `runId` across a job's paths. `clear(path)` bumps only that token and calls `acpCancel` only when no path of the job is still live. Repo switch and unmount still cancel everything. Verify with tests: stopping one of three keeps the run and the other two land; stopping all three calls `acpCancel` once.
- [x] 2.3 Cover per-file landing outcomes in `useAiResolveRuns.test.tsx`: one missing block, one stale file and one good file in the same answer each get the right state. Update the existing tests that assumed one call per file or three-at-a-time queueing.
- [x] 2.4 Update the header comment in `useAiResolveRuns.ts` (it still describes the three-at-a-time sweep) and check that `bun run sizes` passes for the touched files.

## 3. UI (`AiConflictResolve.tsx`)

- [x] 3.1 Show the over-budget refusal from "Resolve all" ("Too large for one pass — resolve files individually"). The per-file button keeps calling `start` with a set of one. Verify with an `AiConflictResolve.test.tsx` case that an oversized "Resolve all" shows the message and starts no prompt.

## 4. Integration checks

- [x] 4.1 Run `bun check`, `bun run lint`, `bun run test`, `bun run build`, `bun run sizes` and `bun run cycles`, and confirm they all pass.
- [x] 4.2 (moved to `docs/manual-verification-backlog.md`, Sitting A, with the user's agreement) Manually, in `bun run tauri dev`: build a merge with three text conflicts (one Markdown file with fences), run "Resolve all" with an ACP agent, and confirm one adapter process starts (`ps` while it runs), every file lands a proposal, and stopping one file mid-run leaves the others landing.
