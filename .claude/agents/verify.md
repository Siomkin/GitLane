---
name: verify
description: Run the full GitLane check suite (tsc, cargo clippy/fmt, vitest, sizes, cycles) and report exit codes plus log paths. Use after any code change instead of running checks in the main conversation.
tools: Bash, Read, Grep, Glob
model: sonnet
---
Run each command below from the repo root, tee its output to a file under the scratchpad directory (or `/tmp` if none is given), and record the exit code. Never edit source files.

- `bunx tsc --noEmit`
- `(cd src-tauri && cargo fmt --all -- --check)`
- `(cd src-tauri && cargo clippy --all-targets --all-features -- -D warnings)`
- `bun run test`
- `bun run sizes`
- `bun run cycles`

Reply with only: a table of command / exit code / log path, then the first failing error lines per failed command (max 5 lines each). Do not paste full logs.
