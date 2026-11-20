# Tasks

## 1. Pre-flight

- [x] 1.1 Re-run the dry run on the current tip and confirm the site list in proposal.md still matches: `cargo clippy --all-targets --all-features -- -W rust-2024-compatibility` and `cargo clippy --all-targets --no-default-features --features agent -- -W rust-2024-compatibility`. Update the list if it changed.

## 2. Cargo manifest

- [x] 2.1 Make `shell-words` `optional = true` and add `"dep:shell-words"` to the `desktop` feature in `src-tauri/Cargo.toml`. Verify that the agent clippy no longer prints `unused dependency`.

## 3. Edition migration

- [ ] 3.1 Run `cargo fix --edition --all-targets --all-features` and `cargo fix --edition --all-targets --no-default-features --features agent`. Then set `edition = "2024"` in `src-tauri/Cargo.toml`. Verify with `cargo check` for both feature sets.
- [ ] 3.2 Review each `tail_expr_drop_order` site listed in proposal.md. Where the scrutinee's temporary (lock guard, session handle, `git2` object) must still be alive inside the arms, hoist it into a named `let` above the `match` / `if let`. Otherwise leave the code as it is. Write one line in the review summary per site saying which case it was.
- [ ] 3.3 Run `cargo fmt --all` under the 2024 style edition. Verify that the formatting-only diff contains no logic changes: review it with `git diff --stat` and `git diff -w`.

## 4. Platform-specific code

- [ ] 4.1 Confirm that the Windows-only (`git/write/open_path.rs`) and Linux-only (`shell/timed.rs`) code compiles on 2024. Do this through CI's Windows and Linux clippy jobs, or with `cargo check --target x86_64-pc-windows-msvc` where that target is installed. Record which one was used.

## 5. Definition of done

- [ ] 5.1 `(cd src-tauri && cargo fmt --all -- --check)` passes.
- [ ] 5.2 `(cd src-tauri && cargo clippy --all-targets --all-features -- -D warnings)` and `cargo clippy --all-targets --no-default-features --features agent -- -D warnings` pass.
- [ ] 5.3 `(cd src-tauri && cargo test)` passes for the desktop build and for `--no-default-features --features agent`.
- [ ] 5.4 `bun run sizes` passes. The 2024 formatting must not push a file over the Rust ceiling; if it does, split at a seam before merging.
- [ ] 5.5 `bun run tauri dev` starts and opens a repository (smoke check that the binary still runs after the reformat).
