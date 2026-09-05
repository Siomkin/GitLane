## Context

`countable()` and `ceilingFor()` are unit-tested; `main()` inlines the `git ls-files` call, so the listing has no test and the pathspec bug shipped unnoticed. Git's default pathspec matching lets `*` match `/`, so `'src-tauri/src/*.rs'` is recursive, while `'src-tauri/src/**/*.rs'` demands a directory after `src-tauri/src/` that top-level files lack. Ratchet semantics stay as they are: a listed file over the ceiling fails only if it grew beyond its baseline entry; shrinking updates the baseline; Rust inline test halves are scored separately against the same 400-line ceiling.

Current shapes (production / inline test lines by `countable()`): `terminal_agents.rs` 612/622, `auth_providers.rs` 460/151, `watcher.rs` 404/271. `watcher/classification.rs` (377) already lives in a folder. `terminal_agents.rs` holds five concerns: default prompt and AI-action constants; `LEGACY_INSTRUCTIONS` and the `migrate_*` functions; `CommitAgentMessages` load/save/reset; `TerminalAgent` entries load/save/reset/seed; `probe`/`which` command availability.

## Goals / Non-Goals

**Goals:**
- Every tracked source file is scored; the listing is covered by a test.
- The three known overs shrink under the ceiling by pure moves, one PR each.

**Non-Goals:**
- Any semantic change in the moved code; changing what counts as a test half; touching the "look" band.

## Decisions

1. **Fix the pathspec rather than add a glob library.** No new dependency (`docs/tauri-plugin-decisions.md` asks for a decision before any JS package), and `git ls-files` keeps the tracked-files-only property. Alternative: `':(glob)src/**/*.ts'` magic — also correct, but the plain recursive form is simpler and says what the script means.
2. **Export `trackedSources()` and test it against the real repo** (`expect(list).toContain("src-tauri/src/lib.rs")`, `toContain("src/App.tsx")`, `not.toContain("src/components/ui/icons.tsx")`). The scripts tests already run in the vitest `node` project.
3. **Baseline first, split after.** The glob-fix PR carries the updated baseline so CI is green immediately and the debt is visible in-tree; each split PR removes its entries. Alternative: fix and split in one PR — larger review and the guard waits on the slowest split.
4. **Split seams** (per the `split-module` skill: facade + `foo/` + `foo/tests/`):
   - `terminal_agents.rs` → `terminal_agents/{defaults,migrations,messages,agents,probe}.rs` + `terminal_agents/tests/{migrations,storage,probe}.rs`. The facade keeps the `pub` surface (`load`, `save`, `reset_to_defaults`, `load_messages`, `save_messages`, `reset_messages_to_defaults`, `probe`, the `DEFAULT_*` constants, `TerminalAgent`, `CommitAgentMessages`, `AiActionCommand`) so `commands/terminal.rs` and `acp_agents.rs` are untouched.
   - `auth_providers.rs` → `auth_providers/{spec,status,sign_out,probe}.rs` (`ProviderSpec` + `PROVIDERS`; `statuses`/`status_for`/`account`/`fetch_account` and the GitLab/Azure parsers; `sign_out`/`sign_out_per_host`; `probe_cmd`/`wait_bounded*`/`run_bounded*`/`probe_cli`), inline tests to `auth_providers/tests.rs`.
   - `watcher.rs` → `watcher/{roots,install,commondir}.rs` (`WatchRoots`/`resolve_watch_roots`; `build_private_watcher`/`make_subscriber`/`install_watch`; `CommondirSubscriber`/`spawn_commondir_watcher`), facade keeps `WatcherState`, `watch`, `unwatch`, `detach`; inline tests to `watcher/tests.rs`.
5. **Proof of pure move**, per GL-341's convention: a sorted line diff of the old file against the new set differs only in `mod`/`use`/visibility lines; the `cargo test` count is unchanged (1178 `#[test]` today); `cargo clippy -D warnings` and `cargo fmt --check` are clean.

## Risks / Trade-offs

- [A non-empty baseline reads like a regression] → the PR description states it is the discovered backlog; the ratchet forbids growth from day one.
- [Visibility widening during splits] → use the narrowest visibility that compiles (`pub(super)`, `pub(crate)`); no new `pub` beyond the facades.
- [`watcher.rs` owns runtime state (`Arc<Mutex<Watchers>>`)] → move types with their impls; no lock-order change; the inline tests move verbatim and the `repo-changed` event is exercised in-app.
- [`#[allow(clippy::items_after_test_module)]` in `git/write/remotes/config.rs` shows the test-half heuristic is fragile] → out of scope; recorded on GL-341.

## Migration Plan

Four PRs in order: (1) pathspec fix + test + baseline; (2) `terminal_agents` split; (3) `auth_providers` split; (4) `watcher` split. Rollback is a revert of any single PR; the baseline keeps CI tolerant of partial progress.
