// The Include diff's data boundary: the selected working file's HEAD-to-working-
// tree differences, refetched on every new working-changes snapshot (a refresh
// is the only thing that can carry a content change — the GL-173 cache rule).

import { useEffect, useState } from "react";
// eslint-disable-next-line no-restricted-imports -- local per-file differences read for the selected file, disposable probe (architecture-rules-react.md §1)
import { api, type FileDifferences, type WorkingChanges } from "@/lib/api";

type Loaded = { key: string; data: FileDifferences | null; error: string | null };

export function useFileDifferences(
  repoPath: string | null,
  path: string | null,
  changes: WorkingChanges,
  wholeFile = false,
): { data: FileDifferences | null; error: string | null; loading: boolean } {
  const key = `${repoPath ?? ""}\u0000${path ?? ""}\u0000${wholeFile ? "whole" : "hunks"}`;
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    if (!repoPath || !path) return;
    let live = true;
    api.workingFileDifferences(repoPath, path, wholeFile).then(
      (data) => live && setLoaded({ key, data, error: null }),
      (e: unknown) => live && setLoaded({ key, data: null, error: String(e) }),
    );
    return () => {
      live = false;
    };
  }, [repoPath, path, changes, wholeFile, key]);

  // Keep showing the last result for this same file while a refetch runs, so a
  // checkbox click does not flash a loading state; another file starts empty.
  const current = loaded?.key === key ? loaded : null;
  return { data: current?.data ?? null, error: current?.error ?? null, loading: !current };
}
