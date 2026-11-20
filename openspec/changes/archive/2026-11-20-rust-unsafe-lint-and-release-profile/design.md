# Design

## Context

- `src-tauri/Cargo.toml` has no `[lints]` table; lint policy is the CLI flag `-D warnings` in CI and CLAUDE.md.
- Production `unsafe` lives in two files. `shell/timed.rs` documents three of four blocks (`waitid` at line 97 does not); `git/write/open_path.rs:133` (Windows-only `ShellExecuteW`) has a return-value comment but no `SAFETY:` line. Clippy on macOS cannot see the Windows block, so it is found by reading, not by the lint.
- The desktop binary builds with Cargo's default `release` profile (thin-local LTO, 16 codegen units). `[profile.agent]` inherits `release` and sets `opt-level = "z"`, `lto = true`, `codegen-units = 1`, `strip = true`.

## Goals / Non-Goals

**Goals:**
- Every `unsafe` block carries a `// SAFETY:` comment, and CI keeps it that way on every target clippy runs on.
- Decide the desktop release profile on measured numbers.

**Non-Goals:** see proposal (no unwrap lints, no `panic = "abort"`, no agent-profile change).

## Decisions

1. **Lint in `Cargo.toml`, level `deny`.** Cargo's `[lints]` table applies to every target and feature set (desktop and `--features agent`). `deny` rather than `warn` (changed after code review) makes a plain local `cargo clippy` fail too, not only CI's `-D warnings`; the code is clean, and clippy lints never block `cargo build` or `tauri dev`. Alternative: a `#![deny(...)]` in `lib.rs` — rejected, it misses the bins' own roots and is less discoverable.
2. **`lto = "thin"` + `codegen-units = 1`, not fat LTO.** Thin LTO gets most of the size/speed benefit at a fraction of fat LTO's link time; `codegen-units = 1` is the larger size lever. Fat LTO stays as a measured fallback only if thin shows little gain.
3. **Measure before adopting.** Build `cargo build --release` twice on the dev Mac (current vs. candidate), compare binary size and wall time; also compare the produced `.app`/`.dmg` size. Adopt if the binary shrinks ≥10% and clean build time grows ≤2×; otherwise record the numbers in this design and drop the profile task.

## Measurements (2026-11-15)

Clean `cargo build --release --bin GitLane`, each profile in its own empty target dir, on the dev Mac (macOS arm64) and the `ubuntu` test box (Linux x86_64, 20 cores):

| Profile | macOS binary | macOS time | Linux binary | Linux time |
|---|---|---|---|---|
| default (16 units, thin-local LTO) | 32.3 MB | 85 s | 41.9 MB | 86 s |
| `lto = "thin"` | 33.0 MB (+2.2%) | 112 s (1.32×) | 42.4 MB (+1.2%) | 111 s (1.28×) |
| `codegen-units = 1` | 22.4 MB (−30.6%) | 146 s (1.71×) | 29.4 MB (−29.9%) | 154 s (1.78×) |
| `lto = "thin"` + `codegen-units = 1` | 23.3 MB (−27.7%) | 206 s (2.43×) | 29.9 MB (−28.5%) | 211 s (2.44×) |

**Outcome:** adopted `codegen-units = 1` alone. It is the smallest binary and the only candidate within the ≤2× build-time threshold; thin LTO adds size and time here, so the planned combination (Decision 2) was dropped in favour of the measured winner. The agent binary is byte-identical with and without the change (4,891,472 bytes, same SHA-1), as expected since `[profile.agent]` already sets both keys. Linux x86_64 shows the same ordering, so the choice holds on both platforms.

## Risks / Trade-offs

- **Longer release builds** on self-hosted runners → bounded by the adoption threshold; incremental dev builds are unaffected (dev profile untouched).
- **Windows-only unsafe not linted locally** → the Windows CI clippy leg (if present) catches regressions; otherwise the lint still covers macOS/Linux and the open_path comment is added by hand.
- **`[profile.release]` leaks into `[profile.agent]`** → agent already overrides both keys, so no change; verify the agent binary size is unchanged.
