## 1. Wire the hunk through the existing threads payload

- [x] 1.1 Add `diff_hunk: Option<String>` to Rust `ReviewThread` and verify `gitlane` Rust types compile (`cargo test -p` or the crate's existing forge type tests still pass)
- [x] 1.2 Request `diffHunk` on thread comments in `REVIEW_THREADS_QUERY`, map the first comment's hunk in `GqlThread::into_thread` (empty → `None`), and verify a Rust unit/fixture test covers present, missing, and empty values
- [x] 1.3 Leave Origin `into_thread` at `diff_hunk: None` and verify Origin thread fixtures still deserialize and compile
- [x] 1.4 Add `diffHunk: string | null` to the TS `ReviewThread` type and `reviewThreadSchema`, update API fixtures, and verify `src/lib/api` schema tests plus `tsc` still pass

## 2. Paint the snippet on the card

- [x] 2.1 Add a pure unified-diff snippet parser under `src/features/pull-requests/` and verify unit tests cover header, add, del, ctx, empty, and unparseable input (unparseable → no lines)
- [x] 2.2 Add `ThreadDiffSnippet` that paints those lines with the existing review add/del/ctx tokens, and verify it renders nothing when `diffHunk` is null or unparseable
- [x] 2.3 Mount the snippet on `ThreadCard` under the line badge and above comments, and verify ReviewThreads tests show the snippet when a hunk is present, omit it when absent, and still offer no comment/reply editor
- [x] 2.4 Drop the "planned follow-up" comment in `ReviewThreads.tsx` and verify `bun run sizes` stays under the React/Rust ceilings for the touched files

## 3. Check the lockstep

- [x] 3.1 Run the existing vitest pull-request and api suites plus the new parser/snippet tests (`bun test` on the touched files) and verify they pass
- [x] 3.2 Run `openspec validate show-review-thread-diff-snippets --store gitlane` and verify it passes
