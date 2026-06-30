import { useState, type MouseEvent } from "react";
import type { FileChange } from "../../../lib/api";
import { cn } from "../../../lib/cn";
import { basename } from "../../../lib/paths";
import { buildRows } from "../commitTree";
import { FileRow } from "../FileRow";
import { FileIcon } from "@/components/ui/icons";
import { ChangeCounts } from "@/components/ui/ChangeCounts";
import { StatusBadge } from "@/components/ui/StatusBadge";

export type FileListView = "path" | "tree";

/** The union-of-changed-files list for a merged selection, in either flat
 * **Path** mode (the same `FileRow` the single-commit inspector uses) or
 * grouped **Tree** mode (directory headers via the shared `buildRows`). The
 * tree's collapse state is a local UI affordance; selection lives in the store. */
export function MergedFileList({
  files,
  view,
  activePath,
  onSelect,
  onContextMenu,
}: {
  files: FileChange[];
  view: FileListView;
  activePath: string | null;
  onSelect: (path: string) => void;
  onContextMenu?: (path: string, e: MouseEvent) => void;
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  if (view === "path") {
    return (
      <div className="space-y-0.5">
        {files.map((file) => (
          <FileRow
            key={file.path}
            file={file}
            compact
            active={activePath === file.path}
            onClick={() => onSelect(file.path)}
            onContextMenu={onContextMenu ? (e) => onContextMenu(file.path, e) : undefined}
          />
        ))}
      </div>
    );
  }

  // Tree mode: every file is "included" (no checkboxes here), so the directory
  // roll-up state is irrelevant — pass a constant predicate.
  const rows = buildRows(files, collapsed, () => true);
  return (
    <div className="space-y-0.5">
      {rows.map((row) =>
        row.kind === "dir" ? (
          <button
            key={row.key}
            type="button"
            onClick={() => setCollapsed((c) => ({ ...c, [row.key]: !c[row.key] }))}
            style={{ paddingLeft: 6 + row.depth * 14 }}
            className="flex h-7 w-full items-center gap-1.5 rounded-md pr-2 text-left text-neutral-500 hover:bg-black/5 dark:text-neutral-400 dark:hover:bg-white/5"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              className={cn("h-3 w-3 text-neutral-400 transition-transform", row.collapsed && "-rotate-90")}
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-4 w-4 shrink-0 text-neutral-400">
              <path d="M3 7v12a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V9a1 1 0 0 0-1-1h-8l-2-2H4a1 1 0 0 0-1 1z" />
            </svg>
            <span className="truncate text-[12.5px] font-medium text-neutral-600 dark:text-neutral-300">{row.label}</span>
            <span className="ml-auto shrink-0 pl-2 text-[11px] text-neutral-400">{row.count}</span>
          </button>
        ) : (
          <button
            key={row.key}
            type="button"
            onClick={() => onSelect(row.file.path)}
            onContextMenu={onContextMenu ? (e) => onContextMenu(row.file.path, e) : undefined}
            style={{ paddingLeft: 6 + row.depth * 14 }}
            className={cn(
              "flex h-9 w-full items-center gap-2 rounded-md pr-2 text-left",
              activePath === row.file.path ? "bg-[var(--accent-soft)]" : "hover:bg-black/5 dark:hover:bg-white/5",
            )}
          >
            <FileIcon path={row.file.path} size={16} />
            <span className="min-w-0 flex-1 truncate text-[13px] text-neutral-800 dark:text-neutral-100">
              {basename(row.file.path)}
            </span>
            <ChangeCounts add={row.file.add} del={row.file.del} binary={row.file.binary} className="text-[11px]" />
            <StatusBadge status={row.file.status} />
          </button>
        ),
      )}
    </div>
  );
}
