# Proposal

No Jira issue exists yet. Frontend only (React/TypeScript under `src/`); no Rust, IPC, or
docs-rule change beyond one note in `docs/rules/architecture-rules-react.md`.

## Why

A review against Vercel's `react-best-practices` rules found one load-time cost and three
render-time costs that the user pays on every launch, drag, or keystroke:

- Every JS chunk is eager. There is no `lazy()` or `import()` in `src/`, and `index.html` loads
  or modulepreloads about 2,365 kB of raw JS (655 kB gzip), including `vendor-terminal` (xterm)
  and `vendor-markdown` (react-markdown + remark/rehype). Neither is needed to paint the first
  screen. A scratch build with both loaded on demand measured 1,655 kB raw / 458 kB gzip eager,
  about 30% less.
- History search, commit rows, and the conflict view do avoidable work on hot paths.

## What Changes

1. **Load the two heavy library leaves on demand.** xterm loads when the terminal is first
   opened, and the markdown renderer loads the first time markdown is shown. The scratch
   measurement already clears the repo's 10% / 100 kB bar. The real implementation is
   re-measured, and it ships only if it still clears that bar.
2. **CommitRow has no drag subscription.** `CommitRow` stops subscribing to `draggingFrom` and
   reads it with `useUi.getState()` inside its drag-over and drop handlers. A drag start then
   re-renders no rows at all.
3. **Deferred history search.** `HistoryWorkspace` derives the matches, the match count, and the
   "filtering" flag from `useDeferredValue(histQuery)`. The search field still updates on every
   keystroke, and the dim/match pass catches up after it.
4. **Cached search haystack, only if measured.** If, with item 3 in place, matching on a large
   graph still shows up in a profile, `historyFilter.ts` caches one lower-cased haystack per
   commit in a `WeakMap`. Otherwise it is dropped.
5. **Conflict selection without an effect.** `useConflictResolver` fixes an invalid selection
   during render, using React's "adjust state while rendering" pattern, instead of in a
   `useEffect` with a JSON round-trip. That removes one committed render that shows a stale
   selection.

Dropped after review: a `passive` flag on `useFixedPopover`'s scroll listener. Scroll events
cannot be cancelled, so the flag has no effect.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

None. `skip_specs: true`: this is a behaviour-preserving performance refactor. What the user
sees and what each control does stay the same. Only when code loads and how much re-render
work happens change.

## Non-goals

- No lazy-loading of center workspaces, settings, repo-settings, or onboarding. The 2026-10-17
  trial measured under the bar, and the feature barrels defeat the split
  (`architecture-rules-react.md`, "Bundle size is not a reason to lazy-load a workspace"). This
  change does not reopen that decision.
- `@dnd-kit` stays eager: the repo tab strip uses it on every screen.
- No React Compiler, no broad `memo()` pass, no store reshaping, no `vite.config.ts` chunk-group
  change. The scratch build showed the existing groups already split correctly.

## Impact

- Code: `src/components/ui/Markdown.tsx` plus a new `MarkdownRenderer.tsx`. The eight importers
  are unchanged. Also `src/features/terminal/TerminalPanel.tsx` plus a lazy body module,
  `src/features/graph/commit-row/CommitRow.tsx`, `src/features/graph/HistoryWorkspace.tsx`,
  `src/features/conflicts/useConflictResolver.ts`, and possibly
  `src/features/graph/historyFilter.ts` (item 4).
- Tests: `Markdown.test.tsx` retargets to `MarkdownRenderer`. Tests that assert rendered
  markdown or terminal output await the lazy content. The coverage baseline
  (`scripts/coverage-baseline.json`) is updated for the split files.
- No dependency, Tauri plugin, capability, or CSP change. No IPC, secret, or auth surface is
  touched. The markdown sanitizer moves to the new module unchanged.
- Patterns to copy: `useUi.getState()` inside handlers, as `CommitRow`'s own `onDrop` already
  does for `openMenu`. React's documented "adjust state during render" pattern for item 5.
