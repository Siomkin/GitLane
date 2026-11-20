# Proposal

## Why

This is one of four per-area changes that finish PR #626's (`rust-flag-enums-and-imports`) mode-`bool` cleanup. The inventory came from a multi-line scan of `src-tauri/src`; `rust-bool-modes-misc` lists every scan row left out and why. Patch staging is not part of this set: PR #626 itself finishes `IndexSide` there.

The forge write path carries three mode flags through the `ForgeService` trait and each provider. At the call site they read as `merge_pr(ctx, 7, method, true)`, `set_thread_resolved(ctx, 7, id, false)` and `create_pr(api, repo, base, head, title, body, true)`.

There is no Jira issue. This change touches **Rust only**: no IPC signature, wire format or frontend change.

## What Changes

The three enums go in `git/forge/modes.rs`, re-exported from `git::forge`, so `git::types` keeps only wire types. The commands, the trait and every provider can all see them. They are plain `Copy` enums with no serde.

- **`BranchAfterMerge { Keep, Delete }`** replaces `delete_branch: bool` on:
  - the `ForgeService::merge_pr` trait method and its impls in `gh_provider.rs`, `gitlab/mod.rs`, `bitbucket/mod.rs`, `origin/mod.rs`, and the test mock in `write_target.rs`;
  - the provider functions `prs/merge.rs::merge_pr` and its in-file `merge_pr_args`, `gitlab/ops.rs::merge_pr`, `bitbucket/ops.rs::merge_pr`, and `origin/ops.rs::merge_pr` (which ignores it today: `_delete_branch`).
- **`ThreadResolution { Resolved, Unresolved }`** replaces `resolved: bool` on:
  - the `ForgeService::set_thread_resolved` default method and its impls in `gh_provider.rs` and `origin/mod.rs`;
  - `threads.rs::set_thread_resolved`;
  - `origin/ops.rs::set_thread_resolved` and `thread_set_resolved_args`.
- **`DraftState { Ready, Draft }`** replaces `draft: bool` on `gitlab/ops.rs::create_pr` and `bitbucket/ops.rs::create_pr`. Their single callers in `gitlab/mod.rs` and `bitbucket/mod.rs` convert `input.draft` with `DraftState::from_draft`. `PrCreateInput.draft` is a wire field and stays a `bool`.
- **Command parameters stay `bool`.** `commands/pulls.rs::merge_pull_request(delete_branch)` and `resolve_review_thread(resolved)` keep the wire `bool` and convert once:
  - `BranchAfterMerge::from_delete_branch(delete_branch)`
  - `ThreadResolution::from_resolved(resolved)`

  The agent's `dispatch.rs` calls those command fns, so it needs no change.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

None. `skip_specs: true`: a pure refactor with identical behaviour and no wire change. The CLI arguments and REST bodies built from these values must stay byte-identical, and the existing `*_args` tests pin them.

## Ordering

This change is independent of the other four.

## Non-goals

- **`bounded_output/finish.rs::finish_bytes(success, .., stderr_truncated, ..)`.** Both are facts about a finished process, not modes.
- **DTO `bool` fields** (`is_resolved`, the origin `resolved`, `PrCreateInput.draft`). These are wire or provider data.
- **Splitting the trait or changing provider capability defaults.**

## Impact

- **Code:**
  - `src-tauri/src/git/forge/modes.rs` (new) and `src-tauri/src/git/forge.rs`;
  - `src-tauri/src/git/forge/{service,gh_provider,threads,write_target}.rs`;
  - `git/forge/prs/merge.rs`;
  - `git/forge/{gitlab,bitbucket,origin}/{mod,ops}.rs`;
  - `git/forge/bitbucket/ops/tests/mutations.rs`;
  - `commands/pulls.rs`.

  About 30 call sites in total, most of them in in-file tests.
- **Secrets / auth / IPC risk:** none. No command signature changes, and no token handling moves.
- **Pattern to copy:** `Channel::from_beta` (PR #626) for the constructors. `MergeMethod`'s placement shows where shared forge request types live.
