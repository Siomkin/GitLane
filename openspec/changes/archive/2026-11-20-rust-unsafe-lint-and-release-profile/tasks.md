# Tasks

## 1. Unsafe documentation lint

- [x] 1.1 Add `[lints.clippy]` with `undocumented_unsafe_blocks = "deny"` to `src-tauri/Cargo.toml`
- [x] 1.2 Add a `// SAFETY:` comment above the `waitid` call in `src-tauri/src/shell/timed.rs` (~line 97)
- [x] 1.3 Add a `// SAFETY:` comment to the `ShellExecuteW` block in `src-tauri/src/git/write/open_path.rs` (~line 133): both buffers are NUL-terminated UTF-16 that outlive the call; null pointers are allowed for hwnd/parameters/directory
- [x] 1.4 Confirm whether CI runs clippy on Windows; if it does not, note in this design that the Windows block is covered by review only (it does: the weekly hosted `windows-latest` clippy job in `ci.yml`)

## 2. Desktop release profile (measured)

- [x] 2.1 Check `.github/workflows/release.yml` and `tauri.conf.json` for any `CARGO_PROFILE_RELEASE_*` override that would mask a `[profile.release]` entry
- [x] 2.2 Baseline: clean `cargo build --release --bin GitLane` in an empty `CARGO_TARGET_DIR` (the existing `target/` is left alone); record binary size and wall time
- [x] 2.3 Candidates: `lto = "thin"`, `codegen-units = 1`, and both, each built clean in its own empty `CARGO_TARGET_DIR` (via `CARGO_PROFILE_RELEASE_*`); record the same numbers on macOS arm64 and Linux x86_64
- [x] 2.4 Apply the design's threshold (≥10% smaller, ≤2× build time); keep the profile with a one-line comment citing the numbers, or remove it and record the numbers in design.md
- [x] 2.5 Build `cargo build --profile agent --no-default-features --features agent --bin gitlane-agent` and confirm the agent size is unchanged

## 3. Checks

- [x] 3.1 `(cd src-tauri && cargo fmt --all -- --check)`
- [x] 3.2 `(cd src-tauri && cargo clippy --all-targets --all-features -- -D warnings)`
- [x] 3.3 `(cd src-tauri && cargo clippy --all-targets --no-default-features --features agent -- -D warnings)`
- [x] 3.4 `(cd src-tauri && cargo test)`
