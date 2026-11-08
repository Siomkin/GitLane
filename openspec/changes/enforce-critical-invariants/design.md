# Design

## Context

See proposal.md for the problem.

Constraints that shape the approach:

- Writes go through the git CLI. Repository-local env such as `GIT_INDEX_FILE` is deliberately cleared in `git/write/cli`, and a test in `cli.rs` pins that.
- Fetch stays outside the index mutex so a long network call does not block staging.
- The git floor is 2.36.0, so `fetch --porcelain` (2.41) is unavailable.

## Goals / Non-Goals

**Goals:** each of the nine properties is checked at the point of use and has a test that fails if the check is removed.

**Non-Goals:** closing the races against arbitrary external processes entirely; the guards narrow them to what git's own ref and lock handling allows.

## Decisions

### Engines and state

All git changes are git CLI writes under `git/write/`. Forge changes go through `forge::context()`. The Zustand work is in `repo` and `pulls`; no new store. No graph or layout work.

### UI-1: one guard at user entry points

Add `guardDirtyFileView(run)` beside `requestOpenRepoFile`, reusing `DISCARD_UNSAVED_CONFIRM` and the existing re-check of `edit.saving` at confirm time. Route the user-initiated exits through it:

- tab select in `RepoTabStrip`, `activateTabAt` (⌘1-9), and `closeRepo` when the closing tab is the active one;
- `loadRepo` calls from worktree switch and add in `repoWriteActions/worktrees.ts`;
- `selectFile`, `selectCommitMulti`, `selectWip`, `returnToGraph` and its reveal callers, compare, and file history, at their user-facing call sites.

The guard stays at call sites rather than inside `loadRepo`, because several callers await its result.

`ensureWorkingFileSelection` and `reselectAfterPatch` only reconcile `selectedFile`, so they leave an open `fileView` alone instead of going through `selectFile`'s clear.

Guarding entry points rather than every `fileView: null` writer keeps programmatic wipes working, such as a repository that has vanished.

Window close uses `getCurrentWindow().onCloseRequested`. macOS ⌘Q does not reliably raise a window close request, so the app menu's Quit, built in `lib.rs`, becomes a custom item that routes through the same close path. `restart` in `store/updates.ts` calls the guard too. A native terminate (Dock Quit, log-out) reaches only `applicationWillTerminate:` in tao and cannot be intercepted.

*Alternative rejected:* keeping drafts per tab. It is larger and does not cover quit.

### LIFE-1: a live git process means the lock is live

`classify_lock` gains a third gate after age and openers: if any `git` process is running on the machine, the lock is not stale. This holds through a pre-commit hook because the parent `git commit` stays alive while the hook runs.

The probe is `ps -eo args=` on macOS and Linux, matching a first token whose basename is `git` or starts with `git-`, and skipping arguments containing `daemon` (fsmonitor, credential-cache). Windows uses `tasklist /FI "IMAGENAME eq git.exe" /FO CSV /NH` and detects a `git.exe` row, never the localized no-match text. A probe failure reads as not stale, matching the existing opener error path. The probe sits behind a test override like `TEST_OPENERS_OVERRIDE`.

*Alternatives rejected:* a longer `STALE_AFTER`, because hooks have no upper bound; scoping to processes in this repo, because reading another process's cwd needs per-platform code, and a false "live" only withholds one-click removal.

### GIT-2: snapshot, unless the carry is already over

`handoff::write_marker` adds a `head <oid>` line. `read_marker` returns only stash oids, because `continue_carry` drops every entry it returns, and a new reader returns the HEAD. `abort_carry` already runs under the index lock `abort_operation` holds, and takes the stash guard second as `stashes.rs` does; it must not take the index lock again, since that mutex is not reentrant. Then:

1. If HEAD differs from the recorded oid, clear the marker, keep the stashes, change no file, and report that the carry ended. Git refuses commits and checkouts while entries are unmerged, so a moved HEAD means the conflict is gone and there is nothing to reset. A marker from an older build has no line, so this check is skipped.
2. Snapshot tracked content from a copy of the real index, so files staged after the carry are included: copy the index to a temp path, add only the unmerged paths and `write-tree` as `S` (what is staged), then `add -u` and `write-tree` as `T` (the working files), `I = commit-tree S -p HEAD`, `W = commit-tree T -p HEAD -p I`, then `stash store -m "GitLane: carry abort backup" W`. The two-parent shape is required; `stash store` rejects a single-parent commit. Skipped if `S` and `T` both equal HEAD's tree, and not stored twice if a retry finds the same tree on top.
3. Run `reset --hard HEAD` and clear the marker.

`git stash create` cannot do step 2 because it fails with unmerged entries. Because `GIT_INDEX_FILE` is cleared by the normal runners, add one purpose-built runner in `cli/` that sets it after the clear, and test that the real index is untouched.

`AbortConfirm` copy and the success message name the backup. Untracked files are unaffected by `reset --hard`.

*Alternatives rejected:* the confirm-time exact-state lease from `reset_branch`, which only covers the time between dialog and click; refusing on a moved HEAD, which leaves Finish, which drops the carried work, as the only in-app exit.

### GIT-1: reuse the claim check

