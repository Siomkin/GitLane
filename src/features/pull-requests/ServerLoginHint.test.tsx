import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import type { ForgeServerLogin } from "@/lib/api";
import { usePulls } from "@/store/pulls";
import { useRemoteSessions } from "@/store/remoteSessions";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { ServerLoginHint } from "./ServerLoginHint";

const PATH = "ssh://devbox/srv/app";
const base: ForgeServerLogin = {
  provider: "gh",
  host: "github.com",
  installed: true,
  supported: true,
  requiredVersion: null,
  login: null,
};

function show(login: ForgeServerLogin, path = PATH) {
  // The hook re-asks the server on mount; keep answering with the same status.
  invokeMock.mockResolvedValue(login);
  useRemoteSessions.setState({ serverLogins: { [path]: login }, byOrigin: {} });
  useRepo.setState({ summary: { path } as unknown as ReturnType<typeof useRepo.getState>["summary"] });
  return render(<ServerLoginHint />);
}

beforeEach(() => {
  invokeMock.mockReset();
  useUi.setState({ terminalView: "hidden" });
});

describe("ServerLoginHint", () => {
  it("shows the server's gh login command, opens its terminal, and retries", async () => {
    const loadPullRequests = vi.fn().mockResolvedValue(undefined);
    usePulls.setState({ loadPullRequests });
    show(base);
    expect(screen.getByRole("note")).toHaveTextContent(
      "devbox is not signed in to GitHub on github.com. Run this in the terminal on devbox:",
    );
    expect(screen.getByText("gh auth login --hostname github.com")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open terminal" }));
    expect(useUi.getState().terminalView).toBe("open");

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(loadPullRequests).toHaveBeenCalledWith(true));
    expect(invokeMock).toHaveBeenCalledWith("remote_invoke", {
      command: "forge_server_login",
      args: { path: PATH },
    });
  });

  it("says when gh is missing or too old on the server", () => {
    const { unmount } = show({ ...base, installed: false, supported: false });
    expect(screen.getByRole("note")).toHaveTextContent("The GitHub CLI (gh) is not installed on devbox.");
    unmount();
    show({ ...base, supported: false, requiredVersion: "2.95.0" });
    expect(screen.getByRole("note")).toHaveTextContent(
      "The GitHub CLI (gh) on devbox is too old. GitLane needs 2.95.0 or newer.",
    );
  });

  it("uses glab for a GitLab remote", () => {
    show({ ...base, provider: "glab", host: "gitlab.example.test" });
    expect(screen.getByText("glab auth login --hostname gitlab.example.test")).toBeInTheDocument();
  });

  it("renders nothing once the server is signed in, or for a local repository", () => {
    const { container, unmount } = show({ ...base, login: "octocat" });
    expect(container).toBeEmptyDOMElement();
    unmount();
    const local = show(base, "/srv/app");
    expect(local.container).toBeEmptyDOMElement();
  });
});
