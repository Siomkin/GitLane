// Stacked all-files review for a single oid (a commit or a stash commit): every
// changed file shown in one scroll with its unified diff. Used by "Review all"
// on a commit and by the stash viewer.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
// eslint-disable-next-line no-restricted-imports -- local read-only multi-file review fetch, disposable probe (architecture-rules-react.md §1)
import { api, type FileChange } from "@/lib/api";
import { summarizeFiles } from "@/lib/changeSummary";
import { useLazyDiffs } from "@/hooks/useLazyDiffs";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { FileListView } from "@/lib/ui";
import { SparkleIcon } from "@/components/ui/icons";
import { ChangeTypeCounts } from "@/features/changes/ChangeTypeCounts";
import { treeOrderedFiles } from "@/features/changes/commitTree";
import { AiActionId, scopeFromStackedReview } from "@/features/agents/ai-actions";
import { HandToAgentBar } from "./comments";
import { StackedReviewList } from "./StackedReviewList";
import {
  buildStackedReviewModel,
  estimatedDiffBodySize,
  stackedDiffKey,
} from "./stackedReviewRows";

/** Changed-line count above which a file starts collapsed, so a lockfile-sized
 * diff doesn't mount thousands of rows (or get fetched) until asked for. */
const LARGE_DIFF_LINES = 500;

/** Lockfiles / generated artifacts: large, rarely the point of a review, so they
 * start collapsed regardless of size. */
const GENERATED_FILE =
  /(^|\/)(bun\.lock|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|composer\.lock|go\.sum|Gemfile\.lock|poetry\.lock)$|\.min\.(js|css)$|\.map$/i;

/** Loaded file bodies retained while scrolling. Offscreen overflow entries are
 * replaced by numeric height placeholders and re-fetched on revisit. */
export const MAX_CACHED_STACKED_DIFFS = 24;

function startsCollapsed(file: FileChange): boolean {
  return file.add + file.del > LARGE_DIFF_LINES || GENERATED_FILE.test(file.path);
}

