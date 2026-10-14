# Design

## Context

See proposal.md (Why) for the motivation and specs/history/write-ops/spec.md for the required
behaviour. Current state that shapes the approach:

- `checkout_remote_branch` (`src-tauri/src/git/write/branch_checkout.rs`) takes the index write
  lock, rejects an in-progress operation, and classifies local vs remote
  (`classify_remote_checkout`). Then it always runs `switch_branch` followed by either
  `fast_forward_branch_at_locked` (which runs `merge --ff-only` once the branch is current) or
  `align_equivalent_sibling` (an `update-ref --stdin` transaction that verifies both oids).
- Measured on git 2.x in a scratch repo:
  - A `git switch` to the branch already checked out still fires `post-checkout`.
  - `merge --ff-only` fires `post-merge` on a real fast-forward but not on "Already up to date".
  - `git switch -q` suppresses "Switched to…" and the "Your branch is…" tracking lines, so only
    hook output and warnings are left.
- `run_git` → `finish` returns stdout+stderr trimmed **unredacted** on success; only
  `failure_message` redacts.
- Frontend: `src/store/repoWriteActions/checkout.ts` holds `checkoutBranch`,
  `checkoutRemoteBranch`, and `checkoutDetached`. They set `loading` (read only by the ActionBar to
  disable buttons) and return a fixed "Checked out X" string that most callers discard (RefPill
  double-click, `useBranchOp`). The pull action in `repoWriteActions/remotes.ts` already shows a
  `useNotifications` card of kind `progress` with `progress: "indeterminate"` and dismisses it in
  `finally`.

Engine: git CLI write (unchanged). No libgit2 writes, no forge involvement.

## Goals / Non-Goals

**Goals:**
- One working-tree change per remote-branch checkout, so each hook runs at most once.
- No IPC shape change. The two commands keep returning `String`; its contents become the
  redacted hook/warning output.
- Feedback lives in the store, so every checkout entry point gets it without touching callers.

**Non-Goals:**
- A generic "long write" progress framework for every write. The helper stays local to
  checkout.ts until a second consumer exists.
- Live streaming of hook output.

## Decisions

### D1. Move the ref first, then switch once

New flow for `checkout_remote_branch` when `refs/heads/<branch>` exists:

```
lock index; reject in-progress op
classify(local, remote) -> UpToDate | FastForward{local,target} | Aligned{local,target}
                                   -- Diverged -> Err, nothing moved
if current_branch == branch:
    UpToDate    -> nothing (no hook)
    FastForward -> fast_forward_branch_at_locked(local, target)  (quiet merge --ff-only; post-merge once)
    Aligned     -> align_equivalent_sibling (update-ref only, no hook)
    return
if any non-bare worktree holds branch (prunable included) -> Err (nothing moved)
FastForward / Aligned:
    update-ref --stdin: update local target local; verify remote target   (CAS, reflog message)
switch --no-guess -- <branch>                                            (post-checkout once)
```

The oids that classification captured are the compare-and-swap preconditions for every write, so
a ref that moves afterwards fails the write instead of being re-read and silently skipped. The
non-checked-out move uses the same `update-ref --stdin` transaction as the equivalent-sibling
alignment (`move_local_ref`), with its own reflog message. The other-worktree guard includes
prunable worktrees because git still refuses to switch to a branch one of them holds (for
example, a worktree on an unmounted volume).

**Alternative considered: `git switch -C <branch> <remote_oid>`.** It is one command, but it
force-resets without a compare-and-swap. Between classify and switch, an external `git` (a
terminal or another tool, which the in-app index lock does not cover) could move the branch and
that move would be clobbered silently. It also writes a "reset" reflog entry. Rejected.

**Alternative considered: keep the order and pass `-c core.hooksPath=/dev/null` to the first
switch.** That would silence the user's hooks for a real checkout, which breaks the CLAUDE.md
promise that writes honour hooks. Rejected.

### D2. Dirty-tree outcome changes from "half state" to "refused, ref advanced"

With the ref moved first, a switch that git refuses leaves HEAD and the working tree untouched,
while the local counterpart (not checked out) sits at the remote tip. That is the same state as
`git fetch origin develop:develop`. It is safe, and a retry then needs only the switch. The
current test `checkout_remote_branch_reports_switch_when_dirty_changes_block_fast_forward`
encodes the old half state. It changes to assert HEAD unchanged, the dirty file intact, and the
local ref advanced. The store's catch-path refresh stays, because the ref did move.

