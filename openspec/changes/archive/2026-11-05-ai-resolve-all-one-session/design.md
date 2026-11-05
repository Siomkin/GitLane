# Design

## Context

See proposal.md (Why). Today:

- `acp_prompt` (Rust, `src-tauri/src/acp.rs`) does one turn per call: spawn the adapter, open an ACP session, send one prompt, return one text answer, exit. The answer is capped at `MAX_ANSWER_BYTES` (1 MiB), and the turn times out after `TIMEOUT` (5 min).
- `useAiResolveRuns.ts` keeps a `Job` queue with one path per job and three drain workers. Each job is a separate `acp_prompt` call, so "Resolve all" with N files means N processes.
- `aiResolveModel.ts` builds a single-file prompt and unwraps a single fenced answer with `extractResolvedContent`, which rejects empty answers and leftover markers.
- Landing safety lives per file: `onReset` before a run, then the re-read stale check, then `applyToEditor`.

Engine: none of the read/write/forge engines change. This is an agent prompt, and its answer lands through the existing resolver write path (`resolveConflictFile`) after the user reviews it.

## Goals / Non-Goals

**Goals:** one `acp_prompt` call per resolve request, whatever the number of files. Every per-file guarantee that exists today (review before write, stale check, marker check, per-file error) stays per file.

**Non-Goals:** backend or IPC changes; streaming per-file results while the turn runs; deciding the resolution order across files.

## Decisions

### D1. One turn with all files, not a multi-turn session
One prompt carries every target file, and one answer is split per file.
- *Alternative:* a long-lived ACP session with one turn per file. That would need new open/prompt/close commands across all four IPC layers and a session handle that outlives a `blocking()` call. Rejected for now: the main gain, the agent seeing every file, is already here with a single turn.

### D2. Sentinel delimiters instead of fences
Prompt and answer both wrap each file as:
```
=== FILE: <path> ===
<body>
=== END FILE ===
```
Markdown bodies contain their own fences, and fences that are nested and back to back can't be split reliably. A sentinel line is matched only at line start and only with a path that was asked for. A file whose own content contains a sentinel line is never sent (see D6), so a block can't be split early by its own content.
- The old marker and empty checks apply to each block body. Bodies are asked for as raw text. A fence the agent adds anyway (optionally after one prose line) is unwrapped only when the source has no fence line of its own. Lines split on `\n` only, so CRLF bodies keep their endings and still align. A one-file request whose answer has no sentinel at all is taken as that file's body, the way the old single-file reply was read.

### D3. One parser, set size 1 included
The per-file button calls the same `start(agent, [path], …)` and the same prompt and parser. The old single-file prompt and fence-unwrap path are deleted. That leaves one format to test.

### D4. Run model: one Job with many paths
- A `Job` holds `paths[]`, `agent`, a per-path `note`, and a per-path `token`. There's one `runId` for the job, shared by every path's `AiRun`, so all rows show the same progress ticks.
- `CONCURRENCY`, the queue and the drain workers are removed. A new `start` while a job is in flight cancels the overlapping paths' old runs (tokens bumped, as today) and starts its own job. Two jobs never claim the same path, but they can run side by side over disjoint sets.
- Per-path Stop (`clear`) bumps that path's token, so its block won't land. `acp_cancel(runId)` runs only when no path of that job still holds a live token.
- Generation (repo switch or unmount) cancels every job, as today.

### D5. Landing per path
After the answer arrives: parse, then for each path whose token is still current, check its block, re-read the file, stale-check it, then `applyToEditor` or set that path's error. A missing block gives "The agent didn't return this file." Blocks for paths nobody asked for are ignored.

### D6. Size budget
Before sending, sum the conflicted content of the targets. Over a fixed budget (`MAX_SWEEP_BYTES`, ~600 KB, comfortably under the 1 MiB answer cap, since resolved output is usually smaller than conflicted input), refuse with "Too large for one pass — resolve files individually." The size is known only after the files are read, so the refusal lands as each targeted file's error (a one-file request says "resolve it by hand"); no prompt is sent. A file whose own content holds a sentinel line is refused the same way before the prompt is built, since it would make the prompt ambiguous. Mark it `shortcut: refuse instead of batching; batch into several turns if big merges need AI help`.

### Store and size
- No Zustand change. `acpPrompt` / `acpCancel` in `repo.ts` are used as they are.
- `useAiResolveRuns.ts` (276 lines) should shrink, since the queue and workers go. If adding the parse-and-land loop pushes it toward 400, move the per-path landing into a pure helper in `aiResolveModel.ts`. No folder split is planned.
- No new dependency, so `docs/tauri-plugin-decisions.md` doesn't apply.

## Risks / Trade-offs

- [A whole sweep shares one 5-minute timeout] → the budget limits the input size. On a timeout, every file gets the same error, and a per-file retry still works.
- [One file fails and the user has to rerun only that one] → errors are per path, so "Try again" on one file runs a set of one.
- [The agent reorders or renames blocks] → blocks are matched by exact path, never by position.
- [No result until the whole turn ends, so a long sweep shows only progress ticks] → accepted. Streaming per file needs D1's rejected alternative.
- [Budget is a byte heuristic, not tokens] → acceptable for a guard. Tune it if it misfires.

## Open Questions

- The exact `MAX_SWEEP_BYTES` value. It can be tuned after trying real merges without changing the spec, which only says an oversized sweep is refused before it starts.
