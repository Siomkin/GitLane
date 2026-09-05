## 1. Request types (Rust + TS)

- [x] 1.1 Add `src-tauri/src/git/types/requests.rs` with `CommitRequest`, `SquashCommitsRequest`, `SquashRangeRequest`, `SquashBranchRequest`, `ApplyLineRequest`, `ResetToRequest` (`camelCase`, `deny_unknown_fields`, `#[serde(default)]` on optional expectations) and re-export them from `types.rs`; verify `cargo check` and one serde round-trip test per struct
- [x] 1.2 Add `src/lib/api/git/types/requests.ts` interfaces and strict zod schemas in `src/lib/api/schemas/requests.ts`; verify `bunx tsc --noEmit` and an `assertEqual`-style check that each schema's inferred type equals its interface

## 2. commit / squash family (PR 1)

- [x] 2.1 Change `commands/commits.rs::{commit, squash_commits, squash_range, squash_branch}` to `(path, request)` and the write-layer fns in `git/write/commits/{create,squash}.rs` and `git/write/squash_range.rs` to take the struct; remove their `too_many_arguments` allows; verify `cargo clippy --all-targets --all-features -- -D warnings` and `cargo test git::write::commits` pass
- [x] 2.2 Update `commitsApi.commit/squashCommits/squashRange/squashBranch` to `(path, request)` with `parse(requestSchema, …)` before `invoke`, and the store and composer call sites; verify `bun run test` passes after updating the `invoke` assertions in `store/repoWriteActions/*.test.ts` and `CommitComposer.test.tsx`
- [x] 2.3 Update `commands/registration_tests/argument_names.rs` to accept `request`; verify `cargo test registration_tests` passes
- [ ] 2.4 Exercise in `bun run tauri dev`: commit with a pinned identity and amend, squash two commits, squash a range; verify each succeeds and a stale expected head is refused with the existing error copy

## 3. apply_line / reset_to (PR 2)

- [x] 3.1 Change `commands/staging.rs::apply_line` + `git/write/patch_staging/apply.rs` and `commands/branches.rs::reset_to` + its write-layer owner to the request structs and remove the remaining allows; verify clippy is clean and `grep -rn too_many_arguments src-tauri/src` returns only the `registration_tests` double and the three private helpers (`oauth/mod.rs`, `status/history.rs`)
- [x] 3.2 Update `stagingApi.applyLine`, `branchesApi.resetTo`, and their store and feature call sites and tests; verify `bun run test` passes
- [ ] 3.3 Exercise in `bun run tauri dev`: stage and unstage a single line, run soft/mixed/hard resets with and without expectations; verify behaviour is unchanged

## 4. Definition of done

- [x] 4.1 `bunx tsc --noEmit`, `bun run lint`, `bun run test`, `bun run build`, `bun run sizes`, `(cd src-tauri && cargo fmt --all -- --check && cargo clippy --all-targets --all-features -- -D warnings && cargo test)`, and `openspec validate bundle-write-command-requests --strict` all pass; verify `git diff --stat` touches no command signature outside the bundled write commands (`commit`, `squash_commits`, `squash_range`, `squash_branch`, `apply_line`, `reset_to`)
