import type { MouseEvent } from "react";
import type { FileChange } from "@/lib/api";
import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";
import { basename } from "@/lib/paths";
import { FileIcon } from "@/components/ui/FileIcon";
import { ChevronRightIcon, FolderIcon } from "@/components/ui/icons";
import { ChangeCounts } from "@/components/ui/ChangeCounts";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { TriStateCheckbox } from "@/components/ui/TriStateCheckbox";
import { HighlightMatch } from "@/components/ui/HighlightMatch";
import { CHECKBOX_INSET, type FileRowAction } from "./types";

/** Indent per tree depth level, in px — matches the repository Files tab
 * (`repo-files/rows.tsx`) so the two trees read identically. */
const INDENT = 14;

export function DirRow({
  label,
  depth,
  count,
  collapsed,
  menuActive,
  onToggle,
  onContextMenu,
  action,
}: {
  label: string;
  depth: number;
  count: number;
  collapsed: boolean;
  menuActive: boolean;
  onToggle: () => void;
  onContextMenu?: (e: MouseEvent) => void;
  action?: FileRowAction;
}) {
  return (
    <div className="group relative select-none" onContextMenu={onContextMenu}>
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={onToggle}
        style={{ paddingLeft: 8 + depth * INDENT + inset(action) }}
        className={cn(
          // Square hover like the Files tab (`repo-files/rows.tsx`) — explicit
          // rounded-none so UA/button defaults can't round the highlight.
          "flex h-[26px] w-full items-center gap-1.5 rounded-none px-2 text-left text-[12.5px] text-neutral-700 hover:bg-black/[0.04] dark:text-neutral-200 dark:hover:bg-white/[0.05]",
          menuActive && "bg-[var(--accent-soft)] ring-1 ring-inset ring-[color:var(--accent)]",
        )}
      >
        <ChevronRightIcon
          className={cn(
            "h-3 w-3 shrink-0 text-neutral-400 transition-transform",
            !collapsed && "rotate-90",
          )}
        />
        <FolderIcon className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
        <span className="min-w-0 truncate">{label}</span>
        <span
          className={cn(
            "ml-auto shrink-0 pl-2 text-[11px] text-neutral-400",
            hovers(action) && "group-hover:opacity-0 group-focus-within:opacity-0",
          )}
        >
          {count}
        </span>
      </button>
      {action && <RowAction action={action} left={8 + depth * INDENT} />}
    </div>
  );
}

export function TreeFileRow({
  file,
  depth,
  active,
  menuActive,
  onSelect,
  onContextMenu,
  action,
  highlight,
}: {
  file: FileChange;
  depth: number;
  active: boolean;
  menuActive: boolean;
  onSelect: () => void;
  onContextMenu?: (e: MouseEvent) => void;
  action?: FileRowAction;
  highlight?: string;
}) {
  return (
    <div className="group relative select-none" onContextMenu={onContextMenu}>
      <button
        type="button"
        data-path={file.path}
        aria-current={active || undefined}
        onClick={onSelect}
        // Tree rows show only the basename, so the full repo-relative path lives
        // in the tooltip (parity with the Files tab) to disambiguate same-named
        // files in different folders.
        title={file.path}
        // Files sit one chevron-width in from their parent folder's label, the
        // same offset the Files tab uses so the two trees align.
        style={{ paddingLeft: 8 + depth * INDENT + 18 + inset(action) }}
        className={cn(
          "flex h-[26px] w-full items-center gap-1.5 rounded-none px-2 text-left text-[12.5px]",
          active
            ? "bg-[var(--accent-soft)] font-medium text-neutral-800 dark:text-neutral-100"
            : "text-neutral-700 hover:bg-black/[0.04] dark:text-neutral-200 dark:hover:bg-white/[0.05]",
          menuActive && "bg-[var(--accent-soft)] ring-1 ring-inset ring-[color:var(--accent)]",
        )}
      >
        <FileIcon path={file.path} size={15} />
        <span className="min-w-0 flex-1 truncate">
          <HighlightMatch text={basename(file.path)} query={highlight ?? ""} />
        </span>
        <span
          className={cn(
            "flex shrink-0 items-center gap-2",
            // Fade the counts/badge for both hover and keyboard focus, so the
            // action overlay (revealed on either) never overlaps them.
            hovers(action) && "group-hover:opacity-0 group-focus-within:opacity-0",
          )}
        >
          <ChangeCounts
            add={file.add}
            del={file.del}
            binary={file.binary}
            addAtLeast={file.lineCountTruncated}
            className="text-[11px]"
          />
          <StatusBadge status={file.status} />
        </span>
      </button>
      {action && <RowAction action={action} left={8 + depth * INDENT + 18} />}
    </div>
  );
}

const inset = (action?: FileRowAction) => (action?.checked !== undefined ? CHECKBOX_INSET : 0);
const hovers = (action?: FileRowAction) => !!action && action.checked === undefined;

/** The hover-revealed stage/unstage button overlaying a tree row's right edge —
 * the same reveal idiom as `FileRow`'s action, sized for the shorter tree rows. */
function RowAction({ action, left }: { action: FileRowAction; left: number }) {
  if (action.checked !== undefined) {
    return (
      <TriStateCheckbox
        checked={action.checked}
        label={action.checked === true ? "Exclude from commit" : "Include in commit"}
        onChange={action.onAction}
        disabledReason={action.disabledReason}
        className="absolute top-1/2 -translate-y-1/2"
        style={{ left }}
      />
    );
  }
  const label = action.tone === "stage" ? "Stage" : "Unstage";
  const disabled = !!action.disabledReason;
  return (
    <button
      type="button"
      aria-label={label}
      title={action.disabledReason ?? label}
      onClick={disabled ? undefined : action.onAction}
      disabled={disabled}
      className={cn(
        "absolute right-2 top-1/2 h-6 -translate-y-1/2 rounded-md px-2.5 text-[11px] font-medium leading-6",
        "pointer-events-none opacity-0 transition-opacity",
        disabled
          ? "group-hover:pointer-events-auto group-hover:opacity-55 focus-visible:pointer-events-auto focus-visible:opacity-55 disabled:cursor-not-allowed"
          : "group-hover:pointer-events-auto group-hover:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100",
        focusRing,
        action.tone === "stage"
          ? "bg-[var(--accent)] text-white hover:brightness-110"
          : "border border-black/10 bg-white text-neutral-700 hover:bg-black/5 dark:border-white/10 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-white/10",
      )}
    >
      {label}
    </button>
  );
}
