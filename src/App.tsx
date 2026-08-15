import { useMemo } from "react";
import { AppOverlays, CenterWorkspace, ErrorBanner, useAppBootstrap, useCenterView } from "./app-shell";
import { SHELL_VIEW, shellView } from "./app-shell/shellView";
import { deriveShellLayout, shellLayoutColumns } from "./app-shell/shellLayout";
import { ActionBar } from "./components/chrome/action-bar";
import { Resizer } from "./components/ui/Resizer";
import { ErrorBoundary } from "./components/ui/ErrorBoundary";
import { ErrorFallback } from "./components/ui/ErrorFallback";
import { Loading } from "./components/ui/Loading";
import { TerminalLayer } from "./features/terminal/TerminalPanel";
import { TitleBar } from "./components/chrome/TitleBar";
import { WindowResizeHandles } from "./components/chrome/WindowResizeHandles";
import { MissingRepoScreen } from "./features/missing-repo";
import { ONBOARDING_MODE, RepoOnboarding } from "./features/onboarding";
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
  // The derived shell (see app-shell/shellView.ts). Four mutually exclusive
  // chrome states, plus whether onboarding is raised as an overlay over the
  // workspace or missing-repo view. `onboardingOpen` does not affect the
  // no-repo start state — that is always inline onboarding.
  const shell = shellView({
    hasSummary: !!summary,
    hasMissingRepo: !!missingRepo,
    restoringSession,
    onboardingOpen,
  });

  // The grid shape (see app-shell/shellLayout.ts) — one derivation feeding both
  // the column template and the JSX dispatch below, so the two cannot drift
  // apart. Screen chrome stays in shellView (GL-377); this is the layout arm.
  const layout = deriveShellLayout({ view });
  const gridTemplateColumns = shellLayoutColumns(layout, { leftWidth, rightWidth });

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
        {shell.view === SHELL_VIEW.Workspace ? (
          <div className="flex min-h-0 flex-1 flex-col px-2.5 pb-2.5">
            {operationAdvisory && layout !== "conflict" && (
              <OperationAdvisoryBanner advisory={operationAdvisory} hasConflicts={hasConflictedFiles} />
            )}
            <div className="grid min-h-0 flex-1" style={{ gridTemplateColumns }}>
              {layout === "conflict" ? (
                <CenterWorkspace />
              ) : layout === "pulls" ? (
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
        ) : shell.view === SHELL_VIEW.Missing ? (
          // A tab whose path no longer resolves (GL-108): the dedicated recovery
          // state replaces the workspace — never a banner over another repo.
          <MissingRepoScreen />
        ) : shell.view === SHELL_VIEW.Restoring ? (
          <Loading label="Restoring workspace…" className="flex-1" />
        ) : (
          <RepoOnboarding mode={ONBOARDING_MODE.Inline} />
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
      {shell.onboardingOverlay && (
        <RepoOnboarding mode={ONBOARDING_MODE.Overlay} onClose={closeOnboarding} />
      )}

      <AppOverlays />

      {/* Frameless-window edge resize grips (Windows/Linux only, inside Tauri). */}
      {!isMac && isTauri && <WindowResizeHandles />}
    </div>
  );
};

export default App;