Replace the `worktrees().find(...)` body of `ensure_branch_not_checked_out` with `branch_claim`, which already covers checkout, rebase, and bisect, and keeps the "Cannot delete branch" wording via `describe()`. Do the same in `squash_range/target.rs`. Both `delete_branch` and the re-check in `delete_branch_with_worktree` get it automatically.

### GIT-3: pull by captured OID

Immediately after the fetch returns, before waiting for the index lock, read `FETCH_HEAD` from the worktree's git dir and pick the first for-merge line whose description is `branch '<short merge_ref>' of`. A missing line is an error. Carry that OID into the locked section and run `merge --ff-only <oid>`. At git 2.54, fetching by short name and by `refs/heads/` name both recorded `branch '<name>' of`, and a tag entry read `tag '<name>' of`, so it cannot match. The 2.36.0 floor is still to be confirmed (tasks). A concurrent fetch of the same ref in the moment before the read can still supply a newer commit of that same ref.

*Alternative rejected:* fetching into a private `refs/gitlane/*` ref, which leaves a ref behind on a crash and fires `reference-transaction` hooks.

### GIT-4: merge the OID, generate the same message

In `merge_into`, resolve the validated source to an OID and build the message with `git fmt-merge-msg` through `run_git_with_input`, feeding one line chosen by source kind: `refs/heads/x` gives `<oid>\t\tbranch 'x' of .`, `refs/remotes/x` gives `remote-tracking branch 'x' of .`, and anything else gives `<oid>\t\tcommit '<oid>'`, with no ` of .` suffix, because adding one garbles the subject into `Merge commit commit '<oid>'`. Then run `merge --no-ff --no-edit --no-log -m <msg> <oid>`; `--no-log` stops git appending a second shortlog under `merge.log`. At git 2.54 the subjects for local, remote-tracking, `into <branch>`, and commit sources matched native `git merge`, and "Already up to date." is unchanged with an OID operand. The 2.36.0 floor is still to be confirmed (tasks). `merge_source_operand` goes away.

### FORGE-1: read the PR back before writing it

`merge_pull_request`, `merge_pull_request_stack`, `approve_pull_request`, `set_pull_request_state`, and `resolve_review_thread` take a required `pr_url`, the `url` on the row the user acted on. `link_pull_request_stack` takes `pr_urls`, one per number.

A `forge_op` variant runs `p.pr_detail(ctx, number)` with the same `ctx` the write will use and refuses unless the returned `url` equals `pr_url`, comparing case-insensitively and ignoring a trailing slash. The target is then resolved once, and the write cannot be pointed elsewhere between check and use. A `pr_detail` failure, including not found, stops the write.

Because both URLs come from the provider, renames and case differences in the remote URL do not cause a false refusal, and no web-host or nested-group parsing is needed.

IPC layers for each command: the check in `git/forge`; the signature in `commands/github.rs`, with its `generate_handler!` entry unchanged; no DTO change; the TS wrapper in `src/lib/api/github.ts`, with the row's URL passed from `src/store/pulls/writes.ts`. All six commands are `LOCAL_ONLY` in `registration_tests/remote_split.rs` and stay there.

*Alternative rejected:* matching the URL against `ctx.repository`, which refuses legitimate writes after a rename or a case difference and needs a provider-aware URL parser.

### FORGE-3: pattern pass independent of URLs

Remove the early `://` return as the only path: after the existing userinfo pass, add a linear token scanner that replaces tokens starting with any `TOKEN_USERNAME_PREFIXES` entry, values after `Authorization:` (scheme retained), and `private_token=` / `access_token=` query values. Add `ATATT`. Mirror the prefix in `src/lib/remotes.ts`. Scan without regex backtracking; no new dependency.

### FORGE-2: narrow the promise

No broker change. Add a test that records a pre-push hook's environment in `providerToken` mode and asserts the token value is absent. Correct the module doc and the test comment at `credential_bridge.rs:451`, and state in `docs/rules/architecture-rules.md` that hooks are trusted user code that can reach git's configured credential route.

### Size ceiling

`repoFilesActions.ts`, `redact.rs`, and `index_lock.rs` are likely growth points. If `bun run sizes` flags one, split out the new logic (`guardDirtyFileView`, the token scanner, the process probe) into a sibling module.

## Risks / Trade-offs

- [The process probe treats any running `git` on the machine as live, including a `git log` left open in a pager] → It only withholds one-click removal, and the message tells the user to finish other git commands.
- [Windows `tasklist` cannot see arguments, so a fsmonitor daemon always reads as live] → Windows users with that daemon lose one-click removal and get the refusal message.
- [`onCloseRequested` needs a permission and can leave a window unclosable if the handler throws] → The handler catches errors and allows the close.
- [FETCH_HEAD description format is not a formal contract] → A mismatch refuses the pull with an error rather than merging, and a test pins the format.
- [A recovery stash per abort adds clutter] → It only appears when tracked edits exist, and its name states its purpose.
- [A provider's list and detail responses could format the same PR's URL differently, which would refuse its writes] → A test compares both mappers for every provider.
- [Each PR write makes one extra provider read] → Writes are user-initiated and infrequent.

## Migration Plan

No data migration. A carry marker from an older build still parses and gets the snapshot, but not the HEAD check.
