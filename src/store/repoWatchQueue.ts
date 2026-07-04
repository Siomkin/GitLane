import { api } from "../lib/api";

/**
 * Per-path FIFO sequencing for the filesystem watch/unwatch IPC calls (GL-125).
 *
 * `closeRepo` fires `unwatchRepo(path)` fire-and-forget; if the user immediately
 * reopens the same path (Recents click → `loadRepo` → `watchRepo`), the close's
 * unwatch and the reopen's watch originate on separate call stacks. Nothing
 * orders the two IPC calls, so the backend could process the later `watch_repo`
 * before the earlier `unwatch_repo` for the same key — leaving the tab
 * unwatched. (Sequencing the reopen through `closeRepo`'s own await would not
 * help: the reopen is a *separate* gesture, not chained off the close.)
 *
 * A module-level promise chain per path fixes it: each call links onto the
 * previous one for the same path and its IPC is dispatched only after the prior
 * call for that path resolves, so watch/unwatch for one path can never be
 * reordered regardless of how the app-level gestures interleave. Different paths
 * stay independent. Errors are swallowed (best-effort, matching the previous
 * fire-and-forget call sites) but never break the chain.
 */
const chains = new Map<string, Promise<void>>();

function enqueue(path: string, op: () => Promise<void>): Promise<void> {
  const prev = chains.get(path) ?? Promise.resolve();
  // Run `op` whether the previous link settled or rejected — one failure must
  // not stall the rest of the chain.
  const next = prev.then(op, op);
  chains.set(path, next);
  // Drop the entry once this link is the tail, so the map doesn't grow
  // unboundedly across a long session.
  void next.finally(() => {
    if (chains.get(path) === next) chains.delete(path);
  });
  return next;
}

/** Start (or replace) the watch for `path`, sequenced after any pending
 * watch/unwatch for the same path. */
export function watchRepo(path: string): Promise<void> {
  return enqueue(path, () => api.watchRepo(path).catch(() => {}));
}

/** Stop the watch for `path`, sequenced after any pending watch/unwatch for the
 * same path. */
export function unwatchRepo(path: string): Promise<void> {
  return enqueue(path, () => api.unwatchRepo(path).catch(() => {}));
}
