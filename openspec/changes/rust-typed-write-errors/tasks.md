# Tasks

## 1. Pin current behaviour

- [ ] 1.1 Add tests that serialise the `CommandError` (`kind`, `code`, `message`) for each pilot failure as it is today: a discard after the file drifted (stale lease), a discard whose re-capture failed outright, `init` into a folder that already has `.git`, and `init_in_place` on an openable repository. Verify they pass on unmodified code: `(cd src-tauri && cargo test discard)` and `(cd src-tauri && cargo test init)`. Put them next to the existing `git/write/tests/discard/` and lifecycle tests.

## 2. Rust impl: the error type

- [ ] 2.1 Add `git/write/error.rs` with `pub(crate) enum WriteError { StaleLease, AlreadyARepository, Git }` (`thiserror`, `Display` = the message), `WriteError::stale(reason)` that appends `classify::STALE_SUFFIX`, and doc comments. Register it in `git/write.rs`. Verify with `cargo check`.
- [ ] 2.2 Implement `From<String> for WriteError` (→ `Git`), `From<WriteError> for String` (→ the message) and `From<WriteError> for CommandError` (StaleLease → `staleLease`; AlreadyARepository → `git` + code `alreadyARepository`; Git → `classify_failure`). Unit-test each arm in `git/write/error/tests.rs`.
- [ ] 2.3 Add a doc line on `classify::stale` pointing new code at `WriteError::stale`. The old helper stays for the unmigrated modules.

## 3. Rust impl: pilot migration

- [ ] 3.1 Migrate `git/write/discard_file/` (`discard.rs`, `snapshot.rs`, `semantics.rs`) to `Result<_, WriteError>`. Replace the `error.ends_with(STALE_SUFFIX)` branch in `discard.rs` with a `match` on `WriteError::StaleLease`. Unmigrated helpers it calls (`index_lock::lock_index_writes`) convert through `?`. Verify with `grep -n STALE_SUFFIX src-tauri/src/git/write/discard_file` (no hits) and the 1.1 tests.
- [ ] 3.2 Migrate `git/write/lifecycle/init.rs` so both "already a Git repository" producers return `WriteError::AlreadyARepository`, with the message text unchanged. Verify with the 1.1 tests.
- [ ] 3.3 Confirm `commands/staging.rs` and `commands/repo.rs` compile unchanged and that the agent dispatch table still builds: `cargo clippy --all-targets --no-default-features --features agent -- -D warnings`.

## 4. Definition of done

- [ ] 4.1 `(cd src-tauri && cargo fmt --all -- --check)` passes.
- [ ] 4.2 `(cd src-tauri && cargo clippy --all-targets --all-features -- -D warnings)` and the agent-feature clippy both pass.
- [ ] 4.3 `(cd src-tauri && cargo test)` passes, including the existing `git/write/classify/tests.rs` and the 1.1 pins, with no change to any asserted message.
- [ ] 4.4 `bun run sizes` passes (no touched file crosses the Rust ceiling).