export function StackedReview() {
  const review = useUi((s) => s.stackedReview);
  const closeStackedReview = useUi((s) => s.closeStackedReview);
  const openAiActions = useUi((s) => s.openAiActions);
  // The changed-files list view (shared with the inspectors). In Tree mode the
  // stacked sections follow the tree's grouped order, so navigating from the
  // Tree file list lands on the same neighbours here (GL — review-all reorder).
  const fileListView = useUi((s) => s.fileListView);
  const summary = useRepo((s) => s.summary);
  const selectedFile = useRepo((s) => s.selectedFile);
  const fileSelectionRequestId = useRepo((s) => s.fileSelectionRequestId);
  const clearSelectedFile = useRepo((s) => s.clearSelectedFile);
  const [files, setFiles] = useState<FileChange[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  // Files the reviewer chose to see in full after the backend truncated a large
  // diff. Their fetch re-keys (`path:full`) so the cache holds a distinct entry.
  const [fullFiles, setFullFiles] = useState<Set<string>>(new Set());
  const [placeholderSizes, setPlaceholderSizes] = useState<Record<string, number>>({});
  // Per-file diff cache. Keyed by path, which is *not* content-stable across
  // commits, so we reset() on every oid/range change to drop the previous
  // commit's cache and invalidate its in-flight fetches.
  const { diffs, ensure, retainQueued, evict, reset } = useLazyDiffs();

  const oid = review?.oid ?? null;
  const range = review?.range ?? null;
  const selection = review?.selection ?? null;
  const path = summary?.path ?? null;
  // Notes are scoped to this review (a commit, a base..head range, or a selection).
  // The selection key is sorted so it's order-independent (matches reviewSurface,
  // and survives a refresh that reorders the same set).
  const surface = selection
    ? `selection:${[...selection].sort().join(",")}`
    : range
      ? `range:${range.base}..${range.head}`
      : `commit:${oid ?? ""}`;

  // Fetch the file list for this oid/range; reset the diff cache + collapse.
  useEffect(() => {
    if (!oid || !path) return;
    let cancelled = false;
    setListLoading(true);
    reset();
    setFullFiles(new Set());
    setPlaceholderSizes({});
    (async () => {
      try {
        // Selection mode unions a multi-commit pick; range mode diffs base..head;
        // otherwise it's a single commit/stash.
        const list = selection
          ? await api.selectionDiff(path, selection)
          : range
            ? await api.diffRange(path, range.base, range.head)
            : await api.commitFiles(path, oid);
        if (!cancelled) {
          setFiles(list);
          // Large/generated files start collapsed so they aren't fetched or
          // mounted until the reviewer opens them.
          setCollapsed(
            Object.fromEntries(list.filter(startsCollapsed).map((f) => [f.path, true])),
          );
        }
      } catch {
        if (!cancelled) {
          setFiles([]);
          setCollapsed({});
        }
      } finally {
        if (!cancelled) setListLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [oid, range, selection, path, reset]);

  // The last window the virtualizer reported, replayed by the effect below when
  // a diff settles outside a scroll.
  const lastViewportRef = useRef<{
    visiblePaths: string[];
    measureFileBody?: (filePath: string) => number | null;
  } | null>(null);

  // The virtual list reports only the viewport + overscan paths. This keeps a
  // 200-file review from immediately fetching every small file; expanding or
  // navigating to a file re-runs the callback with that path in the window.
  const requestVisibleFiles = useCallback(
    (visiblePaths: string[], measureFileBody?: (filePath: string) => number | null) => {
      if (!path || !oid) return;
      lastViewportRef.current = { visiblePaths, measureFileBody };
      // Keep `visiblePaths`' viewport order (top-to-bottom) — the FIFO fetch
      // queue then loads sections in the order they're read. In Tree mode that
      // order differs from the backend `files` order, so map through it rather
      // than `files.filter`, which would re-impose the backend order.
      const byPath = new Map(files.map((file) => [file.path, file]));
      const visibleFiles = visiblePaths
        .map((filePath) => byPath.get(filePath))
        .filter((file): file is FileChange => !!file && !collapsed[file.path]);
      const visibleKeys = new Set(
        visibleFiles.map((file) => stackedDiffKey(file.path, fullFiles)),
      );
      // Requests that have not started are cheap to discard. Keep active IPC
      // work capacity-bound, but do not let an old viewport stay ahead of the
      // user's current viewport in the pending queue.
      retainQueued(visibleKeys);
      ensure(
        visibleFiles.map((file) => {
          const full = fullFiles.has(file.path);
          return {
            key: stackedDiffKey(file.path, fullFiles),
            fetch: () =>
              selection
                ? api.selectionDiffFile(path, selection, file.path, full)
                : range
                  ? api.diffRangeFile(path, range.base, range.head, file.path, full)
                  : api.commitFileDiff(path, oid, file.path, full),
          };
        }),
      );

      const cachedKeys = Object.keys(diffs);
      const overflow = cachedKeys.length - MAX_CACHED_STACKED_DIFFS;
      if (overflow <= 0) return;
      const toEvict = cachedKeys.filter((key) => !visibleKeys.has(key)).slice(0, overflow);
      if (toEvict.length === 0) return;
      const pathByKey = new Map(
        files.map((file) => [stackedDiffKey(file.path, fullFiles), file.path]),
      );
      setPlaceholderSizes((current) => {
        const next = { ...current };
        // A placeholder is consumed once its diff re-resolves; drop those
        // entries here (the same cadence they are created on) so the map stays
        // bounded by keys currently standing in for an evicted diff.
        for (const key of Object.keys(next)) {
          if (diffs[key] !== undefined) delete next[key];
        }
        for (const key of toEvict) {
          const diff = diffs[key];
          if (!diff) continue;
          // Prefer the virtualizer's measured body height (it includes comment
          // cards and binary previews); estimate only when nothing measured.
          const filePath = pathByKey.get(key);
          const measured = filePath != null ? measureFileBody?.(filePath) : null;
          next[key] = measured ?? estimatedDiffBodySize(diff);
        }
        return next;
      });
      evict(toEvict);
    },
    [
      collapsed,
      diffs,
      ensure,
      evict,
      files,
      fullFiles,
      oid,
      path,
      range,
      retainQueued,
      selection,
    ],
  );

  // The virtualizer only calls back on viewport changes, but a diff can settle
  // long after the scroll that requested it — a late arrival was then held above
  // MAX_CACHED_STACKED_DIFFS until the user happened to scroll again. Replay the
  // last window whenever the cache changes so the cap covers late arrivals too.
  //
  // Terminates: the pass is idempotent once at or under the cap (it returns
  // before evicting), and `ensure` re-requests nothing already cached or queued.
  useEffect(() => {
    const last = lastViewportRef.current;
    if (!last) return;
    requestVisibleFiles(last.visiblePaths, last.measureFileBody);
  }, [diffs, requestVisibleFiles]);

  // Only the file list gates the view; each file's diff then streams into its
  // own section, so the first files are reviewable before the slowest resolves.
  const loading = listLoading;

  // Clicking a file in the right-panel changed-files list expands it. The
  // virtual list owns the corresponding scrollToIndex navigation.
  useEffect(() => {
    if (selectedFile?.source !== "commit") return;
    const target = selectedFile.path;
    if (!files.some((file) => file.path === target)) return;
    setCollapsed((c) => (c[target] ? { ...c, [target]: false } : c));
  }, [selectedFile?.path, selectedFile?.source, files]);

  // Order the sections to match the active file-list view: Path keeps the
  // backend (diff) order; Tree groups by directory exactly like the Tree file
  // list, so scrolling and file-to-file navigation stay in step across both.
  const orderedFiles = useMemo(
    () => (fileListView === FileListView.Tree ? treeOrderedFiles(files) : files),
    [fileListView, files],
  );
  const model = useMemo(
    () => buildStackedReviewModel(orderedFiles, collapsed, diffs, fullFiles, placeholderSizes),
    [collapsed, diffs, orderedFiles, fullFiles, placeholderSizes],
  );
  const toggleFile = useCallback(
    (filePath: string) =>
      setCollapsed((current) => ({ ...current, [filePath]: !current[filePath] })),
    [],
  );
  const showFullDiff = useCallback(
    (filePath: string) => {
      // The capped payload is superseded as soon as the user requests the full
      // version. Do not retain both potentially-large FileDiff objects while
      // the full request uses its distinct cache identity.
      evict([filePath]);
      setFullFiles((current) => new Set(current).add(filePath));
    },
    [evict],
  );

  if (!review) return null;

  // "Graph" returns to the commit graph. Closing the stacked review alone isn't
  // enough: the file that was open before "review all" is still selected, so the
  // center-pane dispatcher (App.tsx) — which checks `stackedReview` before
  // `selectedFile` — would fall back to the single-file review instead of the
  // graph. Clear that selection too; the commit itself stays selected.
  const backToGraph = () => {
    clearSelectedFile();
    closeStackedReview();
  };

  return (
    <main className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-black/5 dark:border-white/5 bg-white dark:bg-neutral-800 shadow-sm">
      <div className="flex h-12 flex-none items-center gap-3 border-b border-black/5 dark:border-white/5 px-4">
        <span className="truncate text-[14px] font-semibold text-neutral-800 dark:text-neutral-100">{review.title}</span>
        <ChangeTypeCounts summary={summarizeFiles(files)} className="flex-none" />
        <div className="ml-auto flex flex-none items-center gap-2">
          <button
            type="button"
            className="flex h-8 items-center gap-1.5 rounded-lg border border-black/10 px-2.5 text-[12px] font-medium text-neutral-600 hover:bg-black/5 dark:border-white/10 dark:text-neutral-300 dark:hover:bg-white/5"
            onClick={() =>
              openAiActions({ ...scopeFromStackedReview(review), action: AiActionId.Short })
            }
          >
            <SparkleIcon className="h-3.5 w-3.5 text-[color:var(--accent)]" />
            AI actions
          </button>
          <button type="button"
            className="flex h-8 items-center gap-1 rounded-lg border border-black/10 px-2.5 text-[12px] font-medium text-neutral-600 hover:bg-black/5 dark:border-white/10 dark:text-neutral-300 dark:hover:bg-white/5"
            onClick={backToGraph}
          >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3 h-3">
            <path d="m15 18-6-6 6-6" />
          </svg>
          Graph
          </button>
        </div>
      </div>

      {loading ? (
        <div className="grid min-h-0 flex-1 place-content-center text-sm text-neutral-400">
          Loading diffs…
        </div>
      ) : files.length === 0 ? (
        <div className="grid min-h-0 flex-1 place-content-center text-sm text-neutral-400">
          No changes.
        </div>
      ) : (
        <StackedReviewList
          model={model}
          surface={surface}
          selectedPath={selectedFile?.source === "commit" ? selectedFile.path : null}
          fileSelectionRequestId={fileSelectionRequestId}
          onToggle={toggleFile}
          onShowFull={showFullDiff}
          onVisibleFiles={requestVisibleFiles}
        />
      )}

      <HandToAgentBar surfaces={[surface]} />
    </main>
  );
}
