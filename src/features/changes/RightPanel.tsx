import { useRepo } from "../../store/repo";
import { useUi } from "../../store/ui";
import { CommitInspector } from "./CommitInspector";
import { MergedSelectionInspector } from "./merged-selection";
import { WorkingInspector } from "./WorkingInspector";

/** Right-hand inspector: working-tree changes while staging/committing, the
 * merged diff for a multi-commit selection, otherwise the selected commit. */
export const RightPanel = () => {
  const wipSelected = useRepo((state) => state.wipSelected);
  const multiSelected = useRepo((state) => state.selectedCommits.length > 1);
  const changesActive = useUi((state) => state.leftTab === "changes");
  const openChangesView = useUi((state) => state.openChangesView);
  return (
    <aside className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-black/5 bg-white shadow-sm dark:border-white/5 dark:bg-neutral-800">
      {changesActive || wipSelected ? (
        <WorkingInspector onOpenChanges={openChangesView} />
      ) : multiSelected ? (
        <MergedSelectionInspector />
      ) : (
        <CommitInspector />
      )}
    </aside>
  );
};
