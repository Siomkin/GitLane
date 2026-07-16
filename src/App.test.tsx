import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./app-shell", () => ({
  AppOverlays: () => null,
  CenterWorkspace: () => null,
  ErrorBanner: () => null,
  useAppBootstrap: vi.fn(),
  useCenterView: () => "history",
}));
vi.mock("./components/chrome/action-bar", () => ({ ActionBar: () => null }));
vi.mock("./components/chrome/TitleBar", () => ({ TitleBar: () => null }));
vi.mock("./components/chrome/WindowResizeHandles", () => ({ WindowResizeHandles: () => null }));
vi.mock("./features/terminal/TerminalPanel", () => ({ TerminalLayer: () => null }));
vi.mock("./features/missing-repo", () => ({
  MissingRepoScreen: () => <div>Missing repository recovery</div>,
}));
vi.mock("./features/onboarding", () => ({
  RepoOnboarding: () => <div>Repository onboarding</div>,
}));
vi.mock("./features/pull-requests/LeftPanel", () => ({ LeftPanel: () => null }));
vi.mock("./features/conflicts", () => ({ OperationAdvisoryBanner: () => null }));
vi.mock("./features/changes/RightPanel", () => ({ RightPanel: () => null }));
vi.mock("./hooks/useResolvedTheme", () => ({ useResolvedTheme: () => "light" }));
vi.mock("./hooks/useAutoFetch", () => ({ useAutoFetch: vi.fn() }));

import App from "./App";
import { SESSION_RESTORE_PHASE, useRepo } from "./store/repo";
import { useUi } from "./store/ui";
import type { RepoSummary } from "./lib/api";

const summary: RepoSummary = {
  path: "/repo",
  workdir: "/repo",
  headBranch: "main",
  headOid: null,
  detached: false,
};

describe("App startup repository restoration", () => {
  beforeEach(() => {
    useRepo.setState({ summary: null, missingRepo: null });
    useUi.setState({ onboardingOpen: false });
  });

  it.each([SESSION_RESTORE_PHASE.Pending, SESSION_RESTORE_PHASE.Restoring])(
    "shows a neutral loading state instead of onboarding while restoration is %s",
    (sessionRestorePhase) => {
      useRepo.setState({ sessionRestorePhase });

      render(<App />);

      expect(screen.getByText("Restoring workspace…")).toBeInTheDocument();
      expect(screen.queryByText("Repository onboarding")).not.toBeInTheDocument();
    },
  );

  it("shows the repository shell when its summary lands during restoration", () => {
    useRepo.setState({
      summary,
      sessionRestorePhase: SESSION_RESTORE_PHASE.Restoring,
    });

    render(<App />);

    expect(screen.queryByText("Restoring workspace…")).not.toBeInTheDocument();
    expect(screen.queryByText("Repository onboarding")).not.toBeInTheDocument();
  });

  it("shows missing-repository recovery when it lands during restoration", () => {
    useRepo.setState({
      missingRepo: { path: "/gone", kind: "missing" },
      sessionRestorePhase: SESSION_RESTORE_PHASE.Restoring,
    });

    render(<App />);

    expect(screen.getByText("Missing repository recovery")).toBeInTheDocument();
    expect(screen.queryByText("Restoring workspace…")).not.toBeInTheDocument();
    expect(screen.queryByText("Repository onboarding")).not.toBeInTheDocument();
  });

  it("shows onboarding after startup resolves without a repository", () => {
    useRepo.setState({ sessionRestorePhase: SESSION_RESTORE_PHASE.Complete });

    render(<App />);

    expect(screen.getByText("Repository onboarding")).toBeInTheDocument();
    expect(screen.queryByText("Restoring workspace…")).not.toBeInTheDocument();
  });
});
