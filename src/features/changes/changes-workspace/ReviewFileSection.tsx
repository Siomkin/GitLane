// One file's section in the multi-file changes review: sticky header (expand
// toggle, status, counts, stage/unstage checkbox) plus the lazily-loaded diff
// body. Presentational — all state and dispatch come in as props (GL-174).

import type { FileChange, FileDiff, WorkingChanges } from "../../../lib/api";
import { fileWriteGuard } from "../../../lib/advancedRepoState";
import { cn } from "../../../lib/cn";
import { basename, dirname } from "../../../lib/paths";
import type { ChangeSource } from "../../../store/repo";
import { FileIcon } from "@/components/ui/icons";
import { StatusPill } from "@/components/ui/StatusBadge";
import { ChangeCounts } from "@/components/ui/ChangeCounts";
import { UnifiedDiffBody } from "../../review/DiffBody";
import { BinaryDiff } from "../../review/BinaryDiff";
import { workSurface } from "./changesReviewModel";

export function ReviewFileSection({
  file,
  source,
  expanded,
  loading,
  diff,
  changes,
  onHeader,
  onToggle,
}: {
  file: FileChange;
  source: ChangeSource;
  expanded: boolean;
  loading: boolean;
  diff: FileDiff | null;
  changes: WorkingChanges;
  onHeader: () => void;
  onToggle: () => void;
}) {
  const staged = source === "staged";
  const disabledReason = fileWriteGuard(file, changes);
  return (
    <section className="border-b border-black/5 dark:border-white/5">
      <button
        type="button"
        className="flex items-center gap-2 px-4 h-11 w-full sticky top-0 z-10 text-left bg-white/95 dark:bg-neutral-800/95 backdrop-blur border-b border-black/5 dark:border-white/5"
        onClick={onHeader}
      >
        <span className="w-3 flex-none text-[10px] text-neutral-400">{expanded ? "▾" : "▸"}</span>
        <span className="text-[color:var(--accent)]">
          <FileIcon path={file.path} size={20} />
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px]">
          <span className="text-neutral-400">{dirname(file.path)}</span>
          <strong className="font-semibold text-neutral-800 dark:text-neutral-100">{basename(file.path)}</strong>
        </span>
        <StatusPill status={file.status} />
        <ChangeCounts add={file.add} del={file.del} binary={file.binary} className="text-[11px]" />
        {file.advanced && (
          <span className="rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[10.5px] font-medium text-amber-700 dark:text-amber-300">
            {file.advanced.message}
          </span>
        )}
        <span
          className={cn(
            "grid h-[18px] w-[18px] flex-none place-items-center rounded-[5px] border text-[12px] font-extrabold",
            !staged && "border-black/20 dark:border-white/20",
            disabledReason && "cursor-not-allowed opacity-45",
          )}
          style={{
            borderColor: staged ? "#2e9e62" : undefined,
            background: staged ? "#2e9e62" : "transparent",
            color: staged ? "#fff" : "transparent",
          }}
          onClick={(event) => {
            event.stopPropagation();
            if (!disabledReason) onToggle();
          }}
          title={disabledReason ?? (staged ? "Unstage file" : "Stage file")}
        >
          ✓
        </span>
      </button>
      {expanded && (
        <div className="bg-white dark:bg-neutral-800">
          {loading ? (
            <div className="px-4 py-3 text-xs text-neutral-400">Loading diff…</div>
          ) : diff && diff.binary ? (
            <BinaryDiff diff={diff} />
          ) : diff && !diff.binary ? (
            <UnifiedDiffBody hunks={diff.hunks} file={file.path} surface={workSurface(source)} />
          ) : (
            <div className="px-4 py-3 text-xs text-neutral-400">
              {diff === null ? "Couldn't load diff." : "No visible diff."}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
