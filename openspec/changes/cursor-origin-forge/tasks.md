## 1. Detection and dispatch

- [x] 1.1 Add `ForgeKind::CursorOrigin` with key `"cursor-origin"` and label `"Cursor Origin"`, plus the enum-key test.
- [x] 1.2 Classify HTTPS and SSH `origin.cursor.com` remotes without adding a new parsing abstraction.
- [x] 1.3 Route Cursor Origin to a static `OriginProvider`; keep GitHub/unknown and known-unsupported behavior unchanged.

## 2. Origin adapter

- [x] 2.1 Add `git/forge/origin/` with `mod.rs`, `command.rs`, `capabilities.rs`, `dto.rs`, and `ops.rs`; only `command.rs` may spawn `origin`.
- [x] 2.2 Implement `run_origin` with GUI PATH resolution, repository-env cleanup, bounded output, no stdin, `NO_COLOR`, and secret redaction. Apply repository/JSON/confirmation flags only to subcommands that support them.
- [x] 2.3 Cache a feature probe for the installed version and required `pr`, `api`, and `pr thread` commands. Return actionable missing/old/native-Windows errors without a `gh` fallback.
- [x] 2.4 Add centralized Origin DTOs and checked parsing for string-encoded PR numbers; map documented `origin api` reads into shared PR/detail/commit/comment types.
- [x] 2.5 Implement Origin repository resolution, PR list/detail/commits, and `pr diff --patch` through the shared unified-diff parser.
- [x] 2.6 Implement existing-thread list/reply/resolve/reopen. Keep new inline threads unsupported.
- [x] 2.7 Implement Origin merge through `origin pr merge` (`--squash` / `--merge`). Refuse rebase-and-merge. Ignore delete-branch (no Origin flag). Keep create/review/general-comment/state as Origin-specific unsupported errors.
- [x] 2.8 Add Origin auth status/login/logout plus a machine-readable current-user lookup in `auth_providers.rs`; return only non-secret login/display metadata.

## 3. Existing IPC contract

- [x] 3.1 Confirm every reused PR command still enters through `forge::context()` and `async` + `blocking()`. Add no Tauri command, handler registration, secret field, or invoke wrapper.

## 4. Frontend types and remotes

- [x] 4.1 Add `ForgeKind.CursorOrigin = "cursor-origin"` and keep it in lockstep with Rust.
- [x] 4.2 Add `"cursor-origin"` to `ForgeAuthProvider`, `PullRequestProvider`, and the forge-auth/whoami/sign-out/PR capability sets. Do not add provider-token support.
- [x] 4.3 Classify `origin.cursor.com` in `remotes.ts` and map it to the Cursor Origin provider without splitting the file.

## 5. UI and accounts store

- [x] 5.1 Extend the existing accounts slice with Cursor Origin CLI readiness and account label; make `prAccountRef()` return `null` for Origin and key PR polling on Origin readiness changes.
- [x] 5.2 Enable Origin in `isPrForge`, PR list/detail load gates, and refresh flows.
- [x] 5.3 Show Origin merge (squash / merge commit; no rebase; no delete-branch). Hide create/edit/state/review/general-comment/new-inline actions while leaving existing-thread reply/resolve/reopen enabled.
- [x] 5.4 Add Cursor Origin provider-state and popover/remotes-summary models so signed-in, transport-only, and missing-auth states never fall through to GitHub or “No PRs” copy. Reuse the cloud icon.
- [x] 5.5 Wire documented Origin repository/PR browser URLs after confirming their stable template.
- [x] 5.6 Confirm Origin fetch/push uses the system helper or SSH and never injects `gh auth git-credential`.

## 6. Tests

- [x] 6.1 Rust: host classification, provider dispatch, DTO number parsing, read/thread argument builders, explicit unsupported writes, missing/old CLI errors, host mismatch, and fake-token redaction.
- [x] 6.2 Rust auth: Origin signed-in/out status and non-secret current-user mapping.
- [ ] 6.3 Frontend: types/remotes/forge-help, Origin readiness and polling, PR gates, write-action hiding, existing-thread actions, provider indicator, and remotes-summary copy.

## 7. Docs

- [ ] 7.1 Add Cursor Origin and its read-first scope to `CLAUDE.md` and the architecture rules; document the single `run_origin` boundary and `origin api` reads.
- [ ] 7.2 Add Origin CLI-session, PR-read, existing-thread, missing-CLI, and git-transport rows to `docs/provider-auth-qa-matrix.md`.
- [ ] 7.3 Add no Tauri plugin, crate, JS dependency, or plugin-decision entry.

## 8. Definition of done

- [ ] 8.1 Run `bunx tsc --noEmit`, `bun run lint`, `bun run test`, and `bun run build`.
- [ ] 8.2 Run `cargo check`, `cargo fmt --all -- --check`, and `cargo clippy --all-targets --all-features -- -D warnings` in `src-tauri`.
- [ ] 8.3 Run `bun run sizes`; keep oversized forge files to enum/match changes.
- [ ] 8.4 In `bun run tauri dev`, verify an Origin repo loads list/detail/commits/diff through `origin`, deferred writes are absent, missing CLI is actionable, and a GitHub repo is unchanged. Exercise one existing-thread mutation when a test Origin PR is available.
