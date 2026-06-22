import { useEffect, type MouseEvent } from "react";
import type { FileChange } from "../../lib/api";
import { cn } from "../../lib/cn";
import { useRepo } from "../../store/repo";
import { useUi } from "../../store/ui";
import { FileRow } from "./FileRow";

/** Inspector for working changes — lists unstaged/staged files with inline
 * stage/unstage actions and the Start-commit button that raises the modal. */
export function WorkingInspector({ onOpenChanges }: { onOpenChanges: (all?: boolean) => void }) {
  const changes = useRepo((state) => state.changes);
  const selectedFile = useRepo((state) => state.selectedFile);
  const selectFile = useRepo((state) => state.selectFile);
  const stageFile = useRepo((state) => state.stageFile);
  const unstageFile = useRepo((state) => state.unstageFile);
  const stageAll = useRepo((state) => state.stageAll);
  const unstageAll = useRepo((state) => state.unstageAll);
  const summary = useRepo((state) => state.summary);
  const openCommit = useUi((state) => state.openCommit);
  const openFileMenu = useUi((state) => state.openFileMenu);
  const fileMenu = useUi((state) => state.fileMenu);
  const total = changes.staged.length + changes.unstaged.length;
  const selectedPath = selectedFile?.source === "commit" ? null : selectedFile?.path ?? null;

  const openMenu = (file: FileChange, staged: boolean, e: MouseEvent) => {
    e.preventDefault();
    // A rename's FileChange carries only the new path, so the backend can't
    // restore the old side — offer a copy-only menu (no discard) rather than
    // half-undo the rename.
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

        <FileSection
          title="Unstaged"
          files={changes.unstaged}
          selectedPath={selectedPath}
          tone="stage"
          allLabel="Stage all"
          onAll={stageAll}
          onAction={stageFile}
          onSelect={(p) => openFile(p, "unstaged")}
          onContextMenu={(f, e) => openMenu(f, false, e)}
          menuPath={menuPathFor(false)}
        />
        <FileSection
          title="Staged"
          files={changes.staged}
          selectedPath={selectedPath}
          tone="unstage"
          allLabel="Unstage all"
          onAll={unstageAll}
          onAction={unstageFile}
          onSelect={(p) => openFile(p, "staged")}
          onContextMenu={(f, e) => openMenu(f, true, e)}
          menuPath={menuPathFor(true)}
        />
      </div>

      <div className="shrink-0 border-t border-black/5 p-4 dark:border-white/5">
        <button
          className={cn(
            "h-10 w-full rounded-lg text-[13px] font-medium",
            changes.staged.length > 0
              ? "bg-[var(--accent)] text-white hover:brightness-110"
              : "cursor-not-allowed bg-black/[0.06] text-neutral-400 dark:bg-white/10",
          )}
          disabled={changes.staged.length === 0}
          onClick={openCommit}
        >
          Start commit
        </button>
      </div>
    </div>
  );
}

function FileSection({
  title,
  files,
  selectedPath,
  tone,
  allLabel,
  onAll,
  onAction,
  onSelect,
  onContextMenu,
  menuPath,
}: {
  title: string;
  files: FileChange[];
  selectedPath: string | null;
  tone: "stage" | "unstage";
  allLabel: string;
  onAll: () => void;
  onAction: (path: string) => void;
  onSelect: (path: string) => void;
  onContextMenu: (file: FileChange, e: MouseEvent) => void;
  /** Path of the row whose context menu is open (highlighted), or null. */
  menuPath: string | null;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
          {title} ({files.length})
        </span>
        {files.length > 0 && (
          <button
            className="h-7 rounded-lg border border-black/10 px-3 text-[12px] font-medium text-neutral-700 hover:bg-black/5 dark:border-white/10 dark:text-neutral-200 dark:hover:bg-white/5"
            onClick={onAll}
          >
            {allLabel}
          </button>
        )}
      </div>
      {files.length === 0 ? (
        <div className="px-1 py-1 text-[13px] text-neutral-400">No files.</div>
      ) : (
        <div className="space-y-0.5">
          {files.map((file) => (
            <FileRow
              key={file.path}
              file={file}
              active={selectedPath === file.path}
              menuActive={menuPath === file.path}
              onClick={() => onSelect(file.path)}
              onContextMenu={(e) => onContextMenu(file, e)}
              action={{ tone, onAction: () => onAction(file.path) }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
