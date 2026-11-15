# Design

## Context

See proposal.md for the motivation. Constraints that shape the approach:

- **Engine and stores.** Frontend only, so there's no git engine choice to make. No store is
  added or reshaped: `ui` (`draggingFrom`, `histQuery`) and `repo` are only read differently.
- **Terminal mounting.** `App.tsx` mounts `TerminalLayer` for the whole session, and it calls
  `useTerminalPanes()` unconditionally. That hook imports `@xterm/xterm`, its addons,
  `xterm.css`, and `xtermAnsi.css` at module top. On mount it also calls `loadAgents()`
  (`useTerminalPanes.ts:176-178`), which the Settings modal's enabled-agent badge relies on.
- **Terminal tabs before first open.** Nothing in the terminal hooks needs to run before the
  first open. The terminals store is not persisted. `ensureTab` only runs when
  `terminalView === "open"` (`usePaneReconciler.ts:59-61`). Agent injection opens the terminal
  before typing (`terminalChrome.ts:176`).
- **Markdown importers.** `Markdown.tsx` is imported statically by eight components. Its module
  top pulls in react-markdown, remark-gfm, rehype-raw, and rehype-sanitize. The
  `"No description."` empty branch (`Markdown.tsx:167`) needs none of that.
- **Prior measurement.** `architecture-rules-react.md` records a 2026-10-17 lazy-workspace trial
  that failed the 10% / 100 kB bar, partly because shared chunks stayed preloaded. Any lazy
  boundary here must be judged on total eager JS, not on the entry chunk alone.
- **File sizes.** None of the touched files is near the size ceiling, so no split is due.

## Goals / Non-Goals

**Goals:**

- Take xterm and the markdown stack off the startup path without changing what the user sees
  once those surfaces are shown.
- Remove the render-path costs of findings 2, 3 and 5, and finding 4 if measured, while keeping
  current behaviour exactly.

**Non-Goals:**

- Lazy workspaces or dialogs (see proposal Non-goals), a loading-skeleton design, and a
  passive scroll listener (it has no effect on scroll events).

## Measurements

Scratch build during review, 2026-11-15, with both lazy boundaries applied by hand. Eager JS
means everything `index.html` loads or modulepreloads.

| | raw | gzip |
|---|---|---|
| `latest` | 2,365 kB | 655 kB |
| xterm + markdown lazy | 1,655 kB | 458 kB |
| baseline (apply) | 2,365 kB | 655 kB |
| after (apply) | 1,655 kB | 458 kB |

Gate (D3): eager JS dropped 710 kB raw (30.0%) and 197 kB gzip, which clears the 10% / 100 kB
bar, so group 3 stays. The after build's `index.html` references neither `vendor-terminal`
(JS or CSS) nor `vendor-markdown`.

`vendor-terminal` and `vendor-markdown` were absent from `index.html` in the second build.
Tasks 1.1 and 4.1 append the real before/after numbers to this table.

## Decisions

### D1. Markdown: a lazy body behind the existing `Markdown` export

Move the renderer, which holds the react-markdown imports, the sanitize schema, the URL
transform, and the components map, into `MarkdownRenderer.tsx` as-is. `Markdown.tsx` keeps its
exported name and props. It keeps the `"No description."` empty branch eagerly, and otherwise
renders `<Suspense fallback={null}><LazyMarkdownRenderer content={content} /></Suspense>`.

- None of the eight callers change.
- The fallback is `null`, not the raw source. React 19 holds a fallback for up to about 300 ms
  before revealing content (`FALLBACK_THROTTLE_MS`). A raw-text fallback would flash
  unrendered markdown and HTML (PR templates, `<details>`) for that long. An empty slot avoids
  that.
- If the first-show blank is noticeable in the built app (task 5.2), add an idle preload. That
  is one `requestIdleCallback(() => import("./MarkdownRenderer"))` after the first paint, which
  keeps it off startup while making first display immediate. Do not add it unless needed.
- The sanitizer moves unchanged. It is the security gate for untrusted PR HTML.
- *Alternative:* lazy-load each consumer. Rejected: that means eight boundaries instead of one,
  and the barrels would keep the library eager anyway, as the 2026-10-17 trial found.

### D2. Terminal: a thin shell plus a lazy body, latched on first open

Split `TerminalLayer` into an eager shell and a lazy `TerminalBody` that holds everything that
uses `useTerminalPanes()`. The shell latches `hasOpened` the first time
`terminalView !== "hidden"`. From then on it renders the body permanently, so the "never
unmounts across repo open/close" guarantee holds from the first open. The context section above
shows that nothing needs the body earlier.

- `loadAgents()` moves from `useTerminalPanes` into the shell, or into whichever eager owner the
  agents data belongs to, so the Settings badge keeps working before the terminal is ever
  opened.
- `xterm.css` and `xtermAnsi.css` become stylesheets loaded on demand with the lazy chunk.
  `style-src 'self'` allows them. They only load separately in a production bundle, so task 5.2
  checks terminal colours in a built app, not only in `tauri dev`.
- Update the `TerminalPanel.tsx` header comment (lines 11-17): the layer is mounted for the
  session, and the xterm body is mounted from the first open on.
- *Alternative:* an idle preload of xterm after startup. Rejected as the primary fix: it still
  parses xterm in every session.

