import { useRepo } from "../../store/repo";
import { advancedNotices } from "../../lib/advancedRepoState";
import { AdvancedRepoBanner } from "../advanced-repo/AdvancedRepoBanner";
import { InspectHeader } from "./InspectHeader";
import { FileHistoryView } from "./file-history";
import { BlameView } from "./BlameView";
import { CompareView } from "./CompareView";

/** The history-inspection surface: one card that hosts file history, blame, and
 * compare modes behind a shared breadcrumb header. Mounted by `App` whenever a
 * `compare` or `fileHistory` state is active (compare wins if both somehow set). */
export function HistoryInspectWorkspace() {
  const compare = useRepo((s) => s.compare);
  const history = useRepo((s) => s.fileHistory);
  const changes = useRepo((s) => s.changes);
  const closeCompare = useRepo((s) => s.closeCompare);
  const closeFileHistory = useRepo((s) => s.closeFileHistory);
  const notices = advancedNotices(changes);

  if (!compare && !history) return null;

  // ---- mode-switching for the file modes (history <-> blame) ----
  const goHistory = () =>
    useRepo.setState((s) => (s.fileHistory ? { fileHistory: { ...s.fileHistory, mode: "history" } } : {}));
  const goBlame = () => {
    const fh = useRepo.getState().fileHistory;
    if (!fh) return;
    useRepo.setState({ fileHistory: { ...fh, mode: "blame" } });
    // Reload when the loaded blame doesn't match the currently selected revision
    // (e.g. a different revision was picked in History since blame last loaded).
    if (!fh.blameLoading && fh.blameRevision !== fh.selectedOid) {
      void useRepo.getState().loadFileBlame(fh.selectedOid, fh.selectedPath);
    }
  };
  const blameRevision = (oid: string, path: string) => {
    const fh = useRepo.getState().fileHistory;
    if (!fh) return;
    useRepo.setState({ fileHistory: { ...fh, mode: "blame" } });
    void useRepo.getState().loadFileBlame(oid, path);
  };

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
            onHistory={goHistory}
            onBlame={goBlame}
          />
          <AdvancedRepoBanner notices={notices} />
          {history.mode === "blame" ? <BlameView /> : <FileHistoryView onBlameRevision={blameRevision} />}
        </>
      ) : null}
    </main>
  );
}
