import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { ForgeKind } from "@/lib/api";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { RepoSettingsModal } from "./RepoSettingsModal";

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue([]);
  useRepo.setState({
    summary: { path: "/repo", workdir: "/repo/GitLane", headBranch: "main", headOid: "abc1234", detached: false },
    forge: {
      hasRemote: true,
      kind: ForgeKind.GitHub,
      forge: "GitHub",
      host: "github.com",
      webUrl: "https://github.com/Siomkin/GitLane",
    },
  });
  useUi.setState({ repoSettingsOpen: true, repoSettingsSection: "remotes", confirm: null, prompt: null });
});

describe("RepoSettingsModal", () => {
  it("renders nothing while closed", () => {
    useUi.setState({ repoSettingsOpen: false });
    const { container } = render(<RepoSettingsModal />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the repo slug and the active section, and routes nav clicks", () => {
    render(<RepoSettingsModal />);
    // Sidebar repo identity derived from the forge web URL.
    expect(screen.getByText("Siomkin/GitLane")).toBeInTheDocument();
    // Active section = remotes → the Remotes panel heading is shown.
    expect(screen.getByRole("heading", { name: "Remotes" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Identity" }));
    expect(useUi.getState().repoSettingsSection).toBe("identity");
  });

  it("closes via the close button", () => {
    render(<RepoSettingsModal />);
    fireEvent.click(screen.getByRole("button", { name: "Close repository settings" }));
    expect(useUi.getState().repoSettingsOpen).toBe(false);
  });

  it("hands off to global settings from the App settings link", () => {
    render(<RepoSettingsModal />);
    fireEvent.click(screen.getByRole("button", { name: /App settings/ }));
    expect(useUi.getState().repoSettingsOpen).toBe(false);
    expect(useUi.getState().settingsOpen).toBe(true);
  });
});
