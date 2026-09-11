## Context

See proposal.md — Why. Engine: libgit2 read path, `src-tauri/src/git/graph/layout/build.rs`; no store, no IPC layer, frontend paints unchanged coordinates.

The walk is `TOPOLOGICAL | TIME`, children before parents. `lanes[i]` holds the oid each column waits for plus its `LaneKind` (`Cont` / `Root` / `Blocked`, `layout/lanes.rs`). Before the walk, lane 0 is seeded `Cont(HEAD)` (GL-34) so the WIP row continues the checked-out branch. When a merge's second parent is already awaited, that reservation is promoted to `Root`.

Reported topology (walk order, HEAD = `X`):

| row | commit | parents | awaiting `X` after the row |
|---|---|---|---|
| 0 | `M` merge on trunk | `[T0, X]` | lane 0 promoted `Root(X)` |
| 1–4 | stacked branch `S1..S4` | chain ending at `X` | lane 2 `Cont(X)` |
| 5 | `X` (HEAD) | `[C]` | — |

At row 5 the claim rule is `cont_lane.or(root_lane)` for HEAD only, so `X` takes lane 2 under `S1..S4`. The edge `M → X` is drawn down lane 2 through the stacked commits. Lane 0 stays empty from row 0 to row 5.

## Goals / Non-Goals

**Goals:**
- A merge's second-parent connector never passes through commits that are not on the path to its target, HEAD or not.
- WIP row still follows the checked-out commit (`wip_lane == HEAD lane`).

**Non-Goals:**
- Keeping the trunk in one column below HEAD (see Risks).
- Touching edge shapes, colours, or the painter.

## Decisions

**1. HEAD uses the same claim rule as every other commit: root lane wins over continuation.**
The seed lane is already promoted to `Root` whenever a merge targets HEAD, so preferring `root` puts HEAD in the column the merge connector is drawn down — which is exactly what makes the connector correct. When nothing merges HEAD, `root_lane` is `None` and the continuation is chosen as before, so the GL-34 "WIP on the mainline" case is untouched (`checked_out_head_ancestor_stays_on_wip_mainline` passes unchanged).

*Alternative — keep the HEAD preference and instead block lane 0 until HEAD renders:* more state, and still leaves HEAD in the stacked branch's column with the connector crossing it. Rejected.

*Alternative — reorder the walk so stacked children render after the merge target:* violates topological order (children must precede parents). Rejected.

**2. Delete the conditional, do not flip it.** After the change both arms read `root_lane.or(cont_lane)`; a single expression with the existing comment ("a branch-root reservation wins so the branch renders in its own column") is the whole diff. Verified: 11/11 existing `git::graph` tests pass with this change, plus the new repro.

**3. Regression test is a fixture in `graph/tests/lanes.rs`, copying the `head_handoff_does_not_lend_its_lane_to_a_sibling_branch` style.** Assert the invariant, not just lane inequality: no commit sits in HEAD's lane strictly between the merge row and HEAD's row; `merge.lane > head.lane`; `wip_lane == Some(head.lane)`. Include the intermediate commit between HEAD and trunk so the fixture matches the user's repo, not a simplified one.

## Risks / Trade-offs

- [Trunk shifts left one column below HEAD] → With an intermediate commit under HEAD, GL-34's blocked hand-off does not fire (it only checks the HEAD commit itself), so HEAD, its ancestors, and the trunk base all continue in lane 0 while the newer merge stays in lane 1. Measured on the fixture after the fix: merge lane 1, stacked branch lane 2, HEAD/intermediate/base lane 0. This is the lowest-continuation-wins convention every non-HEAD commit already follows, and the reference client draws the same fold. Accepted; extending the hand-off down HEAD's first-parent chain is a separate change if it proves distracting.
- [Stashes on HEAD] → A stash node reserves a `Cont` lane to its base like a child commit, so it took the same wrong path; the shared rule fixes it identically. Covered by the existing stash tests staying green.
- [Rollback] → Single-expression revert; no data, wire, or persisted-state change.
