import { useRepo } from "../../store/repo";
import { InspectHeader } from "./InspectHeader";
import { FileHistoryView } from "./FileHistoryView";
import { BlameView } from "./BlameView";
import { CompareView } from "./CompareView";

/** The history-inspection surface: one card that hosts file history, blame, and
 * compare modes behind a shared breadcrumb header. Mounted by `App` whenever a
 * `compare` or `fileHistory` state is active (compare wins if both somehow set). */
export function HistoryInspectWorkspace() {
  const compare = useRepo((s) => s.compare);
  const history = useRepo((s) => s.fileHistory);
  const closeCompare = useRepo((s) => s.closeCompare);
  const closeFileHistory = useRepo((s) => s.closeFileHistory);

  if (!compare && !history) return null;

  // ---- mode-switching for the file modes (history <-> blame) ----
  const goHistory = () =>
    useRepo.setState((s) => (s.fileHistory ? { fileHistory: { ...s.fileHistory, mode: "history" } } : {}));
  const goBlame = () => {
    const fh = useRepo.getState().fileHistory;
    if (!fh) return;
    useRepo.setState({ fileHistory: { ...fh, mode: "blame" } });
    if (!fh.blame && !fh.blameLoading) void useRepo.getState().loadFileBlame(fh.selectedOid);
  };
  const blameRevision = (oid: string) => {
    const fh = useRepo.getState().fileHistory;
    if (!fh) return;
    useRepo.setState({ fileHistory: { ...fh, mode: "blame" } });
    void useRepo.getState().loadFileBlame(oid);
  };

  return (
    <main className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-black/5 bg-white shadow-sm dark:border-white/5 dark:bg-neutral-800">
      {compare ? (
        <>
          <InspectHeader mode="compare" title="Compare" onBack={closeCompare} />
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
          {history.mode === "blame" ? <BlameView /> : <FileHistoryView onBlameRevision={blameRevision} />}
        </>
      ) : null}
    </main>
  );
}
