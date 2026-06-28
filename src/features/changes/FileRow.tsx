import type { MouseEvent } from "react";
import type { FileChange } from "../../lib/api";
import { cn } from "../../lib/cn";
import { focusRing } from "../../lib/ui";
import { basename, dirname } from "../../lib/paths";
import { FileIcon } from "@/components/ui/icons";
import { StatusBadge } from "@/components/ui/StatusBadge";

/** The shared file row: working changes (with a stage/unstage action) and
 * commit changed-file lists (no action).
 *
 * The stage/unstage control is a sibling `<button>` overlaying the row — not
 * nested inside the row button (which would be invalid HTML and produce a
 * double tab stop). It's hidden and `pointer-events-none` at rest so clicks at
 * the right edge still select the row, and reveals on row hover or its own
 * keyboard focus. */
export function FileRow({
  file,
  active,
  onClick,
  onContextMenu,
  menuActive = false,
  action,
  compact = false,
}: {
  file: FileChange;
  active: boolean;
  onClick: () => void;
  /** Right-click handler (working-changes rows open a context menu). */
  onContextMenu?: (e: MouseEvent) => void;
  /** This row is the open context menu's target — ringed so it's clear which
   * file the menu acts on while focus sits in the floating menu. */
  menuActive?: boolean;
  action?: { tone: "stage" | "unstage"; onAction: () => void };
  compact?: boolean;
}) {
  const actionLabel = action?.tone === "stage" ? "Stage file" : "Unstage file";

  return (
    <div className="group relative select-none" onContextMenu={onContextMenu}>
      <button
        type="button"
        className={cn(
          "flex w-full items-center gap-2.5 rounded-lg px-2 text-left hover:bg-black/5 dark:hover:bg-white/5",
          focusRing,
          compact ? "h-11" : "h-12",
          active && "bg-[var(--accent-soft)]",
          menuActive && "bg-[var(--accent-soft)] ring-1 ring-inset ring-[color:var(--accent)]",
        )}
        onClick={onClick}
      >
        <FileIcon path={file.path} size={compact ? 16 : 20} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] text-neutral-800 dark:text-neutral-100">
            {basename(file.path)}
          </span>
          {/* Always show the directory — in compact rows too (a selected commit's
              file list), so the location is clear, matching the working-changes
              rows. */}
          <span className="block truncate text-[11px] text-neutral-400">{dirname(file.path)}</span>
        </span>
        <span
          className={cn(
            "flex shrink-0 items-center gap-2 font-mono text-xs transition-opacity",
            action && "group-hover:opacity-0",
          )}
        >
          <span className="text-[color:var(--accent)]">+{file.add}</span>
          <span className="text-rose-500">−{file.del}</span>
          <StatusBadge status={file.status} />
        </span>
      </button>
      {action && (
        <button
          type="button"
          aria-label={actionLabel}
          title={actionLabel}
          onClick={action.onAction}
          className={cn(
            "absolute right-2 top-1/2 h-8 -translate-y-1/2 rounded-lg px-3 text-[12px] font-medium leading-8",
            "opacity-0 transition-opacity pointer-events-none",
            "group-hover:pointer-events-auto group-hover:opacity-100",
            "focus-visible:pointer-events-auto focus-visible:opacity-100",
            focusRing,
            action.tone === "stage"
              ? "bg-[var(--accent)] text-white hover:brightness-110"
              : "border border-black/10 bg-white text-neutral-700 hover:bg-black/5 dark:border-white/10 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-white/10",
          )}
        >
          {action.tone === "stage" ? "Stage File" : "Unstage"}
        </button>
      )}
    </div>
  );
}
