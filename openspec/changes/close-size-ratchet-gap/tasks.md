## 1. Ratchet fix (PR 1)

- [x] 1.1 In `scripts/check-file-sizes.mjs`, replace the `**` pathspecs with `'src/*.ts' 'src/*.tsx' 'src-tauri/src/*.rs'` and extract the listing into an exported `trackedSources()`; verify `node scripts/check-file-sizes.mjs` now reports `terminal_agents.rs`, `terminal_agents.rs (tests)`, `auth_providers.rs`, and `watcher.rs` over the ceiling
- [x] 1.2 Add tests in `scripts/check-file-sizes.test.ts` asserting `trackedSources()` includes `src-tauri/src/lib.rs` and `src/App.tsx` and excludes `EXEMPT` paths; verify `bun run test -- scripts` passes
- [x] 1.3 Run `bun run sizes:update` and commit the baseline; verify `bun run sizes` prints "4 known file(s) over 400 lines, none grew" and CI's `sizes` job is green
- [x] 1.4 Add one sentence to `docs/rules/architecture-rules.md` §3 (the ratchet covers all tracked sources, including top-level files) and refresh GL-341's checklist in Jira (tick done items, add these three); verify the sentence names the script and the Jira description matches the tree

## 2. terminal_agents split (PR 2)

- [x] 2.1 Create `src-tauri/src/terminal_agents/{defaults,migrations,messages,agents,probe}.rs` by moving items verbatim and keep `terminal_agents.rs` as the facade re-exporting today's `pub` surface; verify `cargo check` passes and `git diff` shows no change in `commands/terminal.rs` or `acp_agents.rs`
- [x] 2.2 Move the inline `mod tests` into `terminal_agents/tests/{migrations,storage,probe}.rs`; verify `cargo test terminal_agents::` runs the same number of tests as before the move
- [x] 2.3 Verify the pure move: a sorted-line diff of the old file against the new set differs only in `mod`/`use`/visibility lines; `cargo fmt --all -- --check`, `cargo clippy --all-targets --all-features -- -D warnings`, and `bun run sizes` (both `terminal_agents` baseline entries gone) pass

## 3. auth_providers split (PR 3)

- [x] 3.1 Create `src-tauri/src/auth_providers/{spec,status,sign_out,probe}.rs`; the facade keeps `statuses`, `account`, `sign_out`; verify `cargo check` passes and `commands/auth.rs` is unchanged
- [x] 3.2 Move the inline tests to `auth_providers/tests.rs`; verify the test count is unchanged, clippy and fmt are clean, and `bun run sizes` drops the entry

## 4. watcher split (PR 4)

- [ ] 4.1 Create `src-tauri/src/watcher/{roots,install,commondir}.rs` beside `classification.rs`; the facade keeps `WatcherState`, `watch`, `unwatch`; verify `cargo check` passes and, in `bun run tauri dev`, a terminal `git commit` in the open repo still triggers the `repo-changed` refresh
- [x] 4.2 Move the inline tests to `watcher/tests.rs`; verify the test count is unchanged, clippy and fmt are clean, and `bun run sizes` reports `0 known file(s)` with an empty baseline

## 5. Definition of done (every PR)

- [x] 5.1 `bunx tsc --noEmit`, `bun run lint`, `bun run test`, `(cd src-tauri && cargo fmt --all -- --check && cargo clippy --all-targets --all-features -- -D warnings && cargo test)`, `bun run sizes`, and `openspec validate close-size-ratchet-gap --strict` all pass
