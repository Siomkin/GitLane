# Tasks

Each numbered group is one finding and is complete on its own: code, tests, docs, and checks. Groups run in this order.

## 1. Index lock (LIFE-1)

- [x] 1.1 Add the running-git probe with a test override in `git/write/index_lock.rs`, per design (Unix `ps`, Windows `tasklist` CSV, daemons skipped, failure reads as live)
- [x] 1.2 Gate `classify_lock` on the probe after the age and opener checks, with a detail message telling the user to finish other git commands
- [x] 1.3 Test: old lock with no openers and a live git is not stale and is not removed; the same with no git is removable; probe failure is not stale
- [x] 1.4 Test the `ps` parser against lines for `git commit`, `/usr/bin/git`, `git-remote-https`, `git fsmonitor--daemon run`, and non-git processes, and the `tasklist` parser against CSV rows with and without `git.exe`
- [x] 1.5 Pass `cargo fmt --all -- --check`, `cargo test`, and clippy for the default and `agent` feature sets

## 2. Branch claims (GIT-1)

- [x] 2.1 Make `ensure_branch_not_checked_out` in `write/branches/delete.rs` use `branch_claim`, keeping the "Cannot delete branch" wording
- [x] 2.2 Use `branch_claim` in `write/squash_range/target.rs`
- [x] 2.3 Test: deleting a branch paused in a rebase is refused and `rebase --continue` still works; a bisecting branch is refused; `delete_branch_with_worktree` refuses a rebasing branch
- [x] 2.4 Test: squash on a branch being rebased or bisected elsewhere is refused and the ref is unchanged
- [x] 2.5 Pass `cargo fmt --all -- --check`, `cargo test`, and clippy for the default and `agent` feature sets

## 3. Carry abort (GIT-2)

- [x] 3.1 Add the `head <oid>` marker line in `git/handoff.rs`, a reader for it, and keep `read_marker` returning only stash oids
- [x] 3.2 Pass the carry's HEAD to `write_marker` from `write/worktrees/handoff_move.rs`
- [x] 3.3 Add a runner in `write/cli/` that sets a temporary index file after the environment clear, with a test that the real index is untouched
- [x] 3.4 Implement the snapshot from a copy of the real index and `stash store` of a two-parent commit named `GitLane: carry abort backup`, skipped when the tree matches HEAD
- [x] 3.5 Rewrite `abort_carry` in `write/conflict_resolution.rs` under the index lock `abort_operation` already holds, with the stash guard second: a moved HEAD clears the marker and changes nothing; otherwise snapshot, reset, clear the marker
- [x] 3.6 Update `src/features/conflicts/AbortConfirm.tsx` and the success messages to name the backup stash and the moved-HEAD outcome
- [x] 3.7 Test: a moved HEAD changes no file, keeps the recorded stashes, and clears the marker; later tracked edits land in the backup; a file staged after the carry is in the backup; unmerged entries are backed up; the backup re-applies; a clean tree creates no stash; a marker with no head line still aborts with a snapshot; `continue_carry` ignores the head line
- [x] 3.8 Confirm the two-parent `stash store` against git 2.36.0, the supported floor
- [x] 3.9 Pass the Rust checks from 1.5 and `bun check`, `bun run lint`, `bun run test`, `bun run build`, `bun run sizes`, and `bun run cycles`
- [x] 3.10 In `bun run tauri dev`, abort a carry after editing tracked files and find the edits in the backup stash

## 4. Pull by OID (GIT-3)

- [ ] 4.1 Add a `FETCH_HEAD` reader in `write/remotes/pull.rs`, called immediately after the fetch and before the index lock, that returns the for-merge oid for the requested ref, accepting both `name` and `refs/heads/name`
- [ ] 4.2 Run `merge --ff-only <oid>` under the lock with the captured oid and return an error when no entry matched
- [ ] 4.3 Test: a `FETCH_HEAD` holding an explicit tag fetch does not move the branch to the tag; a missing entry leaves the branch unmoved; the normal pull still works
- [ ] 4.4 Confirm the `FETCH_HEAD` format against git 2.36.0, the supported floor
- [ ] 4.5 Pass the Rust checks from 1.5

## 5. Merge by OID (GIT-4)

- [ ] 5.1 In `write/history/merge.rs`, resolve the source to an oid, build the message with `fmt-merge-msg` over `run_git_with_input` using a line chosen by source kind, run `merge --no-ff --no-edit --no-log -m <msg> <oid>`, and remove `merge_source_operand`
- [ ] 5.2 Test: messages for a local branch, a remote-tracking branch, a raw commit, and `into <branch>` match today's byte for byte, with and without `merge.log`; second parent equals the validated oid; "Already up to date" output is unchanged
- [ ] 5.3 Confirm the `fmt-merge-msg` input and `--no-log` against git 2.36.0, the supported floor
- [ ] 5.4 Pass the Rust checks from 1.5

## 6. Redaction (FORGE-3)

- [ ] 6.1 Add the linear token scanner to `src-tauri/src/redact.rs` and run it on all text, including text with no URL
- [ ] 6.2 Add `ATATT` to `TOKEN_USERNAME_PREFIXES` and the mirror in `src/lib/remotes.ts`
- [ ] 6.3 Test bare tokens for each prefix, `Authorization` values, token query parameters, tokens containing `=`, and unchanged ordinary text
- [ ] 6.4 Pass the Rust checks from 1.5 and the frontend checks from 3.9

## 7. Token boundary (FORGE-2)

