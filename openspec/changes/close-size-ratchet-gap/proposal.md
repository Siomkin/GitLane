## Why

`bun run sizes` (`scripts/check-file-sizes.mjs`) is the enforced size ceiling behind `docs/rules/architecture-rules-react.md` §4a and `-rust.md` §6, but its file listing is `git ls-files 'src/**/*.ts' 'src/**/*.tsx' 'src-tauri/src/**/*.rs'`. Without `:(glob)` magic git treats `**` as two `*`s and requires a `/` after the prefix, so the 16 top-level `src-tauri/src/*.rs` files and the 4 top-level `src/*.ts(x)` files are never scored. By the script's own `countable()` rule three of them are already over the 400-line production ceiling — `terminal_agents.rs` (612 production + 622 inline test lines), `auth_providers.rs` (460), `watcher.rs` (404) — and CI reports "0 known file(s) over 400 lines". The guard has a hole exactly where the three largest files live.

Jira: GL-341 (Split oversized source files into focused modules) — its checklist predates the `commands/`, `git/types/`, `discard_all/`, `lifecycle/`, `forge/prs`, and `forge/dto` splits (all done) and does not list these three files. Touches tooling (`scripts/`) and Rust (three behaviour-preserving module splits); no frontend, IPC, or user-observable change, so this change sets `skip_specs: true`.

## What Changes

- Fix the listing to `git ls-files 'src/*.ts' 'src/*.tsx' 'src-tauri/src/*.rs'` (plain pathspecs are recursive; verified to return 1044 and 438 tracked files, matching a full walk) and extract it as an exported `trackedSources()` so `scripts/check-file-sizes.test.ts` can assert that a top-level path is scored.
- Re-baseline in the same PR (`bun run sizes:update`) so CI stays green and the newly visible files become "known, must not grow" entries — the ratchet's designed path for discovered debt.
- Three pure module splits, one PR each, each shrinking the baseline back toward `{}`:
  - `terminal_agents.rs` → `terminal_agents/` (default prompts and AI actions, legacy-instruction migrations, commit-agent message storage, agent entry storage, command probe) with the 622-line inline test module moved to `terminal_agents/tests/`.
  - `auth_providers.rs` → `auth_providers/` (provider table, status and sign-out, CLI probe).
  - `watcher.rs` → `watcher/` (watch roots, watcher install and subscribers, common-dir watcher) beside the existing `watcher/classification.rs`.
- Refresh GL-341's description to the current state (tick done items, add these three).

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- None — `skip_specs: true`: a tooling fix plus pure refactors; no user- or git-observable behaviour changes.

## Impact

- Tooling: `scripts/check-file-sizes.mjs`, `scripts/check-file-sizes.test.ts`, `scripts/file-size-baseline.json` (temporarily non-empty).
- Rust: `src-tauri/src/terminal_agents.rs`, `auth_providers.rs`, `watcher.rs` become facades over folders; `lib.rs` `mod` declarations and every command signature stay unchanged.
- Docs: `docs/rules/architecture-rules.md` §3 gains one sentence stating the ratchet covers every tracked source file, including top-level ones.
- Secrets/auth/IPC risk: none. No command, type, or wrapper changes. `auth_providers.rs` discovers accounts through `gh`/`glab`/`az` status calls and never handles tokens; the split moves code verbatim.
- Pattern to copy: the `split-module` skill; the existing `watcher.rs` + `watcher/classification.rs` facade shape; `commands/registration_tests/` for tests in a subfolder.

## Non-goals

- Lowering the ceilings, changing `TEST_CEILING`, or ratcheting the 122 React / 49 Rust files in the 201–400 "look" band.
- Splitting any other file from GL-341's list.
- Any behaviour change inside the three modules (retiring the terminal-agent legacy-instruction migrations is a separate backlog item).
