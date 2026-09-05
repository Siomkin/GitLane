## 1. Rust and IPC
- [x] 1.1 Reuse squash rewrite construction for an explicitly leased other branch; verify tip/below-tip rewrites preserve current dirty state and recovery ref with Rust tests.
- [x] 1.2 Add target guards and a no-deref CAS update with reflog; verify stale, symbolic, published, merge and linked-worktree targets are refused.
- [x] 1.3 Register async squash_branch command and typed TS wrapper using existing scalar and CapturedIdentity wire types; verify command contract audits and typechecks.

## 2. Frontend
- [x] 2.1 Resolve named local squash targets without changing existing current-branch eligibility; verify candidate, ambiguity, and invalid-range tests.
- [x] 2.2 Add branch-naming squash prompts and capture the target lease through the repo action; verify menu and store tests, including cancel and stale-target behavior.

## 3. Verification
- [x] 3.1 Run bunx tsc --noEmit, bun run lint, bun run test, bun run build, cargo check, cargo fmt --check, cargo clippy, cargo test and bun run sizes; record results.
- [ ] 3.2 Launch bun run tauri dev and exercise the new command in a disposable repository with dirty current work; verify target rewrite and unchanged current state.

## Verification results
- Frontend: TypeScript, ESLint, build, and all 3,534 tests passed (308 files).
- Rust: cargo check, fmt check, all-target/all-feature Clippy passed; full suite passed (1,172 tests, 2 ignored), followed by the added Tauri IPC smoke test passing separately.
- The new IPC smoke test creates a disposable repository, squashes another branch through the real command/serde boundary, verifies dirty HEAD/index/worktree preservation, and rejects a reused lease.
- OpenSpec strict validation, git diff --check, and file-size ratchet passed.
- Native startup passed via bun run tauri dev on isolated port 1431. The click-through portion of 3.2 remains unverified: CUA cannot initialize because the configured writable workspace root is a symlink. No production repository history was rewritten during verification.
