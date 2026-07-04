import { useEffect, useMemo, useState } from "react";
import { ActionBar } from "./components/chrome/action-bar";
import { Resizer } from "./components/ui/Resizer";
import { ErrorBoundary } from "./components/ui/ErrorBoundary";
import { ErrorFallback } from "./components/ui/ErrorFallback";
import {
  ActionMenu,
  BranchContextMenu,
  CommitContextMenu,
  ConfirmDialog,
  CreateBranchDialog,
  FileContextMenu,
  HandoffDialog,
  PromptDialog,
  StashContextMenu,
  TagContextMenu,
  Toast,
  Tooltip,
  WipContextMenu,
  WorktreeContextMenu,
} from "./components/chrome/overlays";
import { TerminalLayer } from "./features/terminal/TerminalPanel";
import { SettingsModal } from "./components/chrome/SettingsModal";
import { RepoSettingsModal } from "./components/chrome/repo-settings";
import { TitleBar } from "./components/chrome/TitleBar";
import { WindowResizeHandles } from "./components/chrome/WindowResizeHandles";
import { MissingRepoScreen } from "./features/missing-repo";
import { RepoOnboarding } from "./features/onboarding";
import { LeftPanel } from "./features/pull-requests/LeftPanel";
import { CreatePrDialog } from "./features/pull-requests/CreatePrDialog";
import { ChangesWorkspace } from "./features/changes/ChangesWorkspace";
import { ConflictWorkspace, OperationAdvisoryBanner } from "./features/conflicts";
import { HistoryInspectWorkspace } from "./features/history-inspect";
import { HistoryWorkspace } from "./features/graph/HistoryWorkspace";
import { PullRequestDetail } from "./features/pull-requests/PullRequestDetail";
import { ReflogRecoveryDialog } from "./features/recovery";
import { ReviewWorkspace } from "./features/review/ReviewWorkspace";
import { AgentMessageDialog } from "./features/review-notes/ReviewNotes";
import { StackedReview } from "./features/review/StackedReview";
import { CommitModal } from "./features/changes/CommitModal";
import { RightPanel } from "./features/changes/RightPanel";
import { cn } from "./lib/cn";
import { accentVars } from "./lib/accent";
import type { LeftTab } from "./lib/ui";
import { isMac, isTauri } from "./lib/platform";
import { useRepo } from "./store/repo";
import { useUi } from "./store/ui";
import { useAccounts } from "./store/accounts";
import { useUpdates } from "./store/updates";
import { useRepoWatcher } from "./hooks/useRepoWatcher";
import { useResolvedTheme } from "./hooks/useResolvedTheme";
import "./App.css";

