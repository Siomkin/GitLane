# Tasks

## 1. Types

- [x] 1.1 In `git/types/requests.rs`, beside `MergeMethod`, add three `#[derive(Debug, Clone, Copy, PartialEq, Eq)]` enums with no serde, each with a one-line `from_*(bool)` constructor:
  - `BranchAfterMerge { Keep, Delete }` with `from_delete_branch`
  - `ThreadResolution { Resolved, Unresolved }` with `from_resolved`
  - `DraftState { Ready, Draft }` with `from_draft`

## 2. Rust impl: merge

- [x] 2.1 Change `ForgeService::merge_pr` in `git/forge/service.rs` to take `after: BranchAfterMerge`. Update the impls in `gh_provider.rs`, `gitlab/mod.rs`, `bitbucket/mod.rs` and `origin/mod.rs`, and the mock in `write_target.rs`.
- [x] 2.2 Take `BranchAfterMerge` in the provider functions:
  - `prs/merge.rs::merge_pr` and `merge_pr_args`, so the `--delete-branch` flag comes from a match;
  - `gitlab/ops.rs::merge_pr`;
  - `bitbucket/ops.rs::merge_pr`;
  - `origin/ops.rs::merge_pr`, which keeps ignoring it.

  Update their in-file tests. Verify with `cargo test forge::` and confirm that the `merge_pr_args` assertions are unchanged.

## 3. Rust impl: threads and draft

- [x] 3.1 Change the `ForgeService::set_thread_resolved` default method to take `ThreadResolution`, and update the impls in `gh_provider.rs` and `origin/mod.rs`, `threads.rs::set_thread_resolved`, and `origin/ops.rs::{set_thread_resolved, thread_set_resolved_args}`. Update their in-file tests.
- [x] 3.2 Take `DraftState` in `gitlab/ops.rs::create_pr` and `bitbucket/ops.rs::create_pr`. Convert `input.draft` with `DraftState::from_draft` in `gitlab/mod.rs` and `bitbucket/mod.rs`. Update `gitlab/ops.rs` tests and `bitbucket/ops/tests/mutations.rs`, keeping the draft-prefix test's expectation as it is.

## 4. Command layer: keep the wire `bool`

- [x] 4.1 In `commands/pulls.rs`, keep `delete_branch: bool` and `resolved: bool` on `merge_pull_request` and `resolve_review_thread`, and pass `BranchAfterMerge::from_delete_branch(delete_branch)` and `ThreadResolution::from_resolved(resolved)`. Verify that `cargo test registration` still passes unchanged.
- [x] 4.2 Add a `#[cfg(test)]` unit test in `commands/pulls.rs` (or beside the enums in `git/types/`) asserting both mappings of each constructor: `from_delete_branch`, `from_resolved` and `from_draft`.

## 5. Definition of done

- [x] 5.1 `(cd src-tauri && cargo fmt --all -- --check)` passes.
- [x] 5.2 `(cd src-tauri && cargo clippy --all-targets --all-features -- -D warnings)` and `(cd src-tauri && cargo clippy --all-targets --no-default-features --features agent -- -D warnings)` pass.
- [x] 5.3 `(cd src-tauri && cargo test)` passes with no change to any existing test's expected output.
- [x] 5.4 `bun run sizes` passes.
