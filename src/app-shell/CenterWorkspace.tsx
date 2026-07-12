import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { ErrorFallback } from "@/components/ui/ErrorFallback";
import { ChangesWorkspace } from "@/features/changes/changes-workspace";
import { ConflictWorkspace } from "@/features/conflicts";
import { HistoryInspectWorkspace } from "@/features/history-inspect";
import { HistoryWorkspace } from "@/features/graph/HistoryWorkspace";
import { PullRequestDetail } from "@/features/pull-requests/PullRequestDetail";
import { RepoFileWorkspace } from "@/features/repo-files";
import { ReviewWorkspace } from "@/features/review/ReviewWorkspace";
import { StackedReview } from "@/features/review/StackedReview";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { useCenterView } from "./useCenterView";
import type { CenterViewKey } from "./centerView";

/** The center pane: maps the derived view key to its workspace and wraps every
 * one of them in a single error boundary, so a render-time crash in any
 * (History/Changes/Review/PR/Conflict/…) is contained to the center pane — the
 * toolbar, side panels, and terminal stay interactive.
 *
 * Scope note: the boundary catches *render/commit-time* throws only. An
 * async/IPC failure (e.g. an IpcValidationError from a store action) is caught
 * in the store and surfaced through the global error banner — it never reaches
 * this fallback. So GL-56 (this boundary) and GL-57 (IPC validation) meet only
 * when bad data slips past validation and crashes a render.
 *
 * The reset keys carry both the view *kind* (the derived key) and the per-view
 * *content* discriminant, so a crash contained in one PR/file/diff clears when
 * you navigate to another within the same kind — not only on a repo or kind
 * switch. The boundary only acts on these while it's actually errored
 * (componentDidUpdate), so the extra entries are inert in the happy path. */
export const CenterWorkspace = () => {
  const view = useCenterView();
  const summaryPath = useRepo((state) => state.summary?.path);
  const selectedFilePath = useRepo((state) => state.selectedFile?.path);
  const compareBase = useRepo((state) => state.compare?.base);
  const compareHead = useRepo((state) => state.compare?.head);
  const fileHistoryPath = useRepo((state) => state.fileHistory?.path);
  const prSelected = useUi((state) => state.prSelected);
  const stackedOid = useUi((state) => state.stackedReview?.oid);
  const fileViewPath = useRepo((state) => state.fileView?.path);
  // The full route transition, not a bare tab switch: a comparison, file
  // history, stacked review, or committed file's review outranks the tab in
  // deriveCenterView, so escaping a crashed view (or backing out of the
  // changes flow) must clear them — or the boundary's reset keys never change.
  const backToGraph = useRepo((state) => state.returnToGraph);

  return (
    <ErrorBoundary
      resetKeys={[
        summaryPath,
        view,
        prSelected,
        selectedFilePath,
        compareBase,
        compareHead,
        fileHistoryPath,
        stackedOid,
        fileViewPath,
      ]}
      fallback={({ error, reset }) => (
        <ErrorFallback
          message={`Something went wrong in this view.\n${error.message}`}
          onRetry={reset}
          secondary={{ label: "Back to graph", onClick: backToGraph }}
          className="h-full rounded-xl border border-black/5 bg-white shadow-sm dark:border-white/5 dark:bg-neutral-800"
        />
      )}
    >
      {workspaceFor(view, backToGraph)}
    </ErrorBoundary>
  );
};

const workspaceFor = (view: CenterViewKey, backToGraph: () => void) => {
  switch (view) {
    case "conflict":
      return <ConflictWorkspace />;
    case "pulls":
      return <PullRequestDetail />;
    case "inspect":
      return <HistoryInspectWorkspace />;
    case "stacked":
      return <StackedReview />;
    case "file":
      return <RepoFileWorkspace />;
    case "changes":
      return <ChangesWorkspace onBack={backToGraph} />;
    case "review":
      return <ReviewWorkspace onBack={backToGraph} />;
    case "review-commit":
      // No onBack: closing a committed file's review falls back to clearing the
      // selection inside the workspace, not to a tab switch.
      return <ReviewWorkspace />;
    case "history":
      return <HistoryWorkspace />;
  }
};
