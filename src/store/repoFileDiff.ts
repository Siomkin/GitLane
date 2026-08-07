// Background reconcile for the open working-tree file diff (GL-123). The
// watcher-driven `refresh` refreshes the changed-files list (right panel), but
// the diff of the file currently open in the viewer is a separate slice
// (`fileDiff`) that `refresh` doesn't touch — so a file edited on disk while
// its diff is open would stay stale until the user re-clicked it. This module
// refetches that open diff after a refresh, so an external edit lands live.
//
// Quiet by design: it never touches `diffLoading`, so a watcher tick never
// flashes the diff spinner (the diff already on screen stays put until the new
// one arrives); cf. `refreshCompare`, which likewise reconciles in place.

import { api } from "@/lib/api";
import { requestLease } from "./requestLease";
import type { ChangeSource, RepoGet, RepoSet } from "./repoTypes";

// Overlapping reconciles (watcher ticks outpacing a slow `file_diff`) resolve
// newest-wins: an older response that lands after a newer reconcile started must
// not publish over it.
const reconciles = requestLease();

/** Drop any in-flight reconcile. Called by the foreground loaders
 * (`selectFile`/`loadFullFileDiff`) so a reconcile that started before them
 * can't publish over their fresher result after they complete — the
 * `diffLoading` check below only covers the window while they're in flight. */
export function invalidateFileDiffReconciles(): void {
  reconciles.claim();
}

/** True when the live `selectedFile` still targets exactly `path` *as* `source`
 * in `repo`. A stale-response guard: a slow refetch mustn't clobber a newer
 * selection, a repo switch, or — for the same path — a switch between the
 * staged and unstaged rows (an unstaged diff must never publish into a staged
 * selection). Commit selections are never targeted — they read immutable oids. */
function stillSelected(get: RepoGet, repoPath: string, path: string, source: ChangeSource): boolean {
  const sel = get().selectedFile;
  return (
    get().summary?.path === repoPath &&
    !!sel && sel.source === source && sel.path === path
  );
}

/**
 * Refetch the open working-tree file's diff and publish it into `fileDiff`.
 * Best-effort and fire-and-forget: called by `refresh` after the changed-files
 * list is updated so the open diff follows an external edit. Bails (touching no
 * state) if a newer reconcile, a selection/repo change, or a foreground diff
 * load happened while the request was in flight.
 */
export async function reconcileFileDiff(set: RepoSet, get: RepoGet, repoPath: string): Promise<void> {
  const sel = get().selectedFile;
  if (!sel || sel.source === "commit") return;
  const { path, source } = sel;
  // No persistent "show full" flag exists, so infer intent from the shown diff:
  // a non-truncated one was fully expanded (either small, or the user hit "show
  // full"), so refetch full to preserve that; a truncated one stays capped.
  const full = get().fileDiff?.truncated === false;
  const token = reconciles.claim();
  try {
    // `source` is honored as-is: a file that moved buckets (unstaged→staged)
    // keeps its selection source until the user picks a row again, so an
    // unstaged-sourced file now only in the index shows an empty diff rather
    // than being silently retargeted to the other bucket.
    const fileDiff = await api.fileDiff(repoPath, path, source === "staged", full);
    if (!reconciles.isCurrent(token)) return;
    if (!stillSelected(get, repoPath, path, source)) return;
    // A foreground load (`selectFile`/`loadFullFileDiff`) owns the pane while
    // `diffLoading` is up; it will land fresher content, so don't race it.
    if (get().diffLoading) return;
    // Never downgrade an expanded diff: if "show full" landed while this capped
    // fetch was in flight, dropping its truncated result here keeps the expanded
    // view; the next tick re-derives `full` from it and refetches full.
    if (!full && get().fileDiff?.truncated === false) return;
    set({ fileDiff });
  } catch {
    // best-effort background reconcile: keep the prior diff on failure
  }
}
