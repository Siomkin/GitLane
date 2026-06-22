// Staged-diff preview pane for the file selected in the Commit modal's tree
// view. Self-contained (fetches its own diff via api) so the modal container
// just dispatches the active path to it.

import { useEffect, useState } from "react";
import { api, type FileDiff } from "../../lib/api";
import { basename, dirname } from "../../lib/paths";
import { UnifiedDiffBody } from "../review/DiffBody";

export function DiffPreview({ repoPath, path }: { repoPath: string | null; path: string | null }) {
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let live = true;
    if (!repoPath || !path) {
      setDiff(null);
      return;
    }
    setLoading(true);
    api
      .fileDiff(repoPath, path, true)
      .then((d) => live && setDiff(d))
      .catch(() => live && setDiff(null))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [repoPath, path]);

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-black/5 px-3 dark:border-white/5">
        <span className="truncate text-[12px] text-neutral-400">{path ? dirname(path) : ""}</span>
        <span className="truncate text-[12px] font-semibold text-neutral-800 dark:text-neutral-100">
          {path ? basename(path) : ""}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {loading ? (
          <div className="px-3 py-3 text-[12px] text-neutral-400">Loading diff…</div>
        ) : diff && !diff.binary ? (
          <UnifiedDiffBody hunks={diff.hunks} />
        ) : (
          <div className="px-3 py-3 text-[12px] text-neutral-400">
            {diff?.binary ? "Binary file" : "No diff"}
          </div>
        )}
      </div>
    </div>
  );
}
