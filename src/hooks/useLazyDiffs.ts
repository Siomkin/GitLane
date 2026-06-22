import { useCallback, useRef, useState } from "react";
import type { FileDiff } from "../lib/api";

/** One file's diff fetch: a cache `key` and a thunk that loads it. The thunk
 * owns the actual `api.*` call, so the hook never imports the IPC layer. */
export interface LazyDiff {
  key: string;
  fetch: () => Promise<FileDiff>;
}

/** Max diff fetches in flight at once. A commit touching hundreds of files
 * otherwise spawns that many concurrent `blocking()` IPC workers in one burst;
 * a small window keeps the backend responsive and fetches in request order. */
export const MAX_CONCURRENT_DIFFS = 6;

/**
 * A keyed cache of file diffs with in-flight de-duplication and a bounded fetch
 * window. `diffs[key]` is the loaded `FileDiff`, `null` if the fetch failed, or
 * `undefined` if not requested yet. Replaces the per-file fetch/cache effect that
 * was hand-rolled in several workspaces (changes view, stacked review).
 *
 * At most {@link MAX_CONCURRENT_DIFFS} fetches run at once; the rest queue in
 * request order and start as slots free up. Fetches are **never cancelled on
 * re-render** — a late result is still the right answer for its key (the changes
 * view relies on this; its keys encode the file content so a stale result can
 * never mismatch). Callers whose keys are *not* content-stable (e.g. the stacked
 * review re-keys by path across commits) call `reset()` when the underlying set
 * changes: it clears the cache + pending queue and bumps an internal generation
 * so any results still in flight from the previous set are dropped instead of
 * polluting the new one.
 */
export function useLazyDiffs() {
  // key -> FileDiff | null(failed). Missing key (undefined) = not fetched.
  const [diffs, setDiffs] = useState<Record<string, FileDiff | null>>({});
  // Read the latest cache inside `ensure` without making it a dependency
  // (so callers don't re-run their effect every time a diff lands).
  const cacheRef = useRef(diffs);
  cacheRef.current = diffs;
  // key -> generation that started the fetch. The generation guard prevents an
  // old request's finalizer from clearing a newer request for the same key.
  const inflight = useRef<Map<string, number>>(new Map());
  const queue = useRef<LazyDiff[]>([]);
  const queued = useRef<Set<string>>(new Set());
  const gen = useRef(0);

  // Start queued fetches until the concurrency window is full. Re-entrant: each
  // fetch calls `pump` again from its `finally`, so a freed slot pulls the next.
  const pump = useCallback(() => {
    while (inflight.current.size < MAX_CONCURRENT_DIFFS && queue.current.length > 0) {
      const { key, fetch } = queue.current.shift()!;
      queued.current.delete(key);
      // It may have resolved (or been invalidated) while waiting in the queue.
      const at = gen.current;
      if (cacheRef.current[key] !== undefined || inflight.current.has(key)) continue;
      inflight.current.set(key, at);
      fetch()
        .then((diff) => {
          if (gen.current === at) setDiffs((m) => ({ ...m, [key]: diff }));
        })
        .catch(() => {
          if (gen.current === at) setDiffs((m) => ({ ...m, [key]: null }));
        })
        .finally(() => {
          if (inflight.current.get(key) === at) inflight.current.delete(key);
          pump();
        });
    }
  }, []);

  const ensure = useCallback(
    (items: LazyDiff[]) => {
      for (const item of items) {
        const { key } = item;
        if (
          cacheRef.current[key] !== undefined ||
          inflight.current.has(key) ||
          queued.current.has(key)
        ) {
          continue;
        }
        queue.current.push(item);
        queued.current.add(key);
      }
      pump();
    },
    [pump],
  );

  /** Drop the cache and invalidate any in-flight/queued fetches (used when the
   * keyed set changes meaning, e.g. switching the reviewed commit). */
  const reset = useCallback(() => {
    gen.current += 1;
    inflight.current.clear();
    queue.current = [];
    queued.current.clear();
    setDiffs({});
  }, []);

  return { diffs, ensure, reset };
}
