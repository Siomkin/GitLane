## 1. Regression test (write first, must fail on current code)

- [x] 1.1 Add `merge_connector_does_not_run_through_a_branch_stacked_on_head` to `src-tauri/src/git/graph/tests/lanes.rs` using the `commit_on` fixture: trunk base → intermediate commit → HEAD tip (`refs/heads/feature`, checked out) → two commits on `refs/heads/stacked` → trunk merge with parents `[base, HEAD tip]`, timestamps ascending in that order. Assert: no commit has `lane == head.lane` for rows strictly between `merge.row` and `head.row`; `merge.lane > head.lane`; `graph.wip_lane == Some(head.lane)`. Verify it fails with `cargo test --lib merge_connector_does_not_run_through` (HEAD lands in the stacked branch's lane).

## 2. Rust fix

- [x] 2.1 In `src-tauri/src/git/graph/layout/build.rs`, replace the `if head_target == Some(oid) { cont_lane.or(root_lane) } else { root_lane.or(cont_lane) }` claim with a single `root_lane.or(cont_lane)` and drop the now-dead conditional; keep the surrounding "branch-root reservation wins" comment accurate. Verify with `cargo test --lib merge_connector_does_not_run_through` passing.
- [x] 2.2 Run the whole graph suite `(cd src-tauri && cargo test --lib git::graph)` and confirm the pre-existing HEAD tests (`checked_out_head_ancestor_stays_on_wip_mainline`, `head_handoff_does_not_lend_its_lane_to_a_sibling_branch`, `blocked_head_lane_does_not_retarget_an_existing_merge_connector_through_a_later_tip`) and the stash tests still pass.

## 3. Definition of done

- [x] 3.1 `(cd src-tauri && cargo fmt --all -- --check && cargo clippy --all-targets --all-features -- -D warnings)` clean.
- [x] 3.2 `bun run sizes` passes (`lanes.rs` grows by one test; `build.rs` shrinks).
- [x] 3.3 Verified against a real-git fixture repository reproducing the reported history (PIS-1748/1805/1802/1804 merges, HEAD on PIS-1802) by printing the built layout rather than through `bun run tauri dev`. Before: PIS-1802 rendered in lane 2 under the four PIS-1804 commits and the `#118` merge's second-parent edge ran lane 1→2 through them. After: PIS-1802 renders in lane 0, PIS-1804 keeps lane 2, and the `#118` edge runs lane 1→0 crossing nothing. As accepted in design.md, the trunk below PIS-1802 (`chore(deps)`, `#117`, `#116`, `#115`) continues in lane 0 while `#118` sits in lane 1 — mention this in the PR. A visual pass in the running app is still worth doing before merge.
