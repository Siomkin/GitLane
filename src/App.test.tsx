import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./app-shell", () => ({
  AppOverlays: () => null,
  CenterWorkspace: () => <div>Repository workspace</div>,
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
  ONBOARDING_MODE: { Inline: "inline", Overlay: "overlay" },
  RepoOnboarding: ({ mode }: { mode: string }) => (
    <div>{mode === "overlay" ? "Onboarding overlay" : "Repository onboarding"}</div>
  ),
}));
vi.mock("./features/pull-requests/LeftPanel", () => ({ LeftPanel: () => null }));
vi.mock("./features/conflicts", () => ({ OperationAdvisoryBanner: () => null }));
vi.mock("./features/changes/RightPanel", () => ({ RightPanel: () => null }));
vi.mock("./hooks/useResolvedTheme", () => ({ useResolvedTheme: () => "light" }));
vi.mock("./hooks/useAutoFetch", () => ({ useAutoFetch: vi.fn() }));

import App from "./App";
import { SHELL_VIEW, shellView } from "./app-shell/shellView";
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

describe("shellView", () => {
  it.each([
    {
      name: "workspace",
      state: { hasSummary: true, hasMissingRepo: false, restoringSession: false, onboardingOpen: false },
      view: SHELL_VIEW.Workspace,
      onboardingOverlay: false,
    },
    {
      name: "workspace over a still-restoring session",
      state: { hasSummary: true, hasMissingRepo: false, restoringSession: true, onboardingOpen: false },
      view: SHELL_VIEW.Workspace,
      onboardingOverlay: false,
    },
    {
      name: "missing",
      state: { hasSummary: false, hasMissingRepo: true, restoringSession: false, onboardingOpen: false },
      view: SHELL_VIEW.Missing,
      onboardingOverlay: false,
    },
    {
      name: "missing over a still-restoring session",
      state: { hasSummary: false, hasMissingRepo: true, restoringSession: true, onboardingOpen: false },
      view: SHELL_VIEW.Missing,
      onboardingOverlay: false,
    },
    {
      name: "restoring",
      state: { hasSummary: false, hasMissingRepo: false, restoringSession: true, onboardingOpen: false },
      view: SHELL_VIEW.Restoring,
      onboardingOverlay: false,
    },
    {
      name: "onboarding",
      state: { hasSummary: false, hasMissingRepo: false, restoringSession: false, onboardingOpen: false },
      view: SHELL_VIEW.Onboarding,
      onboardingOverlay: false,
    },
    {
      name: "onboarding ignores onboardingOpen in the inline arm",
      state: { hasSummary: false, hasMissingRepo: false, restoringSession: false, onboardingOpen: true },
      view: SHELL_VIEW.Onboarding,
      onboardingOverlay: false,
    },
    {
      name: "overlay over workspace",
      state: { hasSummary: true, hasMissingRepo: false, restoringSession: false, onboardingOpen: true },
      view: SHELL_VIEW.Workspace,
      onboardingOverlay: true,
    },
    {
      name: "overlay over missing",
      state: { hasSummary: false, hasMissingRepo: true, restoringSession: false, onboardingOpen: true },
      view: SHELL_VIEW.Missing,
      onboardingOverlay: true,
    },
  ])("derives $name", ({ state, view, onboardingOverlay }) => {
    expect(shellView(state)).toEqual({ view, onboardingOverlay });
  });
});

describe("App startup repository restoration", () => {
  beforeEach(() => {
    useRepo.setState({
      summary: null,
      missingRepo: null,
      sessionRestorePhase: SESSION_RESTORE_PHASE.Complete,
    });
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

    expect(screen.getByText("Repository workspace")).toBeInTheDocument();
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

describe("App shell views from derived mode", () => {
  beforeEach(() => {
    useRepo.setState({
      summary: null,
      missingRepo: null,
      sessionRestorePhase: SESSION_RESTORE_PHASE.Complete,
    });
    useUi.setState({ onboardingOpen: false });
  });

  it("renders the workspace view when a repo summary is present", () => {
    useRepo.setState({ summary });

    render(<App />);

    expect(screen.getByText("Repository workspace")).toBeInTheDocument();
    expect(screen.queryByText("Missing repository recovery")).not.toBeInTheDocument();
    expect(screen.queryByText("Restoring workspace…")).not.toBeInTheDocument();
    expect(screen.queryByText("Repository onboarding")).not.toBeInTheDocument();
  });

  it("renders the missing view when the repo path no longer resolves", () => {
    useRepo.setState({ missingRepo: { path: "/gone", kind: "missing" } });

    render(<App />);

    expect(screen.getByText("Missing repository recovery")).toBeInTheDocument();
    expect(screen.queryByText("Repository workspace")).not.toBeInTheDocument();
    expect(screen.queryByText("Restoring workspace…")).not.toBeInTheDocument();
    expect(screen.queryByText("Repository onboarding")).not.toBeInTheDocument();
  });

  it("renders the restoring view while the session is restoring with no repo", () => {
    useRepo.setState({ sessionRestorePhase: SESSION_RESTORE_PHASE.Restoring });

    render(<App />);

    expect(screen.getByText("Restoring workspace…")).toBeInTheDocument();
    expect(screen.queryByText("Repository workspace")).not.toBeInTheDocument();
    expect(screen.queryByText("Missing repository recovery")).not.toBeInTheDocument();
    expect(screen.queryByText("Repository onboarding")).not.toBeInTheDocument();
  });

  it("renders the onboarding view when startup resolved with no repository", () => {
    render(<App />);

    expect(screen.getByText("Repository onboarding")).toBeInTheDocument();
    expect(screen.queryByText("Onboarding overlay")).not.toBeInTheDocument();
    expect(screen.queryByText("Repository workspace")).not.toBeInTheDocument();
    expect(screen.queryByText("Missing repository recovery")).not.toBeInTheDocument();
    expect(screen.queryByText("Restoring workspace…")).not.toBeInTheDocument();
  });

  it("renders onboarding as an overlay over the workspace when raised from the tab strip", () => {
    useRepo.setState({ summary });
    useUi.setState({ onboardingOpen: true });

    render(<App />);

    expect(screen.getByText("Repository workspace")).toBeInTheDocument();
    expect(screen.getByText("Onboarding overlay")).toBeInTheDocument();
    expect(screen.queryByText("Repository onboarding")).not.toBeInTheDocument();
  });

  it("renders onboarding as an overlay over the missing-repo view", () => {
    useRepo.setState({ missingRepo: { path: "/gone", kind: "missing" } });
    useUi.setState({ onboardingOpen: true });

    render(<App />);

    expect(screen.getByText("Missing repository recovery")).toBeInTheDocument();
    expect(screen.getByText("Onboarding overlay")).toBeInTheDocument();
  });

  it("does not raise an overlay when onboardingOpen is set in the no-repo start state", () => {
    useUi.setState({ onboardingOpen: true });

    render(<App />);

    expect(screen.getByText("Repository onboarding")).toBeInTheDocument();
    expect(screen.queryByText("Onboarding overlay")).not.toBeInTheDocument();
  });
});
