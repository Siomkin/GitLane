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

import { api } from "../lib/api";
import type { RepoGet, RepoSet } from "./repoTypes";

/** True when the live `selectedFile` still targets exactly `path` in `repo`.
 * A stale-response guard: a slow refetch mustn't clobber a newer selection or a
 * repo switch that happened while it was in flight. Commit selections are never
 * targeted — they read from `commitFiles`, not this working-tree diff. */
function stillSelected(get: RepoGet, repoPath: string, path: string): boolean {
  const sel = get().selectedFile;
  return (
    get().summary?.path === repoPath &&
    !!sel && sel.source !== "commit" && sel.path === path
  );
}

/**
 * Refetch the open working-tree file's diff and publish it into `fileDiff`.
 * Best-effort and fire-and-forget: called by `refresh` after the changed-files
 * list is updated so the open diff follows an external edit. Bails (touching no
 * state) if the selection or repo changed while the request was in flight.
 */
export async function reconcileFileDiff(set: RepoSet, get: RepoGet, repoPath: string): Promise<void> {
  const sel = get().selectedFile;
  if (!sel || sel.source === "commit") return;
  const { path, source } = sel;
  // No persistent "show full" flag exists, so infer intent from the shown diff:
  // a non-truncated one was fully expanded (either small, or the user hit "show
  // full"), so refetch full to preserve that; a truncated one stays capped.
  const full = get().fileDiff?.truncated === false;
  try {
    // `source` is honored as-is: a file that moved buckets (unstaged→staged)
    // keeps its selection source, so an unstaged-sourced file now only in the
    // index yields an empty diff — the same result a re-click would produce.
    const fileDiff = await api.fileDiff(repoPath, path, source === "staged", full);
    if (!stillSelected(get, repoPath, path)) return;
    // Never downgrade an expanded diff: if "show full" landed while this capped
    // fetch was in flight, dropping its truncated result here keeps the expanded
    // view; the next tick re-derives `full` from it and refetches full.
    if (!full && get().fileDiff?.truncated === false) return;
    set({ fileDiff });
  } catch {
    // best-effort background reconcile: keep the prior diff on failure
  }
}
