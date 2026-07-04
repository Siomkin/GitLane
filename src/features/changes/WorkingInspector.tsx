import { useEffect, useState, type MouseEvent } from "react";
import type { FileChange, WorkingChanges } from "../../lib/api";
import {
  advancedNotices,
  fileWriteGuard,
  findGuardedFile,
} from "../../lib/advancedRepoState";
import { cn } from "../../lib/cn";
import { summarizeChanges } from "../../lib/changeSummary";
import { useRepo } from "../../store/repo";
import { useUi } from "../../store/ui";
import { AdvancedRepoBanner } from "../advanced-repo/AdvancedRepoBanner";
import { ChangeTypeCounts } from "./ChangeTypeCounts";
import { ChangedFileList, FileViewToggle, type FileListView } from "./file-list";

/** Inspector for working changes — lists unstaged/staged files with inline
 * stage/unstage actions and the Start-commit button that raises the modal. */
export function WorkingInspector({ onOpenChanges }: { onOpenChanges: (all?: boolean) => void }) {
  const changes = useRepo((state) => state.changes);
  const selectedFile = useRepo((state) => state.selectedFile);
  const selectFile = useRepo((state) => state.selectFile);
  const stageFile = useRepo((state) => state.stageFile);
  const unstageFile = useRepo((state) => state.unstageFile);
  const stagePaths = useRepo((state) => state.stagePaths);
  const unstagePaths = useRepo((state) => state.unstagePaths);
  const stageAll = useRepo((state) => state.stageAll);
  const unstageAll = useRepo((state) => state.unstageAll);
  const summary = useRepo((state) => state.summary);
  const [view, setView] = useState<FileListView>("path");
  const openCommit = useUi((state) => state.openCommit);
  const openFileMenu = useUi((state) => state.openFileMenu);
  const fileMenu = useUi((state) => state.fileMenu);
  const total = changes.staged.length + changes.unstaged.length;
  const notices = advancedNotices(changes);
  const unstagedGuarded = findGuardedFile(changes.unstaged, changes);
  const stagedGuarded = findGuardedFile(changes.staged, changes);
  const stageAllBlocked = fileWriteGuard(unstagedGuarded, changes);
  const unstageAllBlocked = fileWriteGuard(stagedGuarded, changes);
  const commitBlocked = fileWriteGuard(stagedGuarded, changes);
  // Unmerged paths whose owning operation isn't currently driving the conflict
  // workspace (e.g. `git am`/`bisect`, or a transient detection failure). Shown
  // read-only here so they never vanish from the UI — resolution still happens
  // in the conflict view (or the terminal).
  const conflicted = changes.conflicted ?? [];
  const selectedPath = selectedFile?.source === "commit" ? null : selectedFile?.path ?? null;

  const openMenu = (file: FileChange, staged: boolean, e: MouseEvent) => {
    e.preventDefault();
    // Stage/unstage a rename now moves both sides (GL-127), but discard is still
    // single-path (it can't restore the old side of a rename), so offer a
    // copy-only menu (no discard) rather than half-undo the rename.
    const discard = file.status === "R" ? undefined : { staged };
    openFileMenu({ x: e.clientX, y: e.clientY, path: file.path, discard });
  };

  // The open menu's target path, but only for the matching section — so a file
  // staged *and* unstaged at once highlights just the row that was clicked.
  const menuPathFor = (staged: boolean) =>
    fileMenu?.discard?.staged === staged ? fileMenu.path : null;

  // Keep a working file selected so the center pane shows its single-file review.
  useEffect(() => {
    const all = [...changes.unstaged, ...changes.staged];
    if (all.length === 0) return;
    const stillValid =
      selectedFile?.source !== "commit" && all.some((f) => f.path === selectedFile?.path);
    if (!stillValid) {
      const first = changes.unstaged[0] ?? changes.staged[0];
      void selectFile(first.path, changes.unstaged[0] ? "unstaged" : "staged");
    }
  }, [changes, selectedFile?.path, selectedFile?.source, selectFile]);

  const openFile = (path: string, source: "unstaged" | "staged") => {
    void selectFile(path, source);
    onOpenChanges();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-5">
        <div className="flex items-center justify-between gap-2">
          <h1 className="min-w-0 truncate text-[16px] font-semibold text-neutral-800 dark:text-neutral-100">
            <span>{total} change{total === 1 ? "" : "s"} on </span>
            <span className="text-[color:var(--accent)]">{summary?.headBranch ?? "HEAD"}</span>
          </h1>
          {total > 0 && (
            <button
              className="shrink-0 text-xs font-medium text-[color:var(--accent)] hover:underline"
              onClick={() => onOpenChanges(true)}
            >
              review all →
            </button>
          )}
        </div>

        {/* Show the toggle whenever any list is populated — including a
            conflict-only tree mid-merge (conflicts are excluded from `total`,
            but the conflicts list below still honours the Path/Tree view). */}
        {(total > 0 || conflicted.length > 0) && (
          <div className="flex items-center justify-between">
            <ChangeTypeCounts summary={summarizeChanges(changes)} />
            <FileViewToggle view={view} onChange={setView} />
          </div>
        )}

        {conflicted.length > 0 && (
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400">
                Conflicts ({conflicted.length})
              </span>
            </div>
            <div className="mb-1.5 px-1 text-[12px] text-neutral-400">
              Unresolved paths git still considers conflicted. Resolve them in the conflict view or your terminal.
            </div>
            {/* Read-only (no stage/unstage) but honours the Path/Tree toggle so
                the layout stays consistent with the sections below. */}
            <ChangedFileList
              files={conflicted}
              view={view}
              compact={false}
              activePath={null}
              onSelect={() => {}}
            />
          </div>
        )}

        <AdvancedRepoBanner notices={notices} variant="card" />

        <FileSection
          title="Unstaged"
          files={changes.unstaged}
          view={view}
          selectedPath={selectedPath}
          tone="stage"
          allLabel="Stage all"
          onAll={stageAll}
          allDisabledReason={stageAllBlocked}
          changes={changes}
          onAction={stageFile}
          onDirAction={stagePaths}
          onSelect={(p) => openFile(p, "unstaged")}
          onContextMenu={(f, e) => openMenu(f, false, e)}
          menuPath={menuPathFor(false)}
        />
        <FileSection
          title="Staged"
          files={changes.staged}
          view={view}
          selectedPath={selectedPath}
          tone="unstage"
          allLabel="Unstage all"
          onAll={unstageAll}
          allDisabledReason={unstageAllBlocked}
          changes={changes}
          onAction={unstageFile}
          onDirAction={unstagePaths}
          onSelect={(p) => openFile(p, "staged")}
          onContextMenu={(f, e) => openMenu(f, true, e)}
          menuPath={menuPathFor(true)}
        />
      </div>

      <div className="shrink-0 border-t border-black/5 p-4 dark:border-white/5">
        <button
          className={cn(
            "h-10 w-full rounded-lg text-[13px] font-medium",
            changes.staged.length > 0 && !commitBlocked
              ? "bg-[var(--accent)] text-white hover:brightness-110"
              : "cursor-not-allowed bg-black/[0.06] text-neutral-400 dark:bg-white/10",
          )}
          disabled={changes.staged.length === 0 || !!commitBlocked}
          title={commitBlocked ?? undefined}
          onClick={openCommit}
        >
          {commitBlocked ? "Commit blocked" : "Start commit"}
        </button>
        {commitBlocked && (
          <p className="mt-2 text-[11.5px] leading-4 text-amber-600 dark:text-amber-400">
            {commitBlocked}
          </p>
        )}
      </div>
    </div>
  );
}

function FileSection({
  title,
  files,
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
  menuPath,
}: {
  title: string;
  files: FileChange[];
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
  /** Path of the row whose context menu is open (highlighted), or null. */
  menuPath: string | null;
}) {
  // Block a folder roll-up when any file under it is guarded (advanced repo
  // state), mirroring the per-file guard the rows already apply.
  const dirBlocked = (paths: string[]) => {
    const set = new Set(paths);
    return fileWriteGuard(findGuardedFile(files.filter((f) => set.has(f.path)), changes), changes);
  };
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
          {title} ({files.length})
        </span>
        {files.length > 0 && (
          <button
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
        <div className="px-1 py-1 text-[13px] text-neutral-400">No files.</div>
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
        />
      )}
    </div>
  );
}
