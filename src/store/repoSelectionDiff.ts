// Shared loader for the merged ("union") diff of a multi-commit selection
// (GL-68/GL-69). Both `selectCommitMulti` (a new selection) and `refresh` (the
// selection trimmed by a graph reload) need to fetch `selection_diff` for the
// current `commits` and publish the files behind a stale-response guard, so the
// fetch lives here instead of being duplicated across the two action modules.

import { api } from "@/lib/api";
import { repoSessionIsCurrent } from "./repoGuards";
import { publishedRepoSession } from "./repoRequests";
import type { RepoGet, RepoSet } from "./repoTypes";

let selectionUnionGeneration = 0;

/** True when the live `selectionDiff` still targets exactly `commits` in `repo`,
 * on the same side of the committed/working-tree split.
 * Compared as a **set**, not by order: the union is order-independent (the
 * backend re-sorts by ancestry), and `refresh` can re-publish the same set in a
 * different order — an order-sensitive check would make this in-flight fetch bail
 * and leave the inspector stuck on `loading: true`. `workingBase` is part of the
 * identity because the *same* commit set describes two different diffs depending
 * on whether the WIP row is in the pick. */
function stillTargets(
  get: RepoGet,
  repoPath: string,
  repoSession: number,
  generation: number,
  commits: string[],
  workingBase: string | null,
): boolean {
  const cur = get().selectionDiff;
  return (
    generation === selectionUnionGeneration &&
    repoSessionIsCurrent(get, repoPath, repoSession) &&
    !!cur &&
    (cur.workingBase ?? null) === workingBase &&
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
  workingBase?: string | null,
): Promise<void> {
  const generation = ++selectionUnionGeneration;
  const repoSession = publishedRepoSession.current();
  const base = workingBase ?? null;
  try {
    // With the WIP row in the selection the union is a range ending at the
    // working tree, so one `compare_refs` covers the commits *and* the
    // uncommitted changes — `selection_diff` only knows about committed trees.
    const files = base
      ? (await api.compareRefs(repoPath, base, null)).files
      : await api.selectionDiff(repoPath, commits);
    if (!stillTargets(get, repoPath, repoSession, generation, commits, base)) return;
    set((s) => (s.selectionDiff ? { selectionDiff: { ...s.selectionDiff, files, loading: false } } : {}));
  } catch (e) {
    if (!stillTargets(get, repoPath, repoSession, generation, commits, base)) return;
    set((s) =>
      s.selectionDiff ? { selectionDiff: { ...s.selectionDiff, loading: false, error: String(e) } } : {},
    );
  }
}

/**
 * Keep a working-tree-ended union honest across a worktree refresh (edit, stage,
 * commit, discard). While the tree is still dirty it just re-reads the live
 * range. Once the tree goes clean the union has no uncommitted part left, so it
 * folds back to committed-only: several commits reload as a plain
 * `selection_diff`, and a single commit drops the union entirely and reloads its
 * own file list — otherwise the inspector would fall back to the commit view
 * with an empty list, still labelled "+ uncommitted".
 */
export function reconcileWorkingUnion(set: RepoSet, get: RepoGet, repoPath: string): void {
  const union = get().selectionDiff;
  if (!union?.workingBase) return;
  if (get().wipSelected) {
    void loadSelectionUnion(set, get, repoPath, union.commits, union.workingBase);
    return;
  }
  if (union.commits.length > 1) {
    set((s) => ({
      selectionDiff: { commits: union.commits, files: [], workingBase: null, loading: true, error: null },
      // The open file's diff came from the range; the committed union is a
      // different diff, so drop it rather than leave worktree content on screen.
      fileSelectionRequestId: s.fileSelectionRequestId + 1,
      ...(s.selectedFile?.source === "commit" ? { selectedFile: null, fileDiff: null, diffLoading: false } : {}),
    }));
    void loadSelectionUnion(set, get, repoPath, union.commits, null);
    return;
  }
  const oid = union.commits[0] ?? null;
  const requestId = get().fileSelectionRequestId + 1;
  set((s) => ({
    selectionDiff: null,
    commitFiles: [],
    fileSelectionRequestId: requestId,
    diffLoading: oid !== null,
    // The open file's diff came from the compare; it no longer has a source.
    ...(s.selectedFile?.source === "commit" ? { selectedFile: null, fileDiff: null } : {}),
  }));
  if (!oid) return;
  const repoSession = publishedRepoSession.current();
  const fresh = () =>
    repoSessionIsCurrent(get, repoPath, repoSession) &&
    get().fileSelectionRequestId === requestId &&
    get().selectedCommit === oid;
  void api
    .commitFiles(repoPath, oid)
    .then((files) => {
      if (fresh()) set({ commitFiles: files, diffLoading: false });
    })
    .catch(() => {
      if (fresh()) set({ diffLoading: false });
    });
}
