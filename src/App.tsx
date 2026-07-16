import { useMemo } from "react";
import { AppOverlays, CenterWorkspace, ErrorBanner, useAppBootstrap, useCenterView } from "./app-shell";
import { ActionBar } from "./components/chrome/action-bar";
import { Resizer } from "./components/ui/Resizer";
import { ErrorBoundary } from "./components/ui/ErrorBoundary";
import { ErrorFallback } from "./components/ui/ErrorFallback";
import { Loading } from "./components/ui/Loading";
import { TerminalLayer } from "./features/terminal/TerminalPanel";
import { TitleBar } from "./components/chrome/TitleBar";
import { WindowResizeHandles } from "./components/chrome/WindowResizeHandles";
import { MissingRepoScreen } from "./features/missing-repo";
import { RepoOnboarding } from "./features/onboarding";
import { LeftPanel } from "./features/pull-requests/LeftPanel";
import { OperationAdvisoryBanner } from "./features/conflicts";
import { RightPanel } from "./features/changes/RightPanel";
import { cn } from "./lib/cn";
import { accentVars } from "./lib/accent";
import { isMac, isTauri } from "./lib/platform";
import { SESSION_RESTORE_PHASE, useRepo } from "./store/repo";
import { useUi } from "./store/ui";
import { useResolvedTheme } from "./hooks/useResolvedTheme";
import { useAutoFetch } from "./hooks/useAutoFetch";
import "./App.css";

const App = () => {
  const summary = useRepo((state) => state.summary);
  const missingRepo = useRepo((state) => state.missingRepo);
  const restoringSession = useRepo(
    (state) => state.sessionRestorePhase !== SESSION_RESTORE_PHASE.Complete,
  );
  const operationAdvisory = useRepo((state) => state.operationAdvisory);
  const hasConflictedFiles = useRepo((state) => state.changes.conflicted.length > 0);
  const theme = useResolvedTheme();
  const accent = useUi((state) => state.accent);
  const accentStyle = useMemo(() => accentVars(accent, theme === "dark"), [accent, theme]);
  const leftWidth = useUi((state) => state.leftWidth);
  const rightWidth = useUi((state) => state.rightWidth);
  const adjustLeftWidth = useUi((state) => state.adjustLeftWidth);
  const adjustRightWidth = useUi((state) => state.adjustRightWidth);
  const onboardingOpen = useUi((state) => state.onboardingOpen);
  const closeOnboarding = useUi((state) => state.closeOnboarding);

  useAppBootstrap();
  useAutoFetch();

  // The derived view machine (see app-shell/centerView.ts). An active
  // merge/rebase/cherry-pick/revert takes over the center pane: the repo is in
  // a blocking conflicted state, so the dedicated resolution workspace
  // supersedes the history/changes/PR views (and gates normal commit/stage
  // flows) until the operation is continued or aborted.
  const view = useCenterView();
  const inConflict = view === "conflict";
  const showPulls = view === "pulls";

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

      <ErrorBanner />

      {summary && <ActionBar />}

      {/* Persistent positioned shell spanning the area below the toolbar (or
          below the title bar when no repo is open). It is ALWAYS mounted so the
          floating TerminalLayer inside it never unmounts on a repo open/close/
          switch — that's what lets each repo's panes + PTYs survive (closing the
          active repo no longer resets the neighbour's terminal). It also gives
          the absolutely-positioned drawer its positioning context. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {summary ? (
          <div className="flex min-h-0 flex-1 flex-col px-2.5 pb-2.5">
            {operationAdvisory && !inConflict && (
              <OperationAdvisoryBanner advisory={operationAdvisory} hasConflicts={hasConflictedFiles} />
            )}
            <div className="grid min-h-0 flex-1" style={{ gridTemplateColumns }}>
              {inConflict ? (
                <CenterWorkspace />
              ) : showPulls ? (
                <>
                  <LeftPanel />
                  <Resizer onResize={adjustLeftWidth} />
                  <CenterWorkspace />
                </>
              ) : (
                <>
                  <CenterWorkspace />
                  <Resizer onResize={(dx) => adjustRightWidth(-dx)} />
                  <RightPanel />
                </>
              )}
            </div>
          </div>
        ) : missingRepo ? (
          // A tab whose path no longer resolves (GL-108): the dedicated recovery
          // state replaces the workspace — never a banner over another repo.
          <MissingRepoScreen />
        ) : restoringSession ? (
          <Loading label="Restoring workspace…" className="flex-1" />
        ) : (
          <RepoOnboarding />
        )}

        {/* Floating terminal overlay — overlays the workspace without resizing
            it, and stays mounted across repo switches/closes (its own drawer
            hides itself when no repo is open). Boundaried so a PTY/render crash
            drops only the terminal. */}
        <ErrorBoundary
          resetKeys={[summary?.path]}
          fallback={({ reset }) => (
            <ErrorFallback message="The terminal panel hit an error." onRetry={reset} />
          )}
        >
          <TerminalLayer />
        </ErrorBoundary>
      </div>

      {/* Onboarding raised from the tab strip while a repo (or the missing-repo
          state) is showing; the no-repo start state renders it inline instead. */}
      {onboardingOpen && (summary || missingRepo) && <RepoOnboarding onClose={closeOnboarding} />}

      <AppOverlays />

      {/* Frameless-window edge resize grips (Windows/Linux only, inside Tauri). */}
      {!isMac && isTauri && <WindowResizeHandles />}
    </div>
  );
};

export default App;
