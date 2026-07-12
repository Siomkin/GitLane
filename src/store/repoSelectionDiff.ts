// Shared loader for the merged ("union") diff of a multi-commit selection
// (GL-68/GL-69). Both `selectCommitMulti` (a new selection) and `refresh` (the
// selection trimmed by a graph reload) need to fetch `selection_diff` for the
// current `commits` and publish the files behind a stale-response guard, so the
// fetch lives here instead of being duplicated across the two action modules.

import { api } from "@/lib/api";
import type { RepoGet, RepoSet } from "./repoTypes";

/** True when the live `selectionDiff` still targets exactly `commits` in `repo`.
 * Compared as a **set**, not by order: the union is order-independent (the
 * backend re-sorts by ancestry), and `refresh` can re-publish the same set in a
 * different order — an order-sensitive check would make this in-flight fetch bail
 * and leave the inspector stuck on `loading: true`. */
function stillTargets(get: RepoGet, repoPath: string, commits: string[]): boolean {
  const cur = get().selectionDiff;
  return (
    get().summary?.path === repoPath &&
    !!cur &&
    cur.commits.length === commits.length &&
    cur.commits.every((id) => commits.includes(id))
  );
}

/**
 * Fetch the union of changes across `commits` and publish them into
 * `selectionDiff.files`. Assumes the caller already set
 * `selectionDiff = { commits, files: [], loading: true, … }`. Bails (without
 * touching state) if the selection or repo changed while the request was in
 * flight, so an older selection's files can't overwrite a newer one.
 */
export async function loadSelectionUnion(
  set: RepoSet,
  get: RepoGet,
  repoPath: string,
  commits: string[],
): Promise<void> {
  try {
    const files = await api.selectionDiff(repoPath, commits);
    if (!stillTargets(get, repoPath, commits)) return;
    set((s) => (s.selectionDiff ? { selectionDiff: { ...s.selectionDiff, files, loading: false } } : {}));
  } catch (e) {
    if (!stillTargets(get, repoPath, commits)) return;
    set((s) =>
      s.selectionDiff ? { selectionDiff: { ...s.selectionDiff, loading: false, error: String(e) } } : {},
    );
  }
}
