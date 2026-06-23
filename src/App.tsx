import { useEffect, useMemo, useState } from "react";
import { ActionBar } from "./components/chrome/ActionBar";
import { Resizer } from "./components/ui/Resizer";
import {
  ActionMenu,
  BranchContextMenu,
  CommitContextMenu,
  ConfirmDialog,
  CreateBranchDialog,
  FileContextMenu,
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
import { TitleBar } from "./components/chrome/TitleBar";
import { WindowResizeHandles } from "./components/chrome/WindowResizeHandles";
import { WelcomeScreen } from "./components/chrome/WelcomeScreen";
import { LeftPanel } from "./features/pull-requests/LeftPanel";
import { CreatePrDialog } from "./features/pull-requests/CreatePrDialog";
import { ChangesWorkspace } from "./features/changes/ChangesWorkspace";
import { HistoryWorkspace } from "./features/graph/HistoryWorkspace";
import { PullRequestDetail } from "./features/pull-requests/PullRequestDetail";
import { ReviewWorkspace } from "./features/review/ReviewWorkspace";
import { AgentMessageDialog, ReviewNotesTray } from "./features/review-notes/ReviewNotes";
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
import { useRepoWatcher } from "./hooks/useRepoWatcher";
import { useResolvedTheme } from "./hooks/useResolvedTheme";
import "./App.css";

function App() {
  const summary = useRepo((state) => state.summary);
  const error = useRepo((state) => state.error);
  const clearError = useRepo((state) => state.clearError);
  const pickAndOpen = useRepo((state) => state.pickAndOpen);
  const selectedFile = useRepo((state) => state.selectedFile);
  const revealTarget = useRepo((state) => state.revealTarget);
  const restoreSession = useRepo((state) => state.restoreSession);
  const refresh = useRepo((state) => state.refresh);
  const loadAccounts = useAccounts((state) => state.loadAccounts);
  const stackedReview = useUi((state) => state.stackedReview);
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
  const [leftTab, setLeftTab] = useState<LeftTab>("history");

  // Reopen the last active repository on launch, and load gh accounts.
  useEffect(() => {
    void loadAccounts();
    void restoreSession();
  }, [loadAccounts, restoreSession]);

  // Keep the repo in sync with on-disk changes (focus/visibility + the backend
  // `repo-changed` filesystem event, debounced). See useRepoWatcher.
  useRepoWatcher(refresh);

  // Picking a branch in the navigator raises a graph-reveal request. If we're on
  // another page (PRs/changes) surface the graph so HistoryWorkspace can scroll
  // to the branch tip; the workspace itself clears the request once it has.
  useEffect(() => {
    if (revealTarget) setLeftTab("history");
  }, [revealTarget]);

  // Start each repo in the history view (avoid a stale changes/review pane), drop
  // any review notes pinned against the previous repo's diffs, and reset the
  // history search/filter so one repo's query never lands on another's commits.
  useEffect(() => {
    setLeftTab("history");
    setChangesAll(false);
    closeNav();
    clearReviewNotes();
    resetHistView();
  }, [summary?.path, setChangesAll, closeNav, clearReviewNotes, resetHistView]);

  const showPulls = leftTab === "pulls";

  const backToGraph = () => setLeftTab("history");

  const center = showPulls ? (
    <PullRequestDetail />
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

  // `all` picks the stacked multi-file review; otherwise the single-file view
  // (used when focusing one file from the right-panel list).
  const openChanges = (all = false) => {
    setChangesAll(all);
    setLeftTab("changes");
  };

  // The PR view is two-pane (docked list + detail). History/changes have no left
  // panel anymore — the branch navigator floats from the toolbar — so the graph
  // fills the width and keeps only the right inspector. Side panels are resizable.
  const gridTemplateColumns = showPulls
    ? `${leftWidth}px 6px minmax(0,1fr)`
    : `minmax(0,1fr) 6px ${rightWidth}px`;

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
            <div className="grid min-h-0 flex-1" style={{ gridTemplateColumns }}>
              {showPulls ? (
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
            {/* Floating terminal overlay — overlays the grid without resizing it. */}
            <TerminalLayer />
            {/* Review-notes tray — floats over the grid when notes are pinned. */}
            <ReviewNotesTray />
          </div>
        </>
      ) : (
        <WelcomeScreen onOpen={pickAndOpen} />
      )}

      <SettingsModal />
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
      <AgentMessageDialog />
      <CommitModal />
      <ConfirmDialog />
      <PromptDialog />
      <Toast />
      <Tooltip />

      {/* Frameless-window edge resize grips (Windows/Linux only, inside Tauri). */}
      {!isMac && isTauri && <WindowResizeHandles />}
    </div>
  );
}

export default App;
