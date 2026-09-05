## Why

Five write commands cross IPC as eight to ten positional arguments — `commit` (9), `squash_commits` (9), `squash_range` (10), `apply_line` (9), `reset_to` (8) — and between them they account for eleven of the tree's fifteen `#[allow(clippy::too_many_arguments)]` sites: the five commands plus their write-layer functions (`commit` has three: `commit`, `commit_locked`, `commit_expected`; `reset_to` has none). The remaining four are the `registration_tests` double and three private helpers (`run_device`, `run_pkce`, `commit_entry`). Positional lists are where the snake_case↔camelCase mapping is hand-maintained (the one IPC drift the registration tests cannot catch), where optional expectations (`expected_branch`, `expected_oid`, `expected_state`) travel as `null` by position, and where every new guard field touches five files. One typed request object per command removes the allows, makes the wire shape self-describing, and lets the API-seam validation cover the request as well as the response.

No Jira key (GL-xx) for this change. Touches Rust (`git/write/{commits,squash_range,patch_staging,recovery}`, `commands/{commits,staging,branches}.rs`, `git/types/`), the IPC contract, and the frontend (`src/lib/api/git/{commits,staging,branches}.ts`, `src/lib/api/schemas/`, store call sites). Deltas `openspec/specs/ipc/commands/`.

## What Changes

- **BREAKING (internal IPC only)**: `commit`, `squash_commits`, `squash_range`, `apply_line`, and `reset_to` take `(path, request)`, where `request` is a serde `camelCase` struct (`CommitRequest`, `SquashCommitsRequest`, `SquashRangeRequest`, `ApplyLineRequest`, `ResetToRequest`) declared under `git/types/` and mirrored as a TS interface plus a strict zod schema. Command names are unchanged; there is no external caller.
- The write-layer functions take the same struct, removing all eleven command and write-layer `too_many_arguments` allows; `commands/registration_tests/argument_names.rs` learns the `request` argument.
- Optional expectations become optional fields (`expectedBranch?`, `expectedOid?`, `expectedState?`, …) whose absence means "no expectation" — the same semantics as today's `null`.
- The TS wrappers validate the request with the existing `parse()` helper before `invoke`, so a missing required field fails at the seam with a structured error and never reaches git.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `ipc/commands`: adds the requirement that a multi-field write command carries its inputs as one validated request object beside the repository locator, with absent optional expectations meaning "no expectation".

## Impact

- Rust: five command fns; write-layer fns in `git/write/commits/create.rs` (`commit`, `commit_locked`, `commit_expected`), `git/write/commits/squash.rs`, `git/write/squash_range.rs`, `git/write/patch_staging/apply.rs`, and the `reset_to` owner under `git/write/`; new `git/types/requests.rs` re-exported from `types.rs`. `lib.rs` `generate_handler!` is unchanged.
- Frontend: `commitsApi.commit/squashCommits/squashRange`, `stagingApi.applyLine`, `branchesApi.resetTo`; the `api.commit` call sites in the store (3) plus the squash, line-apply, and reset call sites under `store/repoWriteActions/` and `features/changes`; new `src/lib/api/git/types/requests.ts` and `src/lib/api/schemas/requests.ts`.
- Tests: `commands/registration_tests/argument_names.rs`; store and feature tests that assert `invoke` arguments (`store/repoWriteActions/*.test.ts`, `features/changes/commit-modal/CommitComposer.test.tsx`, patch-staging and reset tests).
- Secrets/auth/IPC risk: none of these commands carries a credential and the change must not add one; `name`, `email`, and `identity` are non-secret author metadata and keep their meaning. The IPC contract changes for five commands only, landed with all four layers in each PR.
- Pattern to copy: `clone_repo`'s `auth: TransportAuthRef` argument and `commitsApi.stashPaths`'s object argument already cross IPC as structs; `git/types/error.rs` ↔ `src/lib/api/git/types/error.ts` shows the mirrored declaration style; `src/lib/api/schemas/assertEqual.ts` shows how a schema and its interface are kept in agreement.

## Non-goals

- Touching commands with fewer inputs, or any read command.
- Changing guard semantics (expected head, branch, and operation-state checks behave exactly as before).
- Generating TS from Rust (codegen is a separate backlog decision).
