## Why
Selecting two adjacent commits on PIS-1803 while PIS-1802 is checked out hides Squash. Users should be able to combine selected commits on their local branch without disturbing their current work.

## What Changes
- Resolve eligible local target branches from the selection, preserving the existing current-branch squash path.
- Offer squash on another local branch and name that branch in the message prompt; offer explicit branch choices if several qualify.
- Rewrite only the chosen branch using guarded Git plumbing, preserving HEAD, index, working files, and current ORIG_HEAD.
- Retain restrictions on published history, merges, roots, and noncontiguous selections; reject targets checked out in another worktree.

## Capabilities
### New Capabilities
None.
### Modified Capabilities
- `history/write-ops`: squash selected commits on a local branch other than HEAD.

## Impact
Rust, frontend, and IPC. Extend the patterns in `git/write/squash_range.rs`, `commands/commits.rs`, `lib/api/git/commits.ts`, and the repo store/context menu. No Jira key exists for this change. No dependencies or authentication changes; IPC must carry an explicit branch and expected tip, with no secrets.

## Non-goals
No automatic checkout, stash, push, published-history rewriting, merge flattening, or mutation of other branches sharing the old commits.