### D3. Measurement gate for D1 and D2

Build before and after into a scratch `--outDir`. Sum the entry chunk plus every chunk named in
`index.html`'s `modulepreload` and `<script>` tags, both raw and gzip, and record the numbers
in the Measurements table above. D1 and D2 ship only if the drop is at least 10% or 100 kB raw.
The review scratch build already measured about 30%. Copy the final numbers into
`architecture-rules-react.md` next to the 2026-10-17 note, so library-leaf splits are recorded
as distinct from workspace splits.

### D4. CommitRow: no drag subscription

Remove `const draggingFrom = useUi((s) => s.draggingFrom)`. In `onDragOver`, read
`useUi.getState().draggingFrom?.kind === BranchKind.Local` before calling `preventDefault()`.
In `onDrop`, read `useUi.getState().draggingFrom` once, return early if it is not a local
branch, and pass that object as `from`.

- `isDropTarget` was only used inside these two handlers, so nothing that renders depends on
  it, and a drag start re-renders no rows.
- *Alternative considered:* a derived-boolean selector. Rejected: `onDrop` needs the whole
  object, and the boolean still flips on every local-branch drag, so all rows would re-render
  in the common case.

### D5. History search: `useDeferredValue`

In `HistoryWorkspace`, `const deferredQuery = useDeferredValue(histQuery)`. Then `filtering`
(line 80), `matchedIds`, `queryMatches`, and the rows' `query` prop all derive from
`deferredQuery`. As a result `countLabel` and the dimming always agree, with no "0 matches"
frame. The search field in `HistorySearchBar` stays bound to the live `histQuery`. `histFilter`,
the kind chips, is a click and stays undeferred.

- *Alternative:* debounce in the store. Rejected: it delays the result by a fixed time even on
  small graphs, and `useDeferredValue` already yields only when rendering is actually slow.

### D6. Search haystack cache, gated by measurement

Implement this only if task 2.3's profile still shows `matchingIds` as a significant cost per
keystroke with D5 in place, on a repo with several thousand loaded commits. If it does: add a
module-level `WeakMap<CommitNode, string>` holding the lower-cased summary, body, id, shortId,
authorName, authorEmail, and ref names, joined with `"\u0000"`. `matchesQuery` then becomes
`haystack(commit).includes(q)`.

- Rewrite the `historyFilter.ts:33-35` comment ("no per-commit allocation"), because the cache
  reverses that choice on purpose.
- Strip NUL from the query before matching, so the separator can never be matched. `trim()`
  does not remove NUL.
- A graph refresh produces new `CommitNode` objects, so stale entries are collected along with
  the old graph.
- If it is not implemented, record the profile result in this section and leave
  `historyFilter.ts` untouched.

**Result (2026-11-15): skipped.** Measured with a matcher benchmark in Bun (JavaScriptCore) on
this repo's real commit text, not an in-app profile; the benchmark was accepted as the evidence
for this decision. `matchingIds` per keystroke: 8-11 ms at 5,000 loaded commits and 65-82 ms at
20,000. A cached haystack measured about 2 ms and 5-8 ms. At several thousand commits the cost
is under one frame and, with D5, runs in a deferred render that does not block typing, so
`historyFilter.ts` is untouched. Revisit if graphs of around 20,000 loaded commits become
common.

### D7. Conflict selection: adjust state during render

Today the effect keeps a still-valid selection, including one the user never picked
explicitly, and otherwise falls back to `firstUnresolved`. A pure derivation would let an
auto-selected file follow `firstUnresolved` as files resolve, and that would change behaviour.

Use React's "store information from previous renders" pattern instead:

- `const key = files.map(f => f.path).join("\u0000") + "\u0001" + (firstUnresolved ?? "")`.
- `const [prevKey, setPrevKey] = useState<string | null>(null)`. The initial value is `null`,
  a sentinel that never equals a real key, so the default selection is applied on the first
  render.
- During render, when `key !== prevKey`, call `setPrevKey(key)` and
  `setSelected(prev => prev && files.some(f => f.path === prev) ? prev : firstUnresolved)`.

React re-runs the render before committing, so the stale-selection paint and the effect go
away and the semantics stay the same. The `JSON.stringify`/`JSON.parse` round-trip is dropped.

## Risks / Trade-offs

- [The first markdown display is blank for up to about 300 ms] → `null` fallback, so nothing
  raw flashes. Check in the built app, and add the idle preload from D1 only if it is visible.
- [The first terminal open lags by the same throttle] → Check in the built app. The shell can
  show its frame immediately, since only the pane body waits.
- [Markdown sanitizer tests would pass vacuously against a fallback] → `Markdown.test.tsx`
  retargets to `MarkdownRenderer` directly. One wrapper test covers the lazy path and the empty
  branch.
- [Coverage baselines for `Markdown.tsx` (74.1) and `TerminalPanel.tsx` (90.9) change meaning
  after the split] → Run `bun run coverage`. New files need at least 60%. Update the baseline
  with `coverage:update` and review its diff.
- [The measurement fails the bar] → Very unlikely given the scratch result. If it happens,
  drop D1 and D2, keep D4, D5 and D7, and still record the numbers.
- [`useDeferredValue` shows matches one frame late] → This is intended. The count and the
  dimming read the same deferred value.
