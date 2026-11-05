# Proposal

No Jira issue yet.

## Why

"Resolve all" in the conflict workspace is the per-file AI action looped over every unresolved text file: each file gets its own adapter process and its own ACP session (three at a time). No agent ever sees the other conflicted files, so a rename resolved one way in `a.ts` can be resolved the opposite way in `b.ts`, and an N-file merge pays for N adapter start-ups and N context loads. Resolving a set of conflicts should be one agent session that sees the whole set.

## What Changes

- "Resolve all" sends every unresolved text conflict to the agent in **one** prompt, in **one** ACP session, and reads back one resolved body per file.
- The per-file "Resolve with AI" uses the same path with a set of one file — one prompt format, one answer parser. The old single-file prompt and the three-at-a-time queue are removed.
- The answer delimits each file with explicit sentinel lines instead of fenced code blocks, so Markdown files with their own fences survive.
- Each file is still judged on its own: a missing, empty, marker-laden, or stale (changed on disk) block fails that file only, and every good block lands in its own Output pane for review, as today.
- Stopping one file detaches just that file; the agent process ends only when no file in the run is still waiting. Stop-all and repo switch end it as today.
- A sweep whose conflicted content exceeds a fixed size budget is refused up front with a message to resolve files individually, instead of being silently split into several sessions.

## Capabilities

### New Capabilities
- `conflicts/resolution`: AI-assisted resolution of merge/rebase conflicts — one agent session per resolve request, per-file results, review before write.

### Modified Capabilities
- None. `terminal/session` (unattended permission answers) is unchanged.

## Non-goals

- No multi-turn or long-lived ACP session; the backend stays one prompt in, one answer out.
- No backend, IPC, or new command change; `acp_prompt` / `acp_cancel` are reused as they are.
- No automatic batching of an over-budget sweep into several sessions.
- No change to how a landed proposal is applied, staged, or discarded, and no agent-side file writes (the ACP gate and prompt keep refusing them).
- Binary conflicts stay manual.

## Impact

- **Process:** frontend only (`src/features/conflicts/ai-resolve/`). Rust, IPC, and stores are untouched.
- **Code to copy:** `aiResolveModel.ts` (prompt + answer checks) and `useAiResolveRuns.ts` (run tokens, generation, landing guard) are reshaped in place; `AiConflictResolve.tsx` keeps its buttons.
- **Secrets/auth/IPC risk:** none — no credential crosses IPC; the prompt carries only worktree file content, as today. The agent stays read-only.
- **Limits:** the whole answer must fit the backend's 1 MiB answer cap and 5-minute turn timeout; the size budget exists so a big sweep fails clearly before it starts.
