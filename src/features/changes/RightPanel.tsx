import type { LeftTab } from "../../lib/ui";
import { useRepo } from "../../store/repo";
import { CommitInspector } from "./CommitInspector";
import { WorkingInspector } from "./WorkingInspector";

/** Right-hand inspector: shows working-tree changes while staging/committing,
 * otherwise the metadata for the selected commit. */
export function RightPanel({
  activeTab,
  onOpenChanges,
}: {
  activeTab: LeftTab;
  onOpenChanges: (all?: boolean) => void;
}) {
  const wipSelected = useRepo((state) => state.wipSelected);
  return (
    <aside className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-black/5 bg-white shadow-sm dark:border-white/5 dark:bg-neutral-800 max-[1150px]:hidden">
      {activeTab === "changes" || wipSelected ? (
        <WorkingInspector onOpenChanges={onOpenChanges} />
      ) : (
        <CommitInspector />
      )}
    </aside>
  );
}