- [ ] 7.1 Add a provider-token push test with a pre-push hook that records env and argv and asserts the token value is absent
- [ ] 7.2 Add a broker test that answers repeated requests for the expected host
- [ ] 7.3 Correct the module doc and the comment at the token-environment test in `git/credential_bridge.rs`
- [ ] 7.4 State the hook trust boundary in `docs/rules/architecture-rules.md`
- [ ] 7.5 Pass the Rust checks from 1.5

## 8. PR write target (FORGE-1)

- [ ] 8.1 Add the read-back check in `git/forge`: `pr_detail` with the write's context, URL compared case-insensitively and ignoring a trailing slash, with a refresh message on mismatch
- [ ] 8.2 Add a `forge_op` variant in `commands/github.rs` that runs the check and the write with one resolved context
- [ ] 8.3 Add a required `pr_url` to `merge_pull_request`, `merge_pull_request_stack`, `approve_pull_request`, `set_pull_request_state`, and `resolve_review_thread`
- [ ] 8.4 Add `pr_urls` to `link_pull_request_stack`, checking each number
- [ ] 8.5 Update the wrappers in `src/lib/api/github.ts` and pass the row's `url` from `src/store/pulls/writes.ts`
- [ ] 8.6 Test that the list and detail mappers produce the same URL for one PR on GitHub, GitLab, Bitbucket, and Cursor Origin
- [ ] 8.7 Test: a mismatched URL, and a `pr_detail` failure, each stop before the write call; case and trailing-slash differences pass; the store shows the refresh message
- [ ] 8.8 Pass the Rust checks from 1.5 and the frontend checks from 3.9
- [ ] 8.9 In `bun run tauri dev`, confirm Merge on a current PR list still works

## 9. Unsaved editor drafts (UI-1)

- [ ] 9.1 Add `guardDirtyFileView` in `src/store/repoFilesActions.ts`, reusing `DISCARD_UNSAVED_CONFIRM` and the `edit.saving` re-check
- [ ] 9.2 Route tab select in `RepoTabStrip.tsx`, `activateTabAt` in `useShortcuts.ts`, `closeRepo` when the closing tab is the active one, and the `loadRepo` calls in `repoWriteActions/worktrees.ts` through the guard
- [ ] 9.3 Route `selectFile`, `selectCommitMulti`, `selectWip`, `returnToGraph` and its reveal callers, compare, and file history through the guard at their user-facing call sites
- [ ] 9.4 Make `ensureWorkingFileSelection` and `reselectAfterPatch` leave an open `fileView` untouched
- [ ] 9.5 Add the `core:window:allow-destroy` capability and record it in `docs/tauri-plugin-decisions.md`
- [ ] 9.6 Add an `onCloseRequested` handler that uses the guard and allows the close if the handler fails
- [ ] 9.7 Make the macOS Quit menu item in `lib.rs` route through the same close path
- [ ] 9.8 Guard `restart` in `src/store/updates.ts`
- [ ] 9.9 Test each entry point, including ⌘1-9 and worktree switch: confirm appears when dirty, decline keeps the draft, clean state shows no confirm; closing a background tab shows no confirm; opening Details or staging a file keeps the editor open; a programmatic wipe stays unguarded
- [ ] 9.10 Pass the Rust checks from 1.5 and the frontend checks from 3.9
- [ ] 9.11 In `bun run tauri dev`, confirm ⌘Q, window close, ⌘2, and tab switch each prompt with a dirty editor

## 10. Integration

- [ ] 10.1 With all nine groups in place, pass `cargo check`, the Rust checks from 1.5, and the frontend checks from 3.9

## Workflow follow-up

Reference only, outside tracked progress. `/opsx:apply` does not perform these. Each commit, push, and PR needs the user's go-ahead at the time.

**Stack.** One PR per finding, in group order. The first targets `latest`; each later PR targets the one before it. Use `gh stack`, signed commits, and push at most 3 branches at a time, then link the stack and mark the PRs ready.

| PR | Group | Finding | Branch | Diagrams |
| --- | --- | --- | --- | --- |
| 1 | 1 | LIFE-1 | `fix/invariant-index-lock` | Yes: why an old lock with no opener can be live |
| 2 | 2 | GIT-1 | `fix/invariant-branch-claims` | No: reuses an existing check |
| 3 | 3 | GIT-2 | `fix/invariant-carry-abort` | Yes: abort paths and backup |
| 4 | 4 | GIT-3 | `fix/invariant-pull-oid` | Yes: fetch and merge ordering |
| 5 | 5 | GIT-4 | `fix/invariant-merge-oid` | Yes: validation and merge ordering |
| 6 | 6 | FORGE-3 | `fix/invariant-redaction` | No: one scanner, no new flow |
| 7 | 7 | FORGE-2 | `fix/invariant-token-boundary` | No: tests and docs |
| 8 | 8 | FORGE-1 | `fix/invariant-pr-write-target` | Yes: read-back across layers |
| 9 | 9 | UI-1 | `fix/invariant-editor-drafts` | Yes: guarded exits |

**Each PR.**

- Holds only its group's code, tests, and docs, and ticks that group's boxes in this file.
- Gets a comment from the `implementation-comment` skill after the work lands.
- Where the table says Yes, gets `implementation-diagrams` output as HTML and PNG in `docs/diagrams/<feature>/`, committed in that PR and embedded by a commit-SHA raw URL.
- If a Jira issue exists for the finding, its key goes in the branch name and PR title.

**First PR** also carries this change folder.

**Archive** happens only when the user asks.
