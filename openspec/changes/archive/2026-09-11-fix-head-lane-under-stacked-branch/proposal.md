## Why

When the checked-out commit has been merged into another branch (a merge whose second parent is HEAD) **and** a further branch is stacked on top of HEAD, the swimlane graph renders HEAD in the stacked branch's column. The merge's connector then runs straight down through the stacked branch's commits, so the graph reads as if the merge absorbed that unrelated branch. Reported on a real repo: `web-app/develop` "Merged in PIS-1802 (#118)" appeared to contain the four PIS-1804 commits, which are not its ancestors; every other client draws the merge reaching PIS-1802 directly.

No Jira key (GL-xx) for this change. Rust only (`src-tauri/src/git/graph/layout/`); no IPC, type, or frontend change — the painter is already correct for the coordinates it receives.

## What Changes

- Lane claim rule: when a commit is awaited by both a branch-root lane (a merge introduced it as a topic branch) and a first-parent continuation lane (a child branch continues into it), the branch-root lane wins — for every commit, HEAD included. Today the checked-out commit alone inverts that priority (`cont` over `root`), which is the whole defect; the non-HEAD path already produces the correct picture for this topology.
- Delete the HEAD-only branch of the claim rule rather than flipping it: after the fix both arms are identical, so one expression remains.
- Regression test in `src-tauri/src/git/graph/tests/lanes.rs` mirroring the reported topology (trunk merge → branch stacked on HEAD → HEAD → intermediate commit → trunk), asserting that no commit occupies HEAD's lane between the merge row and HEAD's row, that the WIP lane still follows HEAD, and that the merge sits right of HEAD.

## Capabilities

### New Capabilities

- `graph/layout` — the swimlane lane-assignment contract: which column a commit renders in when several lanes await it, and the invariant that a merge connector never crosses commits that are not its target. First requirement covers the checked-out commit; the capability exists so later layout fixes (GL-34 hand-off, blocked lanes, stash fan-out) have a home instead of living only in test names.

### Modified Capabilities

- None.

## Impact

- Code: `src-tauri/src/git/graph/layout/build.rs` (one expression, minus a conditional) and `src-tauri/src/git/graph/tests/lanes.rs` (one test, copied from the neighbouring `head_handoff_does_not_lend_its_lane_to_a_sibling_branch` fixture style).
- Behaviour: only commits that are HEAD **and** awaited by both a root and a continuation lane move column. Verified locally: the one-line change passes all 11 existing `git::graph` tests plus the new repro. Known side effect, accepted in design.md: below such a HEAD the trunk continues in HEAD's (leftmost) lane while the newer merge sits one column right — the same leftward-collapse convention the layout already uses for every non-HEAD commit, and the same shape the reference client draws.
- Secrets/auth/IPC risk: none. Read path only, libgit2, no new dependency, no wire-shape change (`RepoGraph` unchanged).

## Non-goals

- Extending GL-34's blocked hand-off down HEAD's first-parent chain so the trunk never shifts left below HEAD (separate change if the collapse proves distracting).
- Any change to the frontend painter, edge shapes, colours, or `Sort::TOPOLOGICAL | Sort::TIME` ordering.
- Reworking lane allocation for stashes or worktree HEADs beyond what the shared claim rule already gives them.
