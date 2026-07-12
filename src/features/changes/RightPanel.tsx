import { cn } from "../../lib/cn";
import { useRepo } from "../../store/repo";
import { useUi } from "../../store/ui";
import { FilesPanel } from "../repo-files";
import { CommitCheckoutBar } from "./CommitCheckoutBar";
import { CommitInspector } from "./CommitInspector";
import { MergedSelectionInspector } from "./merged-selection";
import { WorkingInspector } from "./WorkingInspector";

const tabBtn = (active: boolean) =>
  cn(
    "px-2.5 h-6 rounded-md text-[12px]",
    active
      ? "bg-white dark:bg-neutral-700 shadow-sm font-medium text-neutral-800 dark:text-neutral-100"
      : "text-neutral-500 dark:text-neutral-400",
  );

/** Right-hand panel. A single header line (same height as the left graph
 * toolbar) carries the selected commit's identity + Checkout on the left and the
 * Details/Files toggle on the right. Below it the Details tab is the contextual
 * inspector (working changes, a multi-commit merged diff, or the selected
 * commit) and the Files tab browses the repository's files. */
export const RightPanel = () => {
  const wipSelected = useRepo((state) => state.wipSelected);
  const multiSelected = useRepo((state) => state.selectedCommits.length > 1);
  const changesActive = useUi((state) => state.leftTab === "changes");
  const openChangesView = useUi((state) => state.openChangesView);
  const rightTab = useUi((state) => state.rightTab);
  const setRightTab = useUi((state) => state.setRightTab);
  // The commit identity/Checkout bar belongs to the commit-details case only —
  // not the working-changes, multi-select, or Files views.
  const showCommitBar =
    rightTab === "details" && !changesActive && !wipSelected && !multiSelected;
  return (
    <aside className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-black/5 bg-white shadow-sm dark:border-white/5 dark:bg-neutral-800">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-black/5 px-3 dark:border-white/5">
        <div className="flex min-w-0 flex-1 items-center">{showCommitBar && <CommitCheckoutBar />}</div>
        <div
          role="group"
          aria-label="Right panel view"
          className="flex shrink-0 rounded-lg bg-black/[0.06] p-0.5 dark:bg-white/[0.06]"
        >
          <button
            type="button"
            aria-pressed={rightTab === "details"}
            className={tabBtn(rightTab === "details")}
            onClick={() => setRightTab("details")}
          >
            Details
          </button>
          <button
            type="button"
            aria-pressed={rightTab === "files"}
            className={tabBtn(rightTab === "files")}
            onClick={() => setRightTab("files")}
          >
            Files
          </button>
        </div>
      </div>
      {rightTab === "files" ? (
        <FilesPanel />
      ) : changesActive || wipSelected ? (
        <WorkingInspector onOpenChanges={openChangesView} />
      ) : multiSelected ? (
        <MergedSelectionInspector />
      ) : (
        <CommitInspector />
      )}
    </aside>
  );
};
