import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { ForgeKind, type RemoteInfo } from "@/lib/api";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { useNotifications } from "@/store/notifications";
import { useAccounts, type Account, type StoredProviderToken } from "@/store/accounts";
import { RemotesPanel } from "./RemotesPanel";

const ORIGIN = {
  name: "origin",
  fetchUrl: "https://github.com/me/repo.git",
  pushUrl: "https://github.com/me/repo.git",
  isDefault: true,
};

const NEW_URL = "https://github.com/me/upstream.git";

// invoke router: list_remotes always resolves; add_remote is overridable per test.
const routeInvoke = (addResult: () => Promise<unknown>) =>
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "list_remotes") return Promise.resolve([ORIGIN]);
    if (cmd === "add_remote") return addResult();
    return Promise.resolve([]);
  });

const openAddForm = async () => {
  // The dashed "Add remote" trigger only renders once the list has loaded.
  fireEvent.click(await screen.findByRole("button", { name: "Add remote" }));
  fireEvent.change(screen.getByLabelText("Remote name"), { target: { value: "upstream" } });
  fireEvent.change(screen.getByLabelText("Remote URL"), { target: { value: NEW_URL } });
};

beforeEach(() => {
  invokeMock.mockReset();
  useRepo.setState({
    summary: { path: "/repo", workdir: "/repo/GitLane", headBranch: "main", headOid: "abc1234", detached: false },
    refresh: vi.fn().mockResolvedValue(undefined),
  });
  useAccounts.setState({ repoAccountRef: null });
  useUi.setState({ confirm: null });
  useNotifications.setState({ toasts: [] });
});

describe("RemotesPanel add UX", () => {
  it("keeps the form open with the user's input when the add fails", async () => {
    routeInvoke(() => Promise.reject("remote upstream already exists"));
    render(<RemotesPanel />);
    await openAddForm();

    fireEvent.click(screen.getByRole("button", { name: "Add remote" })); // submit
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("add_remote", expect.anything()));

    // Form is still open and the URL the user typed is preserved.
    expect(screen.getByLabelText("Remote URL")).toHaveValue(NEW_URL);
    expect(useNotifications.getState().toasts.slice(-1)[0]?.title).toMatch(/Couldn't add upstream/);
  });

  it("collapses the form after a successful add", async () => {
    routeInvoke(() => Promise.resolve(""));
    render(<RemotesPanel />);
    await openAddForm();

    fireEvent.click(screen.getByRole("button", { name: "Add remote" })); // submit
    await waitFor(() => expect(screen.queryByLabelText("Remote URL")).toBeNull());
    // And the repo refresh fires so the toolbar provider updates immediately.
    expect(useRepo.getState().refresh).toHaveBeenCalled();
  });

  it("keeps the row in edit mode when a URL save fails", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "list_remotes") return Promise.resolve([ORIGIN]);
      if (cmd === "set_remote_url") return Promise.reject("fatal: bad URL");
      return Promise.resolve([]);
    });
    render(<RemotesPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("URL for origin"), {
      target: { value: "https://github.com/me/changed.git" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("set_remote_url", expect.anything()));
    // Still editing — the URL field (and the user's edit) survive the failure.
    expect(screen.getByLabelText("URL for origin")).toHaveValue("https://github.com/me/changed.git");
  });

  it("blocks submit for an invalid remote name", async () => {
    routeInvoke(() => Promise.resolve(""));
    render(<RemotesPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Add remote" }));
    fireEvent.change(screen.getByLabelText("Remote name"), { target: { value: "bad name" } });
    fireEvent.change(screen.getByLabelText("Remote URL"), { target: { value: NEW_URL } });

    expect(screen.getByRole("button", { name: "Add remote" })).toBeDisabled();
    expect(screen.getByText(/Remote name: letters or digits/)).toBeInTheDocument();
  });
});

describe("RemotesPanel — GitLab account label (GL-145)", () => {
  const GITLAB_ORIGIN: RemoteInfo = {
    name: "origin",
    fetchUrl: "https://gitlab.com/group/repo.git",
    pushUrl: "https://gitlab.com/group/repo.git",
    isDefault: true,
  };
  const gitlabToken: StoredProviderToken = {
    provider: "gitlab",
    credentialHost: "gitlab.com",
    accountId: "42",
    login: "ada",
    savedAt: 1,
  };
  // A stale legacy gh binding on the GitLab remote — must NOT win the label.
  const ghAccount = { id: "gh:github.com:1", login: "octocat", host: "github.com" } as unknown as Account;

  it("shows the glab/token account for a GitLab default remote, never a stale gh binding", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === "list_remotes" ? [GITLAB_ORIGIN] : []),
    );
    // gitlabPr() reads useRepo.remotes; RemotesPanel's own list drives the card.
    useRepo.setState({
      remotes: [GITLAB_ORIGIN],
      forge: { hasRemote: true, kind: ForgeKind.GitLab, forge: "GitLab", host: "gitlab.com", webUrl: "https://gitlab.com/group/repo" },
    });
    useAccounts.setState({
      loadForgeAuth: vi.fn(), // skip the on-mount probe + token reconcile
      accounts: [ghAccount],
      repoRemoteAccountIds: { origin: ghAccount.id },
      forgeAuth: [],
      providerTokens: { "gitlab.com\u0000ada": gitlabToken },
    });

    render(<RemotesPanel />);

    expect(await screen.findByText("Merge requests enabled")).toBeInTheDocument();
    expect(screen.getByText("@ada")).toBeInTheDocument();
    expect(screen.queryByText("@octocat")).toBeNull();
  });
});

describe("RemotesPanel — Bitbucket account label (GL-141)", () => {
  const BITBUCKET_ORIGIN: RemoteInfo = {
    name: "origin",
    fetchUrl: "https://bitbucket.org/team/app.git",
    pushUrl: "https://bitbucket.org/team/app.git",
    isDefault: true,
  };
  const bitbucketToken: StoredProviderToken = {
    provider: "bitbucket",
    credentialHost: "bitbucket.org",
    accountId: "uuid-1",
    login: "ada",
    transportUsername: "x-token-auth",
    savedAt: 1,
  };
  // A stale legacy gh binding on the Bitbucket remote — must NOT win the label.
  const ghAccount = { id: "gh:github.com:1", login: "octocat", host: "github.com" } as unknown as Account;

  it("shows the Bitbucket token account for a Bitbucket default remote, never a stale gh binding", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === "list_remotes" ? [BITBUCKET_ORIGIN] : []),
    );
    // bitbucketPr() reads useRepo.remotes; RemotesPanel's own list drives the card.
    useRepo.setState({
      remotes: [BITBUCKET_ORIGIN],
      forge: { hasRemote: true, kind: ForgeKind.Bitbucket, forge: "Bitbucket", host: "bitbucket.org", webUrl: "https://bitbucket.org/team/app" },
    });
    useAccounts.setState({
      loadForgeAuth: vi.fn(), // skip the on-mount probe + token reconcile
      accounts: [ghAccount],
      repoRemoteAccountIds: { origin: ghAccount.id },
      forgeAuth: [],
      providerTokens: { "bitbucket.org ada": bitbucketToken },
    });

    render(<RemotesPanel />);

    expect(await screen.findByText("Pull requests enabled")).toBeInTheDocument();
    expect(screen.getByText("@ada")).toBeInTheDocument();
    expect(screen.queryByText("@octocat")).toBeNull();
  });
});