const App = () => {
  const summary = useRepo((state) => state.summary);
  const missingRepo = useRepo((state) => state.missingRepo);
  const error = useRepo((state) => state.error);
  const clearError = useRepo((state) => state.clearError);
  const selectedFile = useRepo((state) => state.selectedFile);
  const fileHistory = useRepo((state) => state.fileHistory);
  const compare = useRepo((state) => state.compare);
  const workingTreeClean = useRepo(
    (state) =>
      state.changes.staged.length === 0 &&
      state.changes.unstaged.length === 0 &&
      state.changes.conflicted.length === 0,
  );
  const operation = useRepo((state) => state.operation);
  const operationAdvisory = useRepo((state) => state.operationAdvisory);
  const hasConflictedFiles = useRepo((state) => state.changes.conflicted.length > 0);
  const revealTarget = useRepo((state) => state.revealTarget);
  const restoreSession = useRepo((state) => state.restoreSession);
  const refresh = useRepo((state) => state.refresh);
  const loadAccounts = useAccounts((state) => state.loadAccounts);
  const stackedReview = useUi((state) => state.stackedReview);
  const prSelected = useUi((state) => state.prSelected);
  const changesAll = useUi((state) => state.changesAll);
  const setChangesAll = useUi((state) => state.setChangesAll);
  const theme = useResolvedTheme();
  const accent = useUi((state) => state.accent);
  const accentStyle = useMemo(() => accentVars(accent, theme === "dark"), [accent, theme]);
  const leftWidth = useUi((state) => state.leftWidth);
  const rightWidth = useUi((state) => state.rightWidth);
  const adjustLeftWidth = useUi((state) => state.adjustLeftWidth);
  const adjustRightWidth = useUi((state) => state.adjustRightWidth);
  const closeNav = useUi((state) => state.closeNav);
  const clearReviewNotes = useUi((state) => state.clearReviewNotes);
  const resetHistView = useUi((state) => state.resetHistView);
  const onboardingOpen = useUi((state) => state.onboardingOpen);
  const closeOnboarding = useUi((state) => state.closeOnboarding);
  const [leftTab, setLeftTab] = useState<LeftTab>("history");

  // Reopen the last active repository on launch, and load gh accounts.
  useEffect(() => {
    void loadAccounts();
    void restoreSession();
  }, [loadAccounts, restoreSession]);

  // Quiet update check on launch — populates the version and lights the titlebar
  // indicator if a newer build exists. Honors the About panel's auto-check toggle
  // and runs at most once a day. Silent on "up to date"/errors (e.g. offline); the
  // manual flow in Settings → About surfaces those. Gated on isTauri so `bun run
  // dev` (plain browser) doesn't show a bogus state.
  useEffect(() => {
    if (!isTauri) return;
    void useUpdates.getState().loadVersion();
    const { autoCheckUpdates, lastUpdateCheckAt } = useUi.getState();
    const DAY_MS = 24 * 60 * 60 * 1000;
    if (autoCheckUpdates && Date.now() - lastUpdateCheckAt >= DAY_MS) {
      void useUpdates.getState().check({ quiet: true });
    }
  }, []);

  // Keep the repo in sync with on-disk changes (focus/visibility + the backend
  // `repo-changed` filesystem event, debounced). See useRepoWatcher.
  useRepoWatcher(refresh);

  // Picking a branch in the navigator raises a graph-reveal request. If we're on
  // another page (PRs/changes) surface the graph so HistoryWorkspace can scroll
  // to the branch tip; the workspace itself clears the request once it has.
  useEffect(() => {
    if (revealTarget) setLeftTab("history");
  }, [revealTarget]);

  // The changes view is only reachable by opening a working-tree file, so once
  // the tree goes clean (after a commit, or discarding the last change) there's
  // nothing left to stage or diff — fall back to the graph instead of stranding
  // an empty "Select a file to view its diff" pane.
  useEffect(() => {
    if (leftTab === "changes" && workingTreeClean) setLeftTab("history");
  }, [leftTab, workingTreeClean]);

  // Start each repo in the history view (avoid a stale changes/review pane), drop
  // any review notes pinned against the previous repo's diffs, and reset the
  // history search/filter so one repo's query never lands on another's commits.
  // Keyed on the missing-repo path too (GL-108): switching between two dead
  // tabs changes no summary, but it's still a repo switch for this cleanup.
  useEffect(() => {
    setLeftTab("history");
    setChangesAll(false);
    closeNav();
    clearReviewNotes();
    resetHistView();
    // Any repo switch (incl. dropping to the no-repo start state) dismisses the
    // onboarding overlay so it can't linger over a different repo.
    closeOnboarding();
  }, [summary?.path, missingRepo?.path, setChangesAll, closeNav, clearReviewNotes, resetHistView, closeOnboarding]);

  // An active merge/rebase/cherry-pick/revert takes over the center pane: the
  // repo is in a blocking conflicted state, so the dedicated resolution
  // workspace supersedes the history/changes/PR views (and gates normal
  // commit/stage flows) until the operation is continued or aborted.
  const inConflict = !!operation;
  const showPulls = leftTab === "pulls" && !inConflict;

  const backToGraph = () => setLeftTab("history");

  // Discriminant of which center workspace is showing — used as the boundary's
  // reset key so navigating to a different view (or repo) clears a contained
  // crash without an explicit retry.
  const centerKey = inConflict
    ? "conflict"
    : showPulls
      ? "pulls"
      : compare || fileHistory
        ? "inspect"
        : stackedReview
          ? "stacked"
          : leftTab === "changes"
            ? changesAll
              ? "changes"
              : "review"
            : selectedFile?.source === "commit"
              ? "review-commit"
              : "history";

  const centerInner = inConflict ? (
    <ConflictWorkspace />
  ) : showPulls ? (
    <PullRequestDetail />
  ) : compare || fileHistory ? (
    <HistoryInspectWorkspace />
  ) : stackedReview ? (
    <StackedReview />
  ) : leftTab === "changes" ? (
    changesAll ? (
      <ChangesWorkspace onBack={backToGraph} />
    ) : (
      <ReviewWorkspace onBack={backToGraph} />
    )
  ) : selectedFile?.source === "commit" ? (
    <ReviewWorkspace />
  ) : (
    <HistoryWorkspace />
  );

  // Every center workspace mounts through here, so one boundary contains a
  // render-time crash in any of them (History/Changes/Review/PR/Conflict/…) to
  // the center pane — the toolbar, side panels, and terminal stay interactive.
  // Scope note: this catches *render/commit-time* throws only. An async/IPC
  // failure (e.g. an IpcValidationError from a store action) is caught in the
  // store and surfaced through the global `error` banner above — it never reaches
  // this fallback. So GL-56 (this boundary) and GL-57 (IPC validation) meet only
  // when bad data slips past validation and crashes a render.
  //
  // The reset keys carry both the view *kind* (`centerKey`) and the per-view
  // *content* discriminant, so a crash contained in one PR/file/diff clears when
  // you navigate to another within the same kind — not only on a repo or
  // kind switch. The boundary only acts on these while it's actually errored
  // (componentDidUpdate), so the extra entries are inert in the happy path.
  const center = (
    <ErrorBoundary
      resetKeys={[
        summary?.path,
        centerKey,
        prSelected,
        selectedFile?.path,
        compare?.base,
        compare?.head,
        fileHistory?.path,
        stackedReview?.oid,
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
      {centerInner}
    </ErrorBoundary>
  );

  // `all` picks the stacked multi-file review; otherwise the single-file view
  // (used when focusing one file from the right-panel list).
  const openChanges = (all = false) => {
    setChangesAll(all);
    setLeftTab("changes");
  };

  // The PR view is two-pane (docked list + detail). History/changes have no left
  // panel anymore — the branch navigator floats from the toolbar — so the graph
  // fills the width and keeps the right inspector. The inspector honors the user's
  // manual width on roomy windows, then clamps with the viewport so narrow review
  // layouts stay usable without reserving a hidden blank column.
  const responsiveRightWidth = `clamp(280px, 34vw, ${rightWidth}px)`;
  const gridTemplateColumns = inConflict
    ? "minmax(0,1fr)"
    : showPulls
      ? `${leftWidth}px 6px minmax(0,1fr)`
      : `minmax(0,1fr) 6px ${responsiveRightWidth}`;

  return (
    <div
      className={cn(
        "gp-root flex h-screen min-h-screen flex-col overflow-hidden bg-neutral-100 text-neutral-800 dark:bg-neutral-900 dark:text-neutral-100",
        theme === "dark" && "dark",
      )}
      style={accentStyle}
    >
      <TitleBar />

      {error && (
        <div className="mx-2.5 mb-2.5 flex items-center justify-between gap-3 rounded-xl border border-rose-300 bg-rose-50 px-3.5 py-2 text-sm text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300">
          <span>{error}</span>
          <button
            className="h-7 shrink-0 rounded-lg border border-black/10 px-3 text-[12px] font-medium hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/5"
            onClick={clearError}
          >
            Dismiss
          </button>
        </div>
      )}

      {summary ? (
        <>
          <ActionBar activeTab={leftTab} onTabChange={setLeftTab} />
          <div className="relative flex min-h-0 flex-1 flex-col px-2.5 pb-2.5">
            {operationAdvisory && !inConflict && (
              <OperationAdvisoryBanner advisory={operationAdvisory} hasConflicts={hasConflictedFiles} />
            )}
            <div className="grid min-h-0 flex-1" style={{ gridTemplateColumns }}>
              {inConflict ? (
                center
              ) : showPulls ? (
                <>
                  <LeftPanel />
                  <Resizer onResize={adjustLeftWidth} />
                  {center}
                </>
              ) : (
                <>
                  {center}
                  <Resizer onResize={(dx) => adjustRightWidth(-dx)} />
                  <RightPanel activeTab={leftTab} onOpenChanges={openChanges} />
                </>
              )}
            </div>
            {/* Floating terminal overlay — overlays the grid without resizing it.
                Boundaried so a PTY/render crash drops only the terminal. */}
            <ErrorBoundary
              resetKeys={[summary?.path]}
              fallback={({ reset }) => (
                <ErrorFallback message="The terminal panel hit an error." onRetry={reset} />
              )}
            >
              <TerminalLayer />
            </ErrorBoundary>
          </div>
        </>
      ) : missingRepo ? (
        // A tab whose path no longer resolves (GL-108): the dedicated recovery
        // state replaces the workspace — never a banner over another repo.
        <MissingRepoScreen />
      ) : (
        <RepoOnboarding />
      )}

      {/* Onboarding raised from the tab strip while a repo (or the missing-repo
          state) is showing; the no-repo start state renders it inline instead. */}
      {onboardingOpen && (summary || missingRepo) && <RepoOnboarding onClose={closeOnboarding} />}

      <SettingsModal />
      <RepoSettingsModal />
      <ActionMenu />
      <BranchContextMenu />
      <CommitContextMenu />
      <StashContextMenu />
      <FileContextMenu />
      <WipContextMenu />
      <TagContextMenu />
      <WorktreeContextMenu />
      <CreateBranchDialog />
      <CreatePrDialog />
      <ReflogRecoveryDialog />
      <AgentMessageDialog />
      <CommitModal />
      <ConfirmDialog />
      <PromptDialog />
      <HandoffDialog />
      <Toast />
      <Tooltip />

      {/* Frameless-window edge resize grips (Windows/Linux only, inside Tauri). */}
      {!isMac && isTauri && <WindowResizeHandles />}
    </div>
  );
};

export default App;
