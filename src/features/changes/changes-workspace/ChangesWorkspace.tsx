// The multi-file staging review container (GL-174 folder module): store
// selectors, toolbar layout, and per-row dispatch. Row derivation and the
// per-snapshot diff cache live in useWorkingTreeDiffs; the row rendering in
// ReviewFileSection; the pure policies in changesReviewModel.

import type { MouseEvent } from "react";
import { advancedNotices, fileWriteGuard, findGuardedFile } from "@/lib/advancedRepoState";
import { summarizeChanges } from "@/lib/changeSummary";
import { control } from "@/lib/ui";
import { useRepo } from "@/store/repo";
import { useUi, fileMenuOf, FileMenuKind, MenuKind } from "@/store/ui";
import { AdvancedRepoBanner } from "@/features/advanced-repo/AdvancedRepoBanner";
import { HandToAgentBar } from "@/features/review/comments/HandToAgentBar";
import { ChangeTypeCounts } from "@/features/changes/ChangeTypeCounts";
import { WORK_SURFACES } from "./changesReviewModel";
import { ReviewFileSection } from "./ReviewFileSection";
import { useWorkingTreeDiffs } from "./useWorkingTreeDiffs";
import { ChangeSummaryCard } from "./ChangeSummaryCard";

export function ChangesWorkspace({ onBack }: { onBack: () => void }) {
  const changes = useRepo((state) => state.changes);
  const repoPath = useRepo((state) => state.summary?.path ?? null);
  const selectFile = useRepo((state) => state.selectFile);
  const stageFile = useRepo((state) => state.stageFile);
  const unstageFile = useRepo((state) => state.unstageFile);
  const stageAll = useRepo((state) => state.stageAll);
  const unstageAll = useRepo((state) => state.unstageAll);
  const openUiMenu = useUi((s) => s.openMenu);
  const fileMenu = useUi(fileMenuOf);
  const notices = advancedNotices(changes);
  const stageAllBlocked = fileWriteGuard(findGuardedFile(changes.unstaged, changes), changes);
  const unstageAllBlocked = fileWriteGuard(findGuardedFile(changes.staged, changes), changes);

  const { rows, total, open, setOpen, diffs } = useWorkingTreeDiffs(changes, repoPath);

  // Same shared ADR 0002 menu as WorkingInspector (GL-337): discard bucket
  // matches the row's staged/unstaged source so Ignore/Discard labels stay right.
  const openMenu = (path: string, staged: boolean, e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    openUiMenu({ kind: MenuKind.File, state: { kind: FileMenuKind.Working, x: e.clientX, y: e.clientY, path, discard: { staged } } });
  };
  const menuPathFor = (staged: boolean) =>
    fileMenu?.kind === FileMenuKind.Working && fileMenu.discard.staged === staged
      ? fileMenu.path
      : null;

  return (
    <main className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-black/5 dark:border-white/5 bg-white dark:bg-neutral-800 shadow-sm">
      <div className="flex h-12 flex-none items-center gap-3 border-b border-black/5 dark:border-white/5 px-4">
        <span className="text-[14px] font-semibold text-neutral-800 dark:text-neutral-100">
          Reviewing {total} changed {total === 1 ? "file" : "files"}
        </span>
        <ChangeTypeCounts summary={summarizeChanges(changes)} className="flex-none" />
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-neutral-400">Tick a file to stage it</span>
          <button
            type="button"
            className={`${control} h-8 min-h-0 px-3 text-xs`}
            onClick={stageAllBlocked ? undefined : stageAll}
            disabled={changes.unstaged.length === 0 || !!stageAllBlocked}
            title={stageAllBlocked ?? undefined}
          >
            Stage all
          </button>
          <button
            type="button"
            className={`${control} h-8 min-h-0 px-3 text-xs`}
            onClick={unstageAllBlocked ? undefined : unstageAll}
            disabled={changes.staged.length === 0 || !!unstageAllBlocked}
            title={unstageAllBlocked ?? undefined}
          >
            Unstage all
          </button>
        </div>
        <button
          type="button"
          className="flex flex-none items-center gap-1 h-8 px-2.5 rounded-lg border border-black/10 dark:border-white/10 text-[12px] font-medium text-neutral-600 dark:text-neutral-300 hover:bg-black/5 dark:hover:bg-white/5"
          onClick={onBack}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3 h-3">
            <path d="m15 18-6-6 6-6" />
          </svg>
          Graph
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto bg-white dark:bg-neutral-800">
        <AdvancedRepoBanner notices={notices} />
        {total > 0 && <ChangeSummaryCard />}
        {total === 0 ? (
          <div className="grid h-full place-content-center text-sm text-neutral-400">
            No local changes.
          </div>
        ) : (
          rows.map(({ path, file, source, key }) => {
            const expanded = !!open[path];
            const staged = source === "staged";
            return (
              <ReviewFileSection
                key={path}
                file={file}
                source={source}
                expanded={expanded}
                loading={expanded && diffs[key] === undefined}
                diff={expanded ? diffs[key] ?? null : null}
                changes={changes}
                menuActive={menuPathFor(staged) === path}
                onHeader={() => {
                  const willOpen = !expanded;
                  setOpen((o) => ({ ...o, [path]: willOpen }));
                  // Focus this file in the right panel; its diff loads locally.
                  if (willOpen) selectFile(path, source);
                }}
                onToggle={() => {
                  if (fileWriteGuard(file, changes)) return;
                  if (source === "staged") {
                    unstageFile(path);
                  } else {
                    stageFile(path);
                    // Approving a file collapses it in place (it keeps its slot).
                    setOpen((o) => ({ ...o, [path]: false }));
                  }
                }}
                onContextMenu={(e) => openMenu(path, staged, e)}
              />
            );
          })
        )}
      </div>

      <HandToAgentBar surfaces={WORK_SURFACES} />
    </main>
  );
}
