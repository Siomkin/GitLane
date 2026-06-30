# Large-history performance

GL-5 tracks the repeatable benchmark and the accepted budgets for GitLane's
history graph. Record release-mode results here with the hardware, fixture
shape, loaded commit count, lane count, DPR, and build mode.

## Deterministic fixtures

The fixture generator uses `git fast-import` with fixed timestamps, authors,
messages, topology, and ref placement. Re-running the same command produces the
same repository content without thousands of slow `git commit` subprocesses.

```bash
# Pick any disposable temp directory on your OS.
BENCH_ROOT="<temp-dir>/gitlane-bench"

# Linear baselines
bun run bench:fixture --output "$BENCH_ROOT/gitlane-linear-2000" \
  --commits 2000 --shape linear --refs 200 --message-bytes 160
bun run bench:fixture --output "$BENCH_ROOT/gitlane-linear-10000" \
  --commits 10000 --shape linear --refs 1000 --message-bytes 320
bun run bench:fixture --output "$BENCH_ROOT/gitlane-linear-50000" \
  --commits 50000 --shape linear --refs 5000 --message-bytes 320

# Concurrent topic branches followed by merge commits (many active lanes)
bun run bench:fixture --output "$BENCH_ROOT/gitlane-merge-10000" \
  --commits 10000 --shape merge-heavy --refs 1000 --message-bytes 320
```

The generator replaces `--output` if it already exists. Use only disposable
benchmark paths.

## Rust graph and IPC-payload benchmark

Run the ignored benchmark in release mode. The output separates ref collection,
revwalk, commit metadata/lane layout, edge resolution, JSON serialization, and
serialized payload size. Serialization and payload size approximate the
backend side of the IPC boundary; webview deserialization remains a browser
profile measurement.

```bash
bun run bench:graph "$BENCH_ROOT/gitlane-linear-2000" 2000 5
bun run bench:graph "$BENCH_ROOT/gitlane-merge-10000" 10000 5
```

## Frontend measurement procedure

Use a production Tauri build and the webview performance/memory tools.

1. Open one generated repository at a time.
2. Record hardware, fixture command, build mode, DPR, viewport height, loaded
   commits, and `laneCount`.
3. Record initial IPC receive/deserialization, first history paint, DOM
   `role="button"` count, canvas CSS/backing dimensions, and heap.
4. Record a 10-second scroll trace, selection/context-menu latency, search
   latency, density/theme/width changes, and reveal-to-commit.
5. Trigger repeated worktree edits and index changes. Confirm they call only
   `working_changes`; then create a commit and confirm the graph refreshes.
6. Repeat after five refreshes and two History/PR tab cycles to detect retained
   canvases/rows.

The deterministic structural tests provide a CI guard independent of hardware:

- TanStack Virtual owns row-range, scroll, and resize calculation.
- `graphViewport.test.ts` verifies graph-edge clipping at canvas boundaries.
- `HistoryWorkspace.test.tsx` proves a 10,000-commit graph mounts a bounded
  TanStack Virtual row window and moves it across virtual boundaries.
- `repoWatcher.test.ts` and Rust watcher tests prove worktree-only events cannot
  accidentally select the full graph path.
- `repo.test.ts` proves explicit incremental loading and selection preservation.

## Baseline and accepted budgets

Structural baseline before GL-5:

| Area | Before |
| --- | --- |
| DOM | One `CommitRow` per loaded commit (10,000 commits = 10,000 rows). |
| Canvas | Full history height. At 10,000 compact rows: 340,000 CSS px; at DPR 2: 680,000 backing pixels high, beyond common canvas limits. |
| Selection/theme/density | Repaint attempted across the full-history canvas. |
| Watcher file/index event | Full summary + graph + branches + worktrees + stashes + status refresh. |
| Truncation | `truncated` had no user action. |

GL-5 structural result:

| Area | Accepted budget / behavior |
| --- | --- |
| DOM | Visible rows plus 8-row overscan per side; independent of total commits. |
| Canvas | Same bounded viewport plus overscan; backing height is independent of total history height. |
| Incremental history | Start at 2,000 and add 2,000 per page; scrolling near the trailing row auto-pages (GL-23, one request in flight, paused while a search filter is active), with the manual “Load more commits” row as the accessible fallback. Preserve selection and the enlarged limit across refreshes. |
| Watcher file/index event | `working_changes` only. Graph-affecting metadata upgrades the debounced burst to a full refresh; ambiguous directory-level FSEvents compare a lightweight HEAD/ref fingerprint first. |
| Scroll | Target 55–60 FPS; no persistent tasks above 16–32 ms. |
| Selection/context menu | Under 100 ms. |
| Search | Under 150 ms for the currently loaded graph. |
| Initial graph | 2,000 commits within 500 ms; usable 10,000-commit history within 1.5 s through incremental loading. |

Append measured release results below; do not loosen a budget without recording
the fixture and hardware evidence that requires it.

## Results

Recorded June 22, 2026 on a Mac mini (Apple M4, 10 cores, 16 GB RAM), release
Rust build, five iterations per row:

| Fixture / limit | Lanes | Refs | Revwalk | Layout | Edges | Graph total | JSON | Payload |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Linear 2,000 / 2,000 | 1 | 10.1 ms | 8.9 ms | 1.4 ms | 0.3 ms | 20.6 ms | 0.6 ms | 1.02 MB |
| Merge-heavy 10,000 / 2,000 | 9 | 16.6 ms | 40.3 ms | 2.4 ms | 0.3 ms | 59.6 ms | 0.8 ms | 1.41 MB |
| Merge-heavy 10,000 / 10,000 | 9 | 23.4 ms | 58.6 ms | 9.9 ms | 1.4 ms | 93.3 ms | 4.9 ms | 7.07 MB |

An exploratory 10,000-commit fixture that retained 3,337 topic refs (4,337 refs
total) measured 422.2 ms before ref optimization (279.0 ms refs) and 243.6 ms
after direct branch/remote/lightweight-tag lookup plus visible-window filtering
(64.1 ms refs). The controlled fixture above deletes merged topic refs and has
1,009 refs total. `commit_graph` still runs in `blocking()` because ref-heavy
repositories and cold-cache variance exceeded the 100 ms no-freeze budget, and
the 7 MB IPC payload adds webview transfer/deserialization work not included in
`graphTotal`.

Frontend structural result at compact density:

- Before: 10,000 DOM rows and a 340,000 CSS-pixel canvas. At DPR 2 the backing
  bitmap would be 680,000 pixels high (about 1.14 GB at a 210 px CSS width).
- After: a 340 px viewport mounts at most 26 commit rows in the integration
  test and allocates a 884 px overscanned CSS canvas (1,768 backing pixels at
  DPR 2, about 3 MB at the same width).

These figures establish bounded memory independent of total history height.
Browser FPS/input/heap traces remain hardware-observed checks using the
procedure above; the deterministic tests enforce the structural part in CI.

## Next profiling step

The canvas paints only visible commit nodes, but it still scans every loaded
edge before applying the cheap viewport intersection check. If upper-size
merge-heavy scroll traces exceed the frame budget, index edges by row range so
each repaint visits only the visible buckets. Keep the current linear scan
until measurements justify the added indexing and invalidation complexity.
