import { useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import type { FileChange } from "@/lib/api";
import { buildRows } from "@/features/changes/commitTree";
import { FileRow } from "@/features/changes/FileRow";
import { FileListView, type FileRowAction } from "./types";
import { DirRow, TreeFileRow } from "./treeRows";
import { useVirtualRows } from "./useVirtualRows";

/** Tree rows are a fixed `h-[26px]`. */
const TREE_ROW = 26;
/** Path rows are `FileRow`'s h-11 / h-12 / h-14 plus the 2px gap below each. */
const pathRowHeight = (file: FileChange, compact: boolean) =>
  (file.advanced ? 56 : compact ? 44 : 48) + 2;

/** A changed-files list in either flat **Path** mode (the shared `FileRow`) or
 * grouped **Tree** mode (directory headers via the shared `buildRows`). Shared by
 * the selected-commit, working-changes, and merged-selection inspectors (GL-28).
 *
 * Only the rows near the viewport are mounted, so a change of thousands of files
 * stays responsive; the list still scrolls with the rest of its inspector.
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
  onDirContextMenu,
  compact = true,
  rowAction,
  dirAction,
  forceExpanded = false,
  highlight,
}: {
  files: FileChange[];
  view: FileListView;
  activePath: string | null;
  /** Path whose context menu is open (ringed), or null. */
  menuActivePath?: string | null;
  onSelect: (path: string) => void;
  onContextMenu?: (path: string, e: MouseEvent) => void;
  /** Right-click on a Tree-view directory header, with the folder's repo-relative
   * path. Omitted → folders have no context menu. */
  onDirContextMenu?: (dirPath: string, e: MouseEvent) => void;
  /** Row height for **Path** mode: `true` for the compact commit/selection lists,
   * `false` for the taller working-changes rows that also carry a stage/unstage
   * action. Tree mode always uses the compact Files-tab row height regardless. */
  compact?: boolean;
  /** Per-file stage/unstage affordance (working changes). Omitted → read-only. */
  rowAction?: (file: FileChange) => FileRowAction | undefined;
  /** Folder roll-up in Tree mode — stage/unstage every file under a directory at
   * once. Omitted → directory headers show just the file count. */
  dirAction?: (paths: string[]) => FileRowAction | undefined;
  /** Ignore (but keep) the local collapse state and show every directory open —
   * the filtered view auto-expands so matches are always visible (design 3b). */
  forceExpanded?: boolean;
  /** Active filter query — its first occurrence is marked in each row's name. */
  highlight?: string;
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const listRef = useRef<HTMLDivElement>(null);
  const isTree = view !== FileListView.Path;
  // Tree mode: the roll-up checkbox state is unused here (actions are explicit
  // Stage/Unstage buttons, not checkboxes), so pass a constant include predicate.
  const rows = useMemo(
    () =>
      isTree
        ? buildRows(files, forceExpanded ? {} : collapsed, () => true)
        : files.map((file) => ({ kind: "file" as const, key: file.path, depth: 0, file })),
    [isTree, files, forceExpanded, collapsed],
  );
  const filePaths = useMemo(
    () => rows.flatMap((row) => (row.kind === "file" ? [row.file.path] : [])),
    [rows],
  );
  const virtualizer = useVirtualRows(
    listRef,
    rows.length,
    (index) => {
      const row = rows[index];
      if (isTree || !row || row.kind !== "file") return TREE_ROW;
      return pathRowHeight(row.file, compact);
    },
    (index) => rows[index]?.key ?? String(index),
  );

  /** ↑/↓ walk the file rows in render order — in Tree mode that means the files
   *  currently visible (a collapsed directory hides its children), and directory
   *  headers are stepped over since only a file can be selected. The virtualizer
   *  scrolls the new row in (it may not be mounted yet); focus stays on the list
   *  so no clipped focus ring is painted on the row. */
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const delta = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (delta === 0 || filePaths.length === 0) return;
    event.preventDefault();
    const current = activePath ? filePaths.indexOf(activePath) : -1;
    const next =
      current < 0
        ? filePaths[delta > 0 ? 0 : filePaths.length - 1]
        : filePaths[Math.min(Math.max(current + delta, 0), filePaths.length - 1)];
    if (!next || next === activePath) return;
    onSelect(next);
    const index = rows.findIndex((row) => row.kind === "file" && row.file.path === next);
    if (index >= 0) virtualizer.scrollToIndex(index, { align: "auto" });
  };

  const scrollMargin = virtualizer.options.scrollMargin;
  return (
    <div
      ref={listRef}
      className="relative outline-none"
      style={{ height: virtualizer.getTotalSize() }}
      // WebKit does not focus a <button> on click (unlike the graph's
      // role="button" divs), so without this the arrow keys never reach the
      // handler and the panel just scrolls. -1 keeps it out of the tab order.
      tabIndex={-1}
      // preventScroll: mousedown fires for right-click too, and a plain focus()
      // scrolls the (tall) list into view — yanking the panel under the
      // just-opened context menu. Focus is only for keyboard delivery.
      onMouseDown={() => listRef.current?.focus({ preventScroll: true })}
      onKeyDown={onKeyDown}
    >
      {virtualizer.getVirtualItems().map((item) => {
        const row = rows[item.index];
        if (!row) return null;
        return (
          <div
            key={item.key}
            data-index={item.index}
            // Rows have fixed CSS heights, so the estimate is exact and no
            // per-row measuring is needed (same as HistoryWorkspace).
            className="absolute inset-x-0 top-0"
            style={{ height: item.size, transform: `translateY(${item.start - scrollMargin}px)` }}
          >
            {row.kind === "dir" ? (
              <DirRow
                label={row.label}
                depth={row.depth}
                count={row.count}
                collapsed={row.collapsed}
                menuActive={menuActivePath === row.key}
                onToggle={
                  forceExpanded
                    ? () => {}
                    : () => setCollapsed((c) => ({ ...c, [row.key]: !c[row.key] }))
                }
                onContextMenu={onDirContextMenu ? (e) => onDirContextMenu(row.key, e) : undefined}
                action={dirAction?.(row.paths)}
              />
            ) : isTree ? (
              <TreeFileRow
                file={row.file}
                depth={row.depth}
                active={activePath === row.file.path}
                menuActive={menuActivePath === row.file.path}
                onSelect={() => onSelect(row.file.path)}
                onContextMenu={onContextMenu ? (e) => onContextMenu(row.file.path, e) : undefined}
                action={rowAction?.(row.file)}
                highlight={highlight}
              />
            ) : (
              <FileRow
                file={row.file}
                compact={compact}
                active={activePath === row.file.path}
                menuActive={menuActivePath === row.file.path}
                onClick={() => onSelect(row.file.path)}
                onContextMenu={onContextMenu ? (e) => onContextMenu(row.file.path, e) : undefined}
                action={rowAction?.(row.file)}
                highlight={highlight}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
