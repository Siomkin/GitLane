import type { LeftTab } from "../../lib/ui";
import { useRepo } from "../../store/repo";
import { CommitInspector } from "./CommitInspector";
import { MergedSelectionInspector } from "./merged-selection";
import { WorkingInspector } from "./WorkingInspector";

/** Right-hand inspector: working-tree changes while staging/committing, the
 * merged diff for a multi-commit selection, otherwise the selected commit. */
export const RightPanel = ({
  activeTab,
  onOpenChanges,
}: {
  activeTab: LeftTab;
  onOpenChanges: (all?: boolean) => void;
}) => {
  const wipSelected = useRepo((state) => state.wipSelected);
  const multiSelected = useRepo((state) => state.selectedCommits.length > 1);
  return (
    <aside className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-black/5 bg-white shadow-sm dark:border-white/5 dark:bg-neutral-800">
      {activeTab === "changes" || wipSelected ? (
        <WorkingInspector onOpenChanges={onOpenChanges} />
      ) : multiSelected ? (
        <MergedSelectionInspector />
      ) : (
        <CommitInspector />
      )}
    </aside>
  );
};
