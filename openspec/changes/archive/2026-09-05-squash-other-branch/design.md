## Context
See proposal.md. Eligibility currently walks HEAD only, and the context menu drops Squash when that walk cannot reach the selection. The existing below-tip squash builds commits with Git plumbing and compare-and-swaps a local branch.

## Goals / Non-Goals
Preserve the current branch tip, index, working files, and ORIG_HEAD when rewriting another local branch. Keep existing checked-out tip squash behavior, including hooks. No checkout/stash orchestration or new dependencies.

## Decisions
- Engine: real Git CLI writes, with existing branch guards and libgit2-backed guard reads where available. Reuse the existing range validation and commit construction; put shared helpers in a focused squash_range submodule if needed for the 400-line ceiling.
- Resolve candidates with a pure repo-store helper from local branch labels and first-parent eligibility. Prefer the existing current-branch action when eligible; otherwise expose named actions for every eligible local target. Do not guess between branches sharing history.
- Capture the chosen branch and tip in the prompt closure and pass that lease through the repo store. Reject moved/deleted/symbolic targets and targets checked out in any worktree. Recheck after potentially slow signing and immediately before a no-deref compare-and-swap update.
- Add a distinct squash_branch IPC command so existing squash_range and squash_commits callers keep their contract. Four layers: shared Rust rewrite implementation; async commands/commits.rs plus lib.rs registration; scalar String/Option arguments and existing CapturedIdentity types; matching typed lib/api/git/commits.ts wrapper. No new wire response shape.
- Other-branch rewrites leave ORIG_HEAD alone; recovery uses the chosen branch's reflog, explicitly created when updating it. All objects are built before the ref moves. The repo store refreshes after writes and errors and clears only its owned selection.
- Pure target resolution goes in its own module, rather than growing selection.ts above its ceiling. Extract squash menu construction at its natural seam if the context menu would grow past its ceiling. No new store or services layer.

## Risks / Trade-offs
- External Git operations can race precondition checks → use tip CAS, recheck worktree ownership and remote reachability after signing; existing guard-versus-write microsecond race remains.
- Branch refs can be shared → update only the explicitly named target and preserve other refs.
- Plumbing bypasses commit hooks, like existing below-tip squash → state this in the other-branch prompt; keep identity/signing checks.
- Published commits, merges, missing graph history and root ranges stay ineligible. Targets checked out elsewhere fail with an actionable error.

## Migration Plan
No data migration. Revert code to remove the new action. Successful rewrites can be recovered from the target branch reflog; do not suggest resetting the unrelated current branch.
