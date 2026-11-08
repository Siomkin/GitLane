import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { ForgeKind } from "@/lib/api";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { useAccounts, type Account } from "@/store/accounts";
import { RepoSettingsModal } from "./RepoSettingsModal";

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue([]);
  useRepo.setState({
    summary: { path: "/repo", workdir: "/repo/GitLane", headBranch: "main", headOid: "abc1234", detached: false, unborn: false, isWorktree: false },
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

  it("shows the repo slug and ONE page: identity above remotes (GL-130)", () => {
    render(<RepoSettingsModal />);
    // Sidebar repo identity derived from the forge web URL.
    expect(screen.getByText("Siomkin/GitLane")).toBeInTheDocument();
    // Both sections render together on one page — identity first, so "who
    // authors" sits right above "who authenticates, per remote".
    expect(screen.getByRole("heading", { name: "Identity" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Remotes" })).toBeInTheDocument();
    // The sidebar stays as scroll navigation: clicking a section highlights it
    // without hiding the other one.
    fireEvent.click(screen.getByRole("button", { name: "Commit author" }));
    expect(useUi.getState().repoSettingsSection).toBe("identity");
    expect(screen.getByRole("heading", { name: "Remotes" })).toBeInTheDocument();
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

  it("does not self-dismiss while a confirm overlay (e.g. remove remote) is open", () => {
    useUi.setState({ confirm: { title: "Remove remote?", onConfirm: () => {} } });
    render(<RepoSettingsModal />);
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.mouseDown(document.body);
    expect(useUi.getState().repoSettingsOpen).toBe(true);
  });

  describe("binding a newly connected account on return", () => {
    const acct = (id: string, login: string): Account => ({
      id,
      forge: "GitHub",
      provider: "gh",
      host: "github.com",
      accountId: id,
      login,
      label: login,
      username: login,
      name: login,
      email: `${login}@x.dev`,
      color: "#5b8def",
      ref: { provider: "gh", host: "github.com", accountId: id, login },
      active: true,
      healthy: true,
      healthError: "",
    });
    const hint = (accountIdsBefore: string[]) => ({
      repoPath: "/repo",
      repoName: "Siomkin/GitLane",
      remote: "origin",
      accountIdsBefore,
    });
    let setRemoteAccount: ReturnType<typeof vi.fn<(remote: string, id: string | null) => Promise<void>>>;

    beforeEach(() => {
      setRemoteAccount = vi.fn<(remote: string, id: string | null) => Promise<void>>(async () => {});
      useRepo.setState({
        remotes: [{ name: "origin", fetchUrl: "https://github.com/Siomkin/GitLane.git", pushUrl: "https://github.com/Siomkin/GitLane.git", isDefault: true }],
      });
      useAccounts.setState({ accounts: [acct("old", "alice"), acct("new", "bob")], repoRemoteAccountIds: {}, providerTokens: {}, setRemoteAccount });
    });

    it("leaves a remote on a keychain token alone", () => {
      useAccounts.setState({
        providerTokens: {
          "github.com\u0000ada": { provider: "github", credentialHost: "github.com", accountId: "ada", login: "ada", savedAt: 1 },
        },
      });
      useUi.setState({ repoSettingsBindHint: hint(["old"]) });
      render(<RepoSettingsModal />);
      expect(setRemoteAccount).not.toHaveBeenCalled();
      expect(useUi.getState().repoSettingsBindHint).toBeNull();
    });

    it("binds the one new matching account to an unbound remote", () => {
      useUi.setState({ repoSettingsBindHint: hint(["old"]) });
      render(<RepoSettingsModal />);
      expect(setRemoteAccount).toHaveBeenCalledWith("origin", "new");
      expect(useUi.getState().repoSettingsBindHint).toBeNull();
    });

    it("leaves an already-bound remote alone", () => {
      useAccounts.setState({ repoRemoteAccountIds: { origin: "old" } });
      useUi.setState({ repoSettingsBindHint: hint(["old"]) });
      render(<RepoSettingsModal />);
      expect(setRemoteAccount).not.toHaveBeenCalled();
    });

    it("drops a hint left by another repository without binding", () => {
      useUi.setState({ repoSettingsBindHint: { ...hint(["old"]), repoPath: "/elsewhere" } });
      render(<RepoSettingsModal />);
      expect(setRemoteAccount).not.toHaveBeenCalled();
      expect(useUi.getState().repoSettingsBindHint).toBeNull();
    });

    it("waits while the remote list has not loaded the hinted remote", () => {
      useRepo.setState({ remotes: [] });
      useUi.setState({ repoSettingsBindHint: hint(["old"]) });
      render(<RepoSettingsModal />);
      expect(setRemoteAccount).not.toHaveBeenCalled();
      expect(useUi.getState().repoSettingsBindHint).not.toBeNull();
    });

    it("binds nothing when no account was added", () => {
      useUi.setState({ repoSettingsBindHint: hint(["old", "new"]) });
      render(<RepoSettingsModal />);
      expect(setRemoteAccount).not.toHaveBeenCalled();
      expect(useUi.getState().repoSettingsBindHint).toBeNull();
    });
  });
});
