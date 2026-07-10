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
 * re-render** — a late result is still the right answer for its key, so keys
 * must be **content-stable**; a caller whose keys are not must call `reset()`
 * on its real resource generation (the stacked review resets per reviewed
 * commit; the changes view resets per working-tree snapshot, GL-173 — its
 * keys only distinguish files within one snapshot). `reset()`
 * clears the cache + pending queue and bumps an internal generation so results
 * still in flight from the previous set are dropped instead of polluting the
 * new one — but the physical window stays bounded: IPC promises cannot be
 * cancelled, so invalidated fetches keep occupying their slots until they
 * settle, and the new generation's work starts only as those slots drain
 * (GL-172).
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
  // De-dup/publication marker only — NOT the capacity counter (see `active`).
  const inflight = useRef<Map<string, number>>(new Map());
  // Physical fetches currently running, counted until each promise settles.
  // Deliberately separate from `inflight`: reset() clears the markers to orphan
  // stale publications, but it must not forget that the un-cancellable IPC
  // calls are still consuming backend workers (GL-172).
  const active = useRef(0);
  const queue = useRef<LazyDiff[]>([]);
  const queued = useRef<Set<string>>(new Set());
  const gen = useRef(0);

  // Start queued fetches until the concurrency window is full. Re-entrant: each
  // fetch calls `pump` again from its `finally`, so a freed slot pulls the next.
  const pump = useCallback(() => {
    while (active.current < MAX_CONCURRENT_DIFFS && queue.current.length > 0) {
      const { key, fetch } = queue.current.shift()!;
      queued.current.delete(key);
      // It may have resolved (or been invalidated) while waiting in the queue.
      const at = gen.current;
      if (cacheRef.current[key] !== undefined || inflight.current.has(key)) continue;
      inflight.current.set(key, at);
      active.current += 1;
      let fetched: Promise<FileDiff>;
      try {
        fetched = fetch();
      } catch {
        // A synchronous throw never enters the promise chain below — undo the
        // slot bookkeeping so the window can't shrink permanently, and record
        // the failure like a rejected fetch would.
        active.current -= 1;
        inflight.current.delete(key);
        if (gen.current === at) setDiffs((m) => ({ ...m, [key]: null }));
        continue;
      }
      fetched
        .then((diff) => {
          if (gen.current === at) setDiffs((m) => ({ ...m, [key]: diff }));
        })
        .catch(() => {
          if (gen.current === at) setDiffs((m) => ({ ...m, [key]: null }));
        })
        .finally(() => {
          active.current -= 1;
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
   * keyed set changes meaning, e.g. switching the reviewed commit). Queued
   * items are removed outright; already-started fetches can't be cancelled, so
   * they keep their `active` slots until they settle — only their publication
   * and de-dup markers are dropped (GL-172). */
  const reset = useCallback(() => {
    gen.current += 1;
    inflight.current.clear();
    queue.current = [];
    queued.current.clear();
    // Clear the ref view synchronously, not just the state: a caller that
    // resets and re-ensures in the same commit (the changes view's snapshot
    // effect, GL-173) must not see the ghost of the just-dropped cache and
    // skip its refetch.
    cacheRef.current = {};
    setDiffs({});
  }, []);

  return { diffs, ensure, reset };
}
