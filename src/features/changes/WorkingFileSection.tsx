import type { MouseEvent } from "react";
import type { FileChange, WorkingChanges } from "@/lib/api";
import { fileWriteGuard, findGuardedFile } from "@/lib/advancedRepoState";
import { ChangedFileList, type FileListView } from "./file-list";

/** One Staging-area section of the Working Changes inspector (Unstaged or
 * Staged): header with its count and Stage/Unstage all, then the file list with
 * the hover stage/unstage action on every row and Tree-view folder. */
export function FileSection({
  title,
  files,
  totalCount,
  highlight,
  forceExpanded,
  view,
  selectedPath,
  tone,
  allLabel,
  onAll,
  allDisabledReason,
  changes,
  onAction,
  onDirAction,
  onSelect,
  onContextMenu,
  onDirContextMenu,
  menuPath,
}: {
  title: string;
  files: FileChange[];
  /** Unfiltered section size — differs from `files.length` while filtering. */
  totalCount: number;
  highlight?: string;
  forceExpanded?: boolean;
  view: FileListView;
  selectedPath: string | null;
  tone: "stage" | "unstage";
  allLabel: string;
  onAll: () => void;
  allDisabledReason?: string | null;
  changes: WorkingChanges;
  onAction: (path: string) => void;
  /** Stage/unstage every file under a Tree-view directory at once. */
  onDirAction: (paths: string[]) => void;
  onSelect: (path: string) => void;
  onContextMenu: (file: FileChange, e: MouseEvent) => void;
  /** Right-click on a Tree-view directory header (copy the folder's path). */
  onDirContextMenu: (dirPath: string, e: MouseEvent) => void;
  /** Path of the row whose context menu is open (highlighted), or null. */
  menuPath: string | null;
}) {
  // Block a folder roll-up when any file under it is guarded (advanced repo
  // state), mirroring the per-file guard the rows already apply.
  const dirBlocked = (paths: string[]) => {
    const set = new Set(paths);
    return fileWriteGuard(findGuardedFile(files.filter((f) => set.has(f.path)), changes), changes);
  };
  const filtered = files.length !== totalCount;
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between px-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
          {title} ({filtered ? `${files.length} / ${totalCount}` : totalCount})
        </span>
        {/* Hidden while the filter narrows this section — "Stage all" acts on
            every file, including the hidden ones, so offering it then is a trap. */}
        {files.length > 0 && !filtered && (
          <button type="button"
            className="h-7 rounded-lg border border-black/10 px-3 text-[12px] font-medium text-neutral-700 hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-45 dark:border-white/10 dark:text-neutral-200 dark:hover:bg-white/5"
            onClick={allDisabledReason ? undefined : onAll}
            disabled={!!allDisabledReason}
            title={allDisabledReason ?? allLabel}
          >
            {allLabel}
          </button>
        )}
      </div>
      {files.length === 0 ? (
        <div className="px-2 py-1 text-[13px] text-neutral-400">
          {totalCount > 0 ? "No files match the filter." : "No files."}
        </div>
      ) : (
        <ChangedFileList
          files={files}
          view={view}
          compact={false}
          activePath={selectedPath}
          menuActivePath={menuPath}
          onSelect={onSelect}
          onContextMenu={(path, e) => {
            const file = files.find((f) => f.path === path);
            if (file) onContextMenu(file, e);
          }}
          onDirContextMenu={onDirContextMenu}
          rowAction={(file) => ({
            tone,
            onAction: () => onAction(file.path),
            disabledReason: fileWriteGuard(file, changes),
          })}
          dirAction={(paths) => ({
            tone,
            onAction: () => onDirAction(paths),
            disabledReason: dirBlocked(paths),
          })}
          forceExpanded={forceExpanded}
          highlight={highlight}
        />
      )}
    </div>
  );
}
