# Tasks

## 1. Pre-flight

- [x] 1.1 Re-run the dry run on the current tip and confirm the site list in proposal.md still matches: `cargo clippy --all-targets --all-features -- -W rust-2024-compatibility` and `cargo clippy --all-targets --no-default-features --features agent -- -W rust-2024-compatibility`. Update the list if it changed.

## 2. Cargo manifest

- [x] 2.1 Make `shell-words` `optional = true` and add `"dep:shell-words"` to the `desktop` feature in `src-tauri/Cargo.toml`. Verify that the agent clippy no longer prints `unused dependency`.

## 3. Edition migration

- [x] 3.1 Run `cargo fix --edition --all-targets --all-features` and `cargo fix --edition --all-targets --no-default-features --features agent`. Then set `edition = "2024"` in `src-tauri/Cargo.toml`. Verify with `cargo check` for both feature sets.
- [x] 3.2 Review each `tail_expr_drop_order` site listed in proposal.md. Where the scrutinee's temporary (lock guard, session handle, `git2` object) must still be alive inside the arms, hoist it into a named `let` above the `match` / `if let`. Otherwise leave the code as it is. Write one line in the review summary per site saying which case it was.
  Review summary (no site needed a hoist; each tail temporary has no observable drop and no guard drops early):
  - `commands/remote.rs:64`: matched `Result` of `session.request(..).await`; plain value.
  - `git/oauth/pkce/loopback.rs:77`: `listener.accept()` result; the stream is moved into the arm binding.
  - `git/status/stash.rs:59`: `commit.parent(i)` `Commit`; dropping earlier is the safe direction for a `git2` borrow.
  - `git/status/working.rs:250`: `open_regular_worktree_file(..)` result; the file is moved into the binding.
  - `git/worktree_fs/handle.rs:102`: `open_with(..)` result; the file is moved into `created`.
  - `remote/registry.rs:100`: `host.session.take()` is moved into `close_off_thread(..).await`; the `host` lock guard is a local and is released after the await either way.
  - `remote/session/tests.rs:63`: a test's `(slow, fast)` tuple of join results.
  - `updater.rs:106` (two spans): the `updater.check()` result; the `Update` is moved into the resource table.
- [x] 3.3 Run `cargo fmt --all` under the 2024 style edition. Verify that the formatting-only diff contains no logic changes: review it with `git diff --stat` and `git diff -w`.

## 4. Platform-specific code

- [ ] 4.1 Confirm that the Windows-only (`git/write/open_path.rs`) and Linux-only (`shell/timed.rs`) code compiles on 2024. Do this through CI's Windows and Linux clippy jobs, or with `cargo check --target x86_64-pc-windows-msvc` where that target is installed. Record which one was used.
  Status: Linux-only code is covered by the PR's Linux clippy job. Windows-only code (`git/write/open_path.rs`) can't be checked locally: only `aarch64-apple-darwin` is installed, and a Windows check needs MSVC for `libgit2-sys`. It is covered by the scheduled or dispatched "Rust check (windows-latest)" job, which runs on `latest` after merge. No 2024 hard-error construct (`extern` blocks, `#[no_mangle]`, `static mut`, `env::set_var`) exists anywhere in the crate. Tick this once that job passes.

## 5. Definition of done

- [x] 5.1 `(cd src-tauri && cargo fmt --all -- --check)` passes.
- [x] 5.2 `(cd src-tauri && cargo clippy --all-targets --all-features -- -D warnings)` and `cargo clippy --all-targets --no-default-features --features agent -- -D warnings` pass.
  Needed for clippy: under 2024 `collapsible_if` also asks for let-chains (31 sites). Each enclosing function (23) carries `#[expect(clippy::collapsible_if, reason = …)]`; the conversion is a follow-up change.
- [x] 5.3 `(cd src-tauri && cargo test)` passes for the desktop build and for `--no-default-features --features agent`.
- [x] 5.4 `bun run sizes` passes. The 2024 formatting must not push a file over the Rust ceiling; if it does, split at a seam before merging.
- [x] 5.5 `bun run tauri dev` starts and opens a repository (smoke check that the binary still runs after the reformat).

## 6. Review follow-ups

- [x] 6.1 Point the repo's Claude Code format hook (`.claude/settings.json`) at `rustfmt --edition 2024`, so agent edits keep the 2024 style.
- [x] 6.2 Replace the crate-wide `collapsible_if = "allow"` with `#[expect(clippy::collapsible_if, reason = …)]` on the 23 functions that hold the 31 sites, so the lint stays live for new code. Verify with clippy `-D warnings` for both builds.
- [x] 6.3 Set `rust-version = "1.100"` (matching `rust-toolchain.toml`), since edition 2024 switches Cargo to the MSRV-aware resolver 3. `Cargo.lock` is unchanged.
- [x] 6.4 Split `remote/install.rs` at a real seam: the download and signature helpers move to `remote/install/fetch.rs`, and `target_for` keeps its plain `if`/`else`. Verify with `cargo test remote::install` and `bun run sizes`.
- [ ] 6.5 Dispatch the Windows `platform-check` job against this branch before merge; tick 4.1 when it passes.

