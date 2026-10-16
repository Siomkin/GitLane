import { useMemo, type MouseEvent } from "react";
import type { WorkingChanges } from "@/lib/api";
import { fileWriteGuard, findGuardedFile } from "@/lib/advancedRepoState";
import { useRepo } from "@/store/repo";
import { TriStateCheckbox } from "@/components/ui/TriStateCheckbox";
import { ChangedFileList, filterFilesByName, type FileListView } from "./file-list";
import { includeRows, includeTarget, rollupState, rowFiles } from "./includeList";

/** The Include view's single list: every changed path once, with a three-state
 * checkbox that stages or unstages the whole file (or folder). Uses the folder
 * actions even for one file so ticking a row never moves the open diff. */
export function IncludeFileSection({
  changes,
  query,
  forceExpanded,
  view,
  selectedPath,
  menuPath,
  onSelect,
  onContextMenu,
  onDirContextMenu,
}: {
  changes: WorkingChanges;
  query?: string;
  forceExpanded?: boolean;
  view: FileListView;
  selectedPath: string | null;
  /** Path of the row whose context menu is open, or null. */
  menuPath: string | null;
  onSelect: (path: string, source: "unstaged" | "staged") => void;
  onContextMenu: (path: string, staged: boolean, e: MouseEvent) => void;
  onDirContextMenu: (dirPath: string, e: MouseEvent) => void;
}) {
  const stagePaths = useRepo((state) => state.stagePaths);
  const unstagePaths = useRepo((state) => state.unstagePaths);
  const rows = useMemo(() => includeRows(changes), [changes]);
  const byPath = useMemo(() => new Map(rows.map((r) => [r.path, r])), [rows]);
  const files = filterFilesByName(rowFiles(rows), query ?? "");
  const filtered = files.length !== rows.length;

  const toggle = (paths: string[]) => {
    const target = includeTarget(rows, paths);
    if (target.paths.length === 0) return;
    void (target.action === "stage" ? stagePaths : unstagePaths)(target.paths);
  };
  const guardFor = (paths: string[]) => {
    const set = new Set(paths);
    const picked = [...changes.unstaged, ...changes.staged].filter((f) => set.has(f.path));
    return fileWriteGuard(findGuardedFile(picked, changes), changes);
  };
  const allPaths = rows.map((r) => r.path);

  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2 px-2">
        {rows.length > 0 && !filtered && (
          <TriStateCheckbox
            checked={rollupState(rows, allPaths)}
            label={rollupState(rows, allPaths) === true ? "Exclude all" : "Include all"}
            onChange={() => toggle(allPaths)}
            disabledReason={guardFor(allPaths)}
          />
        )}
        <span className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
          Changes ({filtered ? `${files.length} / ${rows.length}` : rows.length})
        </span>
      </div>
      {files.length === 0 ? (
        <div className="px-2 py-1 text-[13px] text-neutral-400">
          {rows.length > 0 ? "No files match the filter." : "No files."}
        </div>
      ) : (
        <ChangedFileList
          files={files}
          view={view}
          compact={false}
          activePath={selectedPath}
          menuActivePath={menuPath}
          onSelect={(path) => onSelect(path, byPath.get(path)?.source === "staged" ? "staged" : "unstaged")}
          onContextMenu={(path, e) => onContextMenu(path, byPath.get(path)?.source === "staged", e)}
          onDirContextMenu={onDirContextMenu}
          rowAction={(file) => {
            const checked = byPath.get(file.path)?.checked ?? false;
            return {
              tone: checked === true ? "unstage" : "stage",
              checked,
              onAction: () => toggle([file.path]),
              disabledReason: guardFor([file.path]),
            };
          }}
          dirAction={(paths) => {
            const checked = rollupState(rows, paths);
            return {
              tone: checked === true ? "unstage" : "stage",
              checked,
              onAction: () => toggle(paths),
              disabledReason: guardFor(paths),
            };
          }}
          forceExpanded={forceExpanded}
          highlight={query}
        />
      )}
    </div>
  );
}
