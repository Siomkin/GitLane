import { useRepo } from "@/store/repo";
import { advancedNotices } from "@/lib/advancedRepoState";
import { AdvancedRepoBanner } from "@/features/advanced-repo/AdvancedRepoBanner";
import { InspectHeader } from "./InspectHeader";
import { FileHistoryView } from "./file-history";
import { BlameView } from "./BlameView";
import { CompareView } from "./CompareView";

const blameRevision = (oid: string, path: string) => {
  useRepo.getState().setFileHistoryMode("blame", oid, path);
};

/** The history-inspection surface: one card that hosts file history, blame, and
 * compare modes behind a shared breadcrumb header. Mounted by `App` whenever a
 * `compare` or `fileHistory` state is active (compare wins if both somehow set). */
export function HistoryInspectWorkspace() {
  const compare = useRepo((s) => s.compare);
  const history = useRepo((s) => s.fileHistory);
  const changes = useRepo((s) => s.changes);
  const closeCompare = useRepo((s) => s.closeCompare);
  const closeFileHistory = useRepo((s) => s.closeFileHistory);
  const setFileHistoryMode = useRepo((s) => s.setFileHistoryMode);
  const notices = advancedNotices(changes);

  if (!compare && !history) return null;

  return (
    <main className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-black/5 bg-white shadow-sm dark:border-white/5 dark:bg-neutral-800">
      {compare ? (
        <>
          <InspectHeader mode="compare" title="Compare" onBack={closeCompare} />
          <AdvancedRepoBanner notices={notices} />
          <CompareView />
        </>
      ) : history ? (
        <>
          <InspectHeader
            mode={history.mode}
            title={history.mode === "blame" ? "Blame" : "File history"}
            path={history.path}
            onBack={closeFileHistory}
            onCopyPath={() => void navigator.clipboard?.writeText(history.path)}
            onHistory={() => setFileHistoryMode("history")}
            onBlame={() => setFileHistoryMode("blame")}
          />
          <AdvancedRepoBanner notices={notices} />
          {history.mode === "blame" ? <BlameView /> : <FileHistoryView onBlameRevision={blameRevision} />}
        </>
      ) : null}
    </main>
  );
}
