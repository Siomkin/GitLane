# Tasks

## 1. Rust: ancestry ordering

- [x] 1.1 Add a failing regression test in `src-tauri/src/git/status/tests/selection.rs`, modelled on `selection_diff_orders_by_ancestry_not_timestamp`. Build a linear chain of 5 commits that each edit `f.txt` (pairs share a committer time via `commit_at`). Pass the oids **newest-first** and assert that `selection_diff_file` returns `Ok` with the full base→head diff and that `selection_diff` lists `f.txt` as Modified. Verify that `cargo test selection` fails on the current code.
- [x] 1.2 In `src-tauri/src/git/status/selection/ordering.rs`, replace `repo.merge_base_many(&ids)` with `repo.merge_base_octopus(&ids)` and update the comment to say it is the common ancestor of *all* picks. Verify that the 1.1 test and the rest of `cargo test selection` pass.
- [x] 1.3 Unrelated picks must order by committer time, whatever order they are passed in. No fallback code is needed: once the walk stops at the octopus base, every pick is reachable (each descends from that base, and nothing is hidden when there is none), and `Sort::TIME` already orders picks with no ancestry between them. Pinned by `selection_diff_orders_unrelated_picks_by_time` (two orphan roots, both pick orders).
- [x] 1.4 Check the same chain as 1.1 in shuffled order and verify the file list and per-file diff are exactly the newest-first result (spec scenario "Selection order does not matter"). This was folded into the 1.1 test, `selection_diff_contiguous_run_is_not_gapped_in_any_pick_order`, which loops over both orders, to keep `tests/selection.rs` under the 400-line ceiling.

## 2. Definition of done

- [x] 2.1 Run the `verify` agent (cargo fmt/clippy/test, `bun run sizes`) and confirm every check exits 0. `tests/selection.rs` must stay under the 400-line Rust ceiling.
- [x] 2.2 In `bun run tauri dev`, open `/Volumes/External/Develop/emedicus/e-peds.ch/backend`, select the 5 commits `95d3d51..693c620` on `feature/PIS-1838`, and confirm `OneDoc.php` shows its diff with no red banner.

## Workflow follow-up

- Follow-up change, out of scope here: UX for genuine gaps (an inline diff-pane state instead of the global banner, an "approximate" marker on the file list, and an "add the in-between commit" action).
- Archive the change after merge.
