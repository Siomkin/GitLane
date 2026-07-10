// The disposable per-file diff boundary for the changes review (GL-174):
// row derivation, expansion state, the snapshot-generation cache reset
// (GL-173), and the `api.fileDiff` thunks live here so the workspace container
// stays selector/layout/dispatch and the API import keeps a single documented
// owner for this feature.

import { useEffect, useMemo, useState } from "react";
// eslint-disable-next-line no-restricted-imports -- local per-file diff fetch via useLazyDiffs, disposable probe (architecture-rules-react.md §1)
import { api, type FileDiff, type WorkingChanges } from "../../../lib/api";
import { useLazyDiffs } from "../../../hooks/useLazyDiffs";
import { deriveReviewRows, rowPathsKey, KEY_SEP } from "./changesReviewModel";

export function useWorkingTreeDiffs(changes: WorkingChanges, repoPath: string | null) {
  const rows = useMemo(() => deriveReviewRows(changes), [changes]);
  const total = rows.length;
  const pathsKey = rowPathsKey(rows);

  // Expansion is local and per-file, so several files can stay open at once
  // (unlike before, when it was tied to the single store selection and opening
  // one file collapsed any other). Diffs are loaded and cached per file here,
  // independent of the store's single-file `fileDiff`.
  const [open, setOpen] = useState<Record<string, boolean>>({});
  // Per-file diff cache, valid for exactly one working-tree snapshot. Never
  // cancels — see useLazyDiffs.
  const { diffs, ensure, reset } = useLazyDiffs();

  // Only a store refresh can carry a content change, and every refresh
  // publishes a NEW `changes` object (watcher, focus re-sync, staging write,
  // repo switch) — so snapshot identity is the cache generation; the key's
  // status/counts can't stand in for content (GL-173). Declared before the
  // fetch effect below so an invalidated snapshot's open files refetch in the
  // same pass; expanding/collapsing files doesn't touch the snapshot, so the
  // cache is reused within one generation.
  useEffect(() => {
    reset();
  }, [changes, repoPath, reset]);

  // Expansion is per-repo: a switch clears it so a same-named path in the next
  // repo doesn't inherit the previous repo's open/collapsed choices (GL-174
  // review). The default-expansion effect below re-opens the first file.
  useEffect(() => {
    setOpen({});
  }, [repoPath]);

  // Open the first file by default so the view isn't empty on entry; only when
  // nothing is open yet (don't fight the user's manual collapses).
  useEffect(() => {
    if (total === 0) return;
    const rowPaths = pathsKey.split(KEY_SEP);
    setOpen((o) => {
      if (rowPaths.some((path) => o[path])) return o;
      return { ...o, [rowPaths[0]]: true };
    });
  }, [pathsKey, total, repoPath]);

  // Lazily fetch the diff for every open file that doesn't have one cached.
  useEffect(() => {
    if (!repoPath) return;
    const pending: Array<{ key: string; fetch: () => Promise<FileDiff> }> = [];
    for (const row of rows) {
      if (!open[row.path]) continue;
      pending.push({
        key: row.key,
        fetch: () => api.fileDiff(repoPath, row.path, row.source === "staged"),
      });
    }
    ensure(pending);
  }, [rows, open, repoPath, ensure]);

  return { rows, total, open, setOpen, diffs };
}
