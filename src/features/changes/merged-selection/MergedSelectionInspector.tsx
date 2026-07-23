import { type MouseEvent } from "react";
import { summarizeFiles } from "@/lib/changeSummary";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { ChangeTypeCounts } from "@/features/changes/ChangeTypeCounts";
import { canRestoreCommittedFile } from "@/features/changes/committedFileMenu";
import { ChangedFileList, FileViewToggle } from "@/features/changes/file-list";
import { SelectionCommitList } from "./SelectionCommitList";
import { mergedCommitRows, selectionCountLabel } from "./mergedSelection";

/** Inspector shown when more than one commit is selected (GL-68/GL-69): the
 * merged ("union") diff across the whole selection — the selected-commit list
 * plus the net change per file across every selected commit. Works for any
 * selection (contiguous or not); the backend `selection_diff` composes it. */
export function MergedSelectionInspector() {
  const graph = useRepo((s) => s.graph);
  const selectedCommits = useRepo((s) => s.selectedCommits);
  const selectionDiff = useRepo((s) => s.selectionDiff);
  const selectedFile = useRepo((s) => s.selectedFile);
  const selectFile = useRepo((s) => s.selectFile);
  const openSelectionReview = useUi((s) => s.openSelectionReview);
  const openFileMenu = useUi((s) => s.openFileMenu);
  const commitPathIsRestorable = useRepo((s) => s.commitPathIsRestorable);
  const view = useUi((s) => s.fileListView);
  const setView = useUi((s) => s.setFileListView);

  const count = selectedCommits.length;
  const rows = mergedCommitRows(graph, selectionDiff?.commits ?? selectedCommits);
  const files = selectionDiff?.files ?? [];
  const loading = selectionDiff?.loading ?? false;
  const error = selectionDiff?.error ?? null;
  const activePath = selectedFile?.source === "commit" ? selectedFile.path : null;

  const reviewAll = () => {
    const label = `Reviewing ${files.length} file${files.length === 1 ? "" : "s"} · ${count} commits`;
    openSelectionReview(selectionDiff?.commits ?? selectedCommits, label);
  };
  // Committed files (ADR 0003): Restore from the newest selected commit still
  // in the loaded graph (selection tip). Multi-commit unions have no per-file
  // owning commit in the list, so this is intentional — not a range restore.
  const restoreOid = rows[0]?.id;
  const onContextMenu = async (path: string, e: MouseEvent) => {
    e.preventDefault();
    // Read coordinates before the await — React reuses the synthetic event.
    const { clientX: x, clientY: y } = e;
    const file = files.find((entry) => entry.path === path);
    // The union list can surface a path the selection tip doesn't own (a
    // non-contiguous selection where a newer, unselected commit deleted it), so
    // probe the tip per file and only offer Restore when the blob is really
    // there — rather than offering it and erroring on click.
    const canRestore =
      !!restoreOid &&
      canRestoreCommittedFile(file, restoreOid) &&
      (await commitPathIsRestorable(restoreOid, path).catch(() => false));
    openFileMenu({
      x,
      y,
      path,
      ...(canRestore && restoreOid ? { restore: { commitOid: restoreOid } } : {}),
    });
  };
  const onDirContextMenu = (dirPath: string, e: MouseEvent) => {
    e.preventDefault();
    openFileMenu({ x: e.clientX, y: e.clientY, path: dirPath, dir: true });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-5 pb-5 pt-1.5">
      <div>
        <h1 className="text-[17px] font-semibold text-neutral-800 dark:text-neutral-100">
          {selectionCountLabel(count)}
        </h1>
        <p className="mt-0.5 text-xs text-neutral-400">
          Viewing merged diff of {count} commits
          {/* The list can only show commits in the loaded graph window; note any
              selected commit that isn't, so the count never silently disagrees. */}
          {rows.length < count ? ` · ${count - rows.length} not shown` : ""}
        </p>
      </div>

      <SelectionCommitList rows={rows} />

      <div className="h-px bg-black/5 dark:bg-white/5" />

      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
          Changed files{files.length > 0 ? ` (${files.length})` : ""}
        </span>
        {files.length > 0 && (
          <button type="button"
            className="text-xs font-medium text-[color:var(--accent)] hover:underline"
            onClick={reviewAll}
          >
            review all →
          </button>
        )}
      </div>

      {files.length > 0 && (
        <div className="flex items-center justify-between">
          <ChangeTypeCounts summary={summarizeFiles(files)} />
          <FileViewToggle view={view} onChange={setView} />
        </div>
      )}

      {error ? (
        <p className="px-1 text-[13px] text-rose-500">{error}</p>
      ) : loading ? (
        <p className="px-1 text-[13px] text-neutral-400">Loading merged diff…</p>
      ) : files.length === 0 ? (
        <p className="px-1 text-[13px] text-neutral-400">No file changes across the selection.</p>
      ) : (
        <ChangedFileList
          files={files}
          view={view}
          activePath={activePath}
          onSelect={(path) => selectFile(path, "commit")}
          onContextMenu={onContextMenu}
          onDirContextMenu={onDirContextMenu}
        />
      )}
    </div>
  );
}
