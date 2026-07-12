import { useState, type MouseEvent } from "react";
import type { FileChange } from "@/lib/api";
import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";
import { basename } from "@/lib/paths";
import { buildRows } from "@/features/changes/commitTree";
import { FileRow } from "@/features/changes/FileRow";
import { FileIcon } from "@/components/ui/icons";
import { ChangeCounts } from "@/components/ui/ChangeCounts";
import { StatusBadge } from "@/components/ui/StatusBadge";
import type { FileListView, FileRowAction } from "./types";

/** A changed-files list in either flat **Path** mode (the shared `FileRow`) or
 * grouped **Tree** mode (directory headers via the shared `buildRows`). Shared by
 * the selected-commit, working-changes, and merged-selection inspectors (GL-28).
 *
 * The tree's collapse state is a local UI affordance; selection lives in each
 * caller's store. An optional `rowAction` adds a per-file stage/unstage control
 * (working changes); `dirAction` adds the folder roll-up that stages/unstages a
 * whole directory at once. */
export function ChangedFileList({
  files,
  view,
  activePath,
  menuActivePath = null,
  onSelect,
  onContextMenu,
  compact = true,
  rowAction,
  dirAction,
}: {
  files: FileChange[];
  view: FileListView;
  activePath: string | null;
  /** Path whose context menu is open (ringed), or null. */
  menuActivePath?: string | null;
  onSelect: (path: string) => void;
  onContextMenu?: (path: string, e: MouseEvent) => void;
  /** Row height: `true` for the compact commit/selection lists, `false` for the
   * taller working-changes rows that also carry a stage/unstage action. */
  compact?: boolean;
  /** Per-file stage/unstage affordance (working changes). Omitted → read-only. */
  rowAction?: (file: FileChange) => FileRowAction | undefined;
  /** Folder roll-up in Tree mode — stage/unstage every file under a directory at
   * once. Omitted → directory headers show just the file count. */
  dirAction?: (paths: string[]) => FileRowAction | undefined;
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  if (view === "path") {
    return (
      <div className="space-y-0.5">
        {files.map((file) => (
          <FileRow
            key={file.path}
            file={file}
            compact={compact}
            active={activePath === file.path}
            menuActive={menuActivePath === file.path}
            onClick={() => onSelect(file.path)}
            onContextMenu={onContextMenu ? (e) => onContextMenu(file.path, e) : undefined}
            action={rowAction?.(file)}
          />
        ))}
      </div>
    );
  }

  // Tree mode: the roll-up checkbox state is unused here (actions are explicit
  // Stage/Unstage buttons, not checkboxes), so pass a constant include predicate.
  const rows = buildRows(files, collapsed, () => true);
  return (
    <div className="space-y-0.5">
      {rows.map((row) =>
        row.kind === "dir" ? (
          <DirRow
            key={row.key}
            label={row.label}
            depth={row.depth}
            count={row.count}
            collapsed={row.collapsed}
            onToggle={() => setCollapsed((c) => ({ ...c, [row.key]: !c[row.key] }))}
            action={dirAction?.(row.paths)}
          />
        ) : (
          <TreeFileRow
            key={row.key}
            file={row.file}
            depth={row.depth}
            active={activePath === row.file.path}
            menuActive={menuActivePath === row.file.path}
            onSelect={() => onSelect(row.file.path)}
            onContextMenu={onContextMenu ? (e) => onContextMenu(row.file.path, e) : undefined}
            action={rowAction?.(row.file)}
          />
        ),
      )}
    </div>
  );
}

function DirRow({
  label,
  depth,
  count,
  collapsed,
  onToggle,
  action,
}: {
  label: string;
  depth: number;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  action?: FileRowAction;
}) {
  return (
    <div className="group relative">
      <button
        type="button"
        onClick={onToggle}
        style={{ paddingLeft: 6 + depth * 14 }}
        className="flex h-7 w-full items-center gap-1.5 rounded-md pr-2 text-left text-neutral-500 hover:bg-black/5 dark:text-neutral-400 dark:hover:bg-white/5"
      >
        {/* Disclosure chevron + folder read as one unit, so they hug at gap-0.5
            while the row's gap-1.5 still spaces the folder from the label. */}
        <span className="flex shrink-0 items-center gap-0.5">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            className={cn("h-3 w-3 text-neutral-400 transition-transform", collapsed && "-rotate-90")}
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-4 w-4 text-neutral-400">
            <path d="M3 7v12a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V9a1 1 0 0 0-1-1h-8l-2-2H4a1 1 0 0 0-1 1z" />
          </svg>
        </span>
        <span className="truncate text-[12.5px] font-medium text-neutral-600 dark:text-neutral-300">{label}</span>
        <span className={cn("ml-auto shrink-0 pl-2 text-[11px] text-neutral-400", action && "group-hover:opacity-0")}>
          {count}
        </span>
      </button>
      {action && <RowAction action={action} />}
    </div>
  );
}

function TreeFileRow({
  file,
  depth,
  active,
  menuActive,
  onSelect,
  onContextMenu,
  action,
}: {
  file: FileChange;
  depth: number;
  active: boolean;
  menuActive: boolean;
  onSelect: () => void;
  onContextMenu?: (e: MouseEvent) => void;
  action?: FileRowAction;
}) {
  return (
    <div className="group relative" onContextMenu={onContextMenu}>
      <button
        type="button"
        onClick={onSelect}
        style={{ paddingLeft: 6 + depth * 14 }}
        className={cn(
          "flex h-9 w-full items-center gap-2 rounded-md pr-2 text-left",
          active ? "bg-[var(--accent-soft)]" : "hover:bg-black/5 dark:hover:bg-white/5",
          menuActive && "bg-[var(--accent-soft)] ring-1 ring-inset ring-[color:var(--accent)]",
        )}
      >
        <FileIcon path={file.path} size={16} />
        <span className="min-w-0 flex-1 truncate text-[13px] text-neutral-800 dark:text-neutral-100">
          {basename(file.path)}
        </span>
        <span className={cn("flex shrink-0 items-center gap-2", action && "group-hover:opacity-0")}>
          <ChangeCounts add={file.add} del={file.del} binary={file.binary} className="text-[11px]" />
          <StatusBadge status={file.status} />
        </span>
      </button>
      {action && <RowAction action={action} />}
    </div>
  );
}

/** The hover-revealed stage/unstage button overlaying a tree row's right edge —
 * the same reveal idiom as `FileRow`'s action, sized for the shorter tree rows. */
function RowAction({ action }: { action: FileRowAction }) {
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
