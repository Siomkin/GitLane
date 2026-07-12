import type { FileDiff } from "@/lib/api";
import { cn } from "@/lib/cn";
import { basename, dirname } from "@/lib/paths";
import { CodeIcon, EyeIcon, FileIcon } from "@/components/ui/icons";
import { StatusPill } from "@/components/ui/StatusBadge";
import { ChangeCounts } from "@/components/ui/ChangeCounts";

export type DiffMode = "split" | "unified";

/** How a markdown file is shown: the raw diff ("code") or rendered ("preview"). */
export type MdView = "code" | "preview";

export function ReviewHeader({
  file,
  mode,
  onModeChange,
  markdown,
  mdView,
  onMdViewChange,
  onBack,
}: {
  file: FileDiff | null;
  mode: DiffMode;
  onModeChange: (mode: DiffMode) => void;
  markdown: boolean;
  mdView: MdView;
  onMdViewChange: (view: MdView) => void;
  onBack: () => void;
}) {
  const previewing = markdown && mdView === "preview";
  return (
    <div className="flex h-12 flex-none items-center gap-2.5 border-b border-black/5 dark:border-white/5 px-4">
      {file && (
        <>
          <span className="text-[color:var(--accent)]">
            <FileIcon path={file.path} size={20} />
          </span>
          <span className="text-[14px] font-semibold text-neutral-800 dark:text-neutral-100">{basename(file.path)}</span>
          <span className="min-w-0 truncate text-[12px] text-neutral-400">{dirname(file.path)}</span>
          <StatusPill status={file.status} />
          <ChangeCounts add={file.add} del={file.del} binary={file.binary} className="text-xs" />
        </>
      )}
      {/* Unified/Split + Graph are one right-aligned group: a single `ml-auto`
          on the wrapper pushes both to the far right. Two competing `ml-auto`
          siblings would instead split the free space, drifting the toggle
          inward and shifting its position with the filename width. Binary files
          hide the toggle (they render an image/size card, not line hunks) —
          Graph stays put because the wrapper owns the margin. */}
      <div className="ml-auto flex items-center gap-2.5">
        {markdown && (
          <div className="flex p-0.5 rounded-lg bg-black/[0.06] dark:bg-white/[0.06] text-[12px]">
            <button type="button"
              className={cn(modeButton(mdView === "code"), "flex items-center gap-1.5")}
              title="Show the raw diff"
              onClick={() => onMdViewChange("code")}
            >
              <CodeIcon width={13} height={13} />
              Code
            </button>
            <button type="button"
              className={cn(modeButton(mdView === "preview"), "flex items-center gap-1.5")}
              title="Render the file as formatted Markdown"
              onClick={() => onMdViewChange("preview")}
            >
              <EyeIcon width={13} height={13} />
              Preview
            </button>
          </div>
        )}
        {/* Unified/Split picks between diff layouts, so it hides while the
            rendered preview replaces the diff (and for binary files, which
            render an image/size card, not line hunks). */}
        {!file?.binary && !previewing && (
          <div className="flex p-0.5 rounded-lg bg-black/[0.06] dark:bg-white/[0.06] text-[12px]">
            <button type="button" className={modeButton(mode === "unified")} onClick={() => onModeChange("unified")}>
              Unified
            </button>
            <button type="button" className={modeButton(mode === "split")} onClick={() => onModeChange("split")}>
              Split
            </button>
          </div>
        )}
        <button type="button"
          className="flex items-center gap-1 h-8 px-2.5 rounded-lg border border-black/10 dark:border-white/10 text-[12px] font-medium text-neutral-600 dark:text-neutral-300 hover:bg-black/5 dark:hover:bg-white/5"
          onClick={onBack}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3 h-3">
            <path d="m15 18-6-6 6-6" />
          </svg>
          Graph
        </button>
      </div>
    </div>
  );
}

function modeButton(active: boolean) {
  return cn(
    "px-2.5 h-6 rounded-md",
    active
      ? "bg-white dark:bg-neutral-700 shadow-sm font-medium text-neutral-800 dark:text-neutral-100"
      : "text-neutral-500 dark:text-neutral-400",
  );
}