The error copy for that case changes from "{branch} is checked out, but it couldn't be
fast-forwarded…" to git's own switch error. The `{branch} is checked out, but…` wrappers remain
only on the current-branch path, where they are still true.

### D3. Hook output only from the switch helpers, redact in the checkout write

- `head::run_switch` backs `switch_branch`, `switch_detached`, and the `switch --track -c`
  create path. From a branch it passes `--quiet`. From a detached HEAD, `--quiet` would also hide
  git's "you are leaving N commits behind" warning, so that case runs loud and drops git's
  routine lines by prefix ("Switched to", "Previous HEAD position was", "HEAD is now at",
  tracking lines). The prefixes are stable because git's messages run in the pinned C locale.
  The helpers' other caller, `worktrees/handoff_move.rs`, only checks `Ok`/`Err`.
- `checkout`, `checkout_remote_branch`, and the `switch --track -c` create path return
  `redact::redact_secrets(&output)` for what the switch produced. The update-ref and merge steps'
  output is not returned (the merge's own `post-merge` output is the exception: on the
  current-branch path, return the merge output, redacted, with `-q` added to `merge --ff-only` so
  only hook output is left).
- This is done in `branch_checkout.rs` rather than in `finish`. Making `finish` redact on success
  would corrupt parser inputs (diffs, porcelain), which `finish` documents it must preserve.

### D4. Store-owned feedback with a delayed progress card

Add one local helper in `src/store/repoWriteActions/checkout.ts` (see Size for where it goes if
that file grows too large), shaped like the pull flow:

```
withCheckoutFeedback(label, run: () => Promise<string>) -> Promise<string>
  timer = setTimeout(() => id = notify({kind:"progress", title:`Checking out ${label}…`, progress:"indeterminate"}), 400ms)
  try   out = await run()
  finally clearTimeout(timer); if id: dismiss(id)
  if out.trim(): notify({kind:"info", title:`Checked out ${label}`, body: out.trim(), duration: 15s})
  return out
```

- 400 ms keeps ordinary checkouts free of flicker, while anything hook-bound shows within half a
  second. It is a constant in the helper, not a setting.
- On failure nothing new is added: callers already toast the error (`showToast(e, "error")`),
  and that toast already carries git's redacted stderr, including hook output.
- `body` holds the whole output; notification bodies keep line breaks, scroll past 42vh, and are
  selectable, so a git warning at the top and a hook verdict at the bottom both survive. The card
  stays 15 s (hover pauses it), long enough to read the verdict.
- A `mode` of "update" titles the cards "Updating/Updated X" for a branch advanced in place in
  another worktree. `createBranchAt`'s checkout goes through the same helper.
- `checkoutDetached` goes through `runOp`; wrap the inner `api.checkout` call so the card and
  the output follow the same rules.
- Store: `repo` (existing) for the actions, `notifications` for the cards (already imported by
  `remotes.ts`). No new store and no `ui.ts` change.

### IPC layers

No command, argument, or type changes. Behaviour changes only inside impl (layer 1); layers 2–4
(`commands/branches.rs` + `generate_handler!`, `git/types`, `src/lib/api/git/branches.ts`) are
untouched. Update the doc comment on the TS wrappers to say the string is hook/warning output.

## Risks / Trade-offs

- [The ref moves even when the switch is then refused] → It is a fast-forward or verified
  equivalent of a branch that is not checked out, under CAS. The spec allows it explicitly and a
  test pins it.
- [`-q` hides a git message something relied on] → Nothing parses the switch output today (the
  store ignores the return value). Grep for other `switch_branch` consumers was done:
  `handoff_move.rs` only checks the result.
- [Hook output that is noisy on every checkout (e.g. Docker lines) becomes a notification each
  time] → It is shown once, non-persistent (`info` auto-dismisses), and is the user's own hook
  talking. Consider a setting only if someone asks.
- [Timer leaks if the store action throws before `try`] → Start the timer immediately before the
  awaited IPC call, inside the `try`/`finally`.

## Size

`branch_checkout.rs` is 191 lines and `checkout.ts` is 187, both under the look band (Rust
251–400, React 201–400). The reorder adds about 20–30 lines in Rust; the helper adds about 25 in
TS. `repoWriteActions/shared.ts` is already 364 lines (in the look band), so don't grow it: if
`checkout.ts` would cross 200, the helper gets its own sibling `repoWriteActions/checkoutFeedback.ts`.
