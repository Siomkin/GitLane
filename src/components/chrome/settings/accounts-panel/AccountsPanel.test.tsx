import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
const openUrl = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));

import type { ForgeAuthStatus } from "@/lib/api";
import type { RemoteInfo } from "@/lib/api";
import { useAccounts, type Account } from "@/store/accounts";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { AccountsPanel } from "./AccountsPanel";

const ghAccount: Account = {
  id: "gh:github.com:1",
  forge: "GitHub",
  provider: "gh",
  host: "github.com",
  accountId: "1",
  login: "octocat",
  label: "octocat",
  username: "octocat",
  name: "Octo Cat",
  email: "octo@example.com",
  color: "#5b8def",
  ref: { provider: "gh", host: "github.com", accountId: "1", login: "octocat" },
  active: true,
  healthy: true,
  healthError: "",
};

const gitlabMissing: ForgeAuthStatus = {
  provider: "gitlab",
  forge: "GitLab",
  cli: "glab",
  authMethod: "GitLab CLI",
  available: false,
  authenticated: null,
  loginCommand: "glab auth login",
  docsUrl: "https://gitlab.com/gitlab-org/cli",
  notes: "PR features are not implemented for GitLab.",
};

const gitlabSignedIn: ForgeAuthStatus = {
  ...gitlabMissing,
  available: true,
  authenticated: true,
  account: { username: "ada" },
};

const bitbucketManual: ForgeAuthStatus = {
  provider: "bitbucket",
  forge: "Bitbucket",
  cli: null,
  authMethod: "Git credential helper / GCM or SSH",
  available: false,
  authenticated: null,
  loginCommand: "Use an HTTPS remote with Git Credential Manager, or use an SSH remote with a Bitbucket SSH key.",
  docsUrl: "https://support.atlassian.com/bitbucket-cloud/docs/configure-ssh-and-two-step-verification/",
  notes: "Bitbucket has no bundled CLI. Git transport works through Git's credential helper/GCM for HTTPS, or through SSH keys for SSH remotes.",
};

const azureMissing: ForgeAuthStatus = {
  provider: "azure-devops",
  forge: "Azure DevOps",
  cli: "az",
  authMethod: "Azure CLI",
  available: false,
  authenticated: null,
  loginCommand: "az login",
  docsUrl: "https://learn.microsoft.com/cli/azure/install-azure-cli?view=azure-cli-latest",
  notes: "Uses Azure CLI sign-in as the account signal. Git transport works through GCM/helper for HTTPS, or through SSH keys for SSH remotes.",
};

const remote = (url: string, name = "origin"): RemoteInfo => ({
  name,
  fetchUrl: url,
  pushUrl: url,
  isDefault: name === "origin",
});

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue([]);
  openUrl.mockReset();
  useAccounts.setState({
    accounts: [ghAccount],
    accountsLoading: false,
    accountsError: null,
    forgeAuth: [gitlabMissing],
    forgeAuthError: null,
    forgeAccountsLoading: [],
    providerTokens: {},
  });
  useUi.setState({ githubSignin: null, confirm: null, repoSettingsOpen: false, repoSettingsSection: "identity" });
  useRepo.setState({ remotes: [] });
});

// No rail: connected accounts + a single "Add a provider" button → picker → connect page.
describe("AccountsPanel", () => {
  it("lists connected accounts and offers Add a provider", () => {
    render(<AccountsPanel />);
    expect(screen.getByText("@octocat")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add a provider" })).toBeInTheDocument();
  });

  it("frames accounts as auth-only (identity lives in Identities)", () => {
    render(<AccountsPanel />);
    expect(screen.getByText(/Who your commits are authored as is separate/)).toBeInTheDocument();
  });

  it("groups connected accounts under one section header per provider", () => {
    invokeMock.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === "provider_token_status" ? { hasToken: true } : []),
    );
    useAccounts.setState({
      accounts: [ghAccount],
      forgeAuth: [gitlabSignedIn],
      providerTokens: {
        "bitbucket.org\u0000ada": {
          provider: "bitbucket",
          credentialHost: "bitbucket.org",
          accountId: "ada",
          login: "ada",
          savedAt: 0,
        },
      },
    });
    render(<AccountsPanel />);

    // A header per connected provider, with its member listed underneath.
    expect(screen.getByText("GitHub")).toBeInTheDocument();
    expect(screen.getByText("GitLab")).toBeInTheDocument();
    expect(screen.getByText("Bitbucket")).toBeInTheDocument();
    expect(screen.getByText("@octocat")).toBeInTheDocument();
    expect(screen.getByText("Keychain token")).toBeInTheDocument();
  });

  it("offers GitHub, GitLab, Bitbucket, and Azure DevOps in the picker", () => {
    useAccounts.setState({ forgeAuth: [gitlabMissing, bitbucketManual, azureMissing] });
    render(<AccountsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Add a provider" }));

    expect(screen.getByRole("button", { name: /GitHub/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /GitLab/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Bitbucket/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Azure DevOps/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Gitea/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Forgejo/ })).toBeNull();
  });

  it("Add a provider → GitHub opens the device sign-in dialog", () => {
    render(<AccountsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Add a provider" }));
    fireEvent.click(screen.getByRole("button", { name: /GitHub/ }));
    expect(screen.getAllByText("Git Credential Manager").length).toBeGreaterThan(0);
    expect(screen.getByText("SSH key")).toBeInTheDocument();
    expect(screen.getByText("GitHub CLI")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(useUi.getState().githubSignin).toEqual({ host: "github.com" });
  });

  it("Add a provider → GitLab shows its connect page", () => {
    render(<AccountsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Add a provider" }));
    fireEvent.click(screen.getByRole("button", { name: /GitLab/ }));
    expect(screen.getByText("Connect GitLab")).toBeInTheDocument();
  });

  it("shows signed-in CLI state for GitLab while keeping GCM and SSH available", () => {
    useAccounts.setState({ accounts: [], forgeAuth: [gitlabSignedIn] });
    render(<AccountsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Add a provider" }));
    fireEvent.click(screen.getByRole("button", { name: /GitLab/ }));

    expect(
      screen.getByText(
        (_, node) =>
          node?.tagName.toLowerCase() === "p" &&
          (node.textContent?.includes("Signed in via glab as @ada") ?? false),
      ),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Git Credential Manager").length).toBeGreaterThan(0);
    expect(screen.getByText("SSH key")).toBeInTheDocument();
  });

  it("shows a keychain-token (OAuth/PAT) account with sign out", () => {
    // Backend reports the token still present so reconcile doesn't prune it.
    invokeMock.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === "provider_token_status" ? { hasToken: true } : []),
    );
    useAccounts.setState({
      accounts: [],
      forgeAuth: [],
      providerTokens: {
        "gitlab.com:oauth2": {
          provider: "gitlab",
          credentialHost: "gitlab.com",
          accountId: "42",
          login: "ada",
          transportUsername: "oauth2",
          savedAt: 0,
        },
      },
    });
    render(<AccountsPanel />);

    expect(screen.getByText("@ada")).toBeInTheDocument();
    expect(screen.getByText("Keychain token")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(useUi.getState().confirm?.title).toBe("Sign out of GitLab?");
  });

  it("shows repo HTTPS usernames as GCM/helper transport accounts", () => {
    useAccounts.setState({ accounts: [], forgeAuth: [bitbucketManual], providerTokens: {} });
    useRepo.setState({ remotes: [remote("https://SiomkinAlexander@bitbucket.org/darang/gitlanebucket.git")] });
    render(<AccountsPanel />);

    expect(screen.getByText("Bitbucket")).toBeInTheDocument();
    expect(screen.getByText("Transport only")).toBeInTheDocument();
    expect(screen.getByText("@SiomkinAlexander")).toBeInTheDocument();
    expect(screen.getByText("GCM/helper")).toBeInTheDocument();
    expect(screen.getByText(/origin · bitbucket.org · git transport only/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Forget" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument();
  });

  it("keeps distinct path-scoped Azure credentials independently forgettable", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === "reject_https_credential" ? { helper: "manager-core" } : []),
    );
    useAccounts.setState({ accounts: [], forgeAuth: [azureMissing], providerTokens: {} });
    useRepo.setState({
      remotes: [
        remote("https://alex@dev.azure.com/one/Project/_git/repo.git", "azure-one"),
        remote("https://alex@dev.azure.com/two/My%20Project/_git/repo.git", "azure-two"),
      ],
    });
    render(<AccountsPanel />);

    expect(screen.getAllByText("@alex")).toHaveLength(2);
    expect(screen.getByText(/azure-one · dev\.azure\.com/)).toBeInTheDocument();
    expect(screen.getByText(/azure-two · dev\.azure\.com/)).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: "Forget" })[1]);
    useUi.getState().confirm?.onConfirm();

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("reject_https_credential", {
        credentialHost: "dev.azure.com",
        path: "two/My Project/_git/repo.git",
        username: "alex",
      }),
    );
  });

  it("updates a repo transport credential from the GCM/helper row", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "approve_https_credential") return Promise.resolve({ username: "SiomkinAlexander", helper: "manager-core" });
      if (cmd === "save_provider_token") return Promise.resolve({ hasToken: true });
      return Promise.resolve([]);
    });
    useAccounts.setState({ accounts: [], forgeAuth: [bitbucketManual], providerTokens: {} });
    useRepo.setState({
      summary: { path: "/repo", workdir: "/repo", headBranch: "main", headOid: "abc", detached: false },
      remotes: [remote("https://SiomkinAlexander@bitbucket.org/darang/gitlanebucket.git")],
    });
    render(<AccountsPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    expect(screen.getByPlaceholderText("HTTPS username")).toHaveValue("SiomkinAlexander");
    fireEvent.change(screen.getByPlaceholderText("Token / password"), { target: { value: "new-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Save credential" }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("approve_https_credential", {
        credentialHost: "bitbucket.org",
        path: null,
        username: "SiomkinAlexander",
        password: "new-secret",
      }),
    );
    expect(invokeMock).toHaveBeenCalledWith("set_remote_username", {
      path: "/repo",
      name: "origin",
      username: "SiomkinAlexander",
    });
    expect(invokeMock).toHaveBeenCalledWith("save_provider_token", {
      provider: "bitbucket",
      host: "bitbucket.org",
      accountId: "SiomkinAlexander",
      login: "SiomkinAlexander",
      token: "new-secret",
    });
    await waitFor(() => expect(screen.getByText("Keychain token")).toBeInTheDocument());
  });

  it("keeps the pasted token visible when updating a transport credential fails", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "approve_https_credential" ? Promise.reject(new Error("keychain locked")) : Promise.resolve([]),
    );
    useAccounts.setState({ accounts: [], forgeAuth: [bitbucketManual], providerTokens: {} });
    useRepo.setState({
      summary: { path: "/repo", workdir: "/repo", headBranch: "main", headOid: "abc", detached: false },
      remotes: [remote("https://SiomkinAlexander@bitbucket.org/darang/gitlanebucket.git")],
    });
    render(<AccountsPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    fireEvent.change(screen.getByPlaceholderText("Token / password"), { target: { value: "new-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Save credential" }));

    await waitFor(() => expect(screen.getByText("Credential was not saved. Check the error and try again.")).toBeInTheDocument());
    expect(screen.getByPlaceholderText("Token / password")).toHaveValue("new-secret");
    expect(invokeMock).not.toHaveBeenCalledWith("save_provider_token", expect.anything());
  });

  it("forgets or removes a repo transport credential from the GCM/helper row", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === "reject_https_credential" ? { helper: "manager-core" } : []),
    );
    useAccounts.setState({ accounts: [], forgeAuth: [bitbucketManual], providerTokens: {} });
    useRepo.setState({
      summary: { path: "/repo", workdir: "/repo", headBranch: "main", headOid: "abc", detached: false },
      remotes: [remote("https://SiomkinAlexander@bitbucket.org/darang/gitlanebucket.git")],
    });
    render(<AccountsPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Forget" }));
    expect(useUi.getState().confirm?.title).toBe("Forget Bitbucket credential?");
    useUi.getState().confirm?.onConfirm();

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("reject_https_credential", {
        credentialHost: "bitbucket.org",
        path: null,
        username: "SiomkinAlexander",
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(useUi.getState().confirm?.title).toBe("Remove @SiomkinAlexander from origin?");
    useUi.getState().confirm?.onConfirm();

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("set_remote_username", {
        path: "/repo",
        name: "origin",
        username: null,
      }),
    );
  });

  it("shows a connected forge card with sign out for an authenticated GitLab", () => {
    // Isolate the forge card: no GitHub account (whose card also has a Sign out).
    useAccounts.setState({ accounts: [], forgeAuth: [gitlabSignedIn] });
    render(<AccountsPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(useUi.getState().confirm?.title).toBe("Sign out of GitLab?");
  });

  it("consumes a queued connect intent: lands on that provider's connect view once", () => {
    useAccounts.setState({ forgeAuth: [gitlabMissing, bitbucketManual] });
    useUi.setState({ accountsConnectIntent: "bitbucket" });
    render(<AccountsPanel />);

    // Straight onto the Bitbucket connect page, no picker click needed…
    expect(screen.getByText("Connect Bitbucket")).toBeInTheDocument();
    // …and the intent is consumed so a later plain open starts at the list.
    expect(useUi.getState().accountsConnectIntent).toBeNull();
  });

  it("shows GCM credential entry and SSH for Bitbucket, with OAuth/keychain setup hidden", () => {
    useAccounts.setState({ forgeAuth: [gitlabMissing, bitbucketManual] });
    render(<AccountsPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Add a provider" }));
    fireEvent.click(screen.getByRole("button", { name: /Bitbucket/ }));

    expect(screen.getAllByText("Git Credential Manager").length).toBeGreaterThan(0);
    expect(screen.getByText("SSH key")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("HTTPS username")).toHaveValue("x-bitbucket-api-token-auth");
    expect(screen.getByPlaceholderText("Token / password")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "GitLane keychain" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign in with OAuth" })).toBeNull();
  });

  it("saves a Bitbucket credential through the configured Git helper/GCM", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === "approve_https_credential" ? { username: "ada", helper: "manager-core" } : []),
    );
    useAccounts.setState({ forgeAuth: [gitlabMissing, bitbucketManual] });
    render(<AccountsPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Add a provider" }));
    fireEvent.click(screen.getByRole("button", { name: /Bitbucket/ }));
    fireEvent.change(screen.getByPlaceholderText("HTTPS username"), { target: { value: "ada" } });
    fireEvent.change(screen.getByPlaceholderText("Token / password"), { target: { value: "secret-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Save credential" }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("approve_https_credential", {
        credentialHost: "bitbucket.org",
        path: null,
        username: "ada",
        password: "secret-token",
      }),
    );
  });

  it("saves an Azure DevOps credential through the configured Git helper/GCM", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === "approve_https_credential" ? { username: "alex", helper: "manager-core" } : []),
    );
    useAccounts.setState({ forgeAuth: [gitlabMissing, bitbucketManual, azureMissing] });
    render(<AccountsPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Add a provider" }));
    fireEvent.click(screen.getByRole("button", { name: /Azure DevOps/ }));
    expect(screen.getByText("Azure CLI")).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("HTTPS username"), { target: { value: "alex" } });
    fireEvent.change(screen.getByPlaceholderText("Token / password"), { target: { value: "azure-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Save credential" }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("approve_https_credential", {
        credentialHost: "dev.azure.com",
        path: null,
        username: "alex",
        password: "azure-secret",
      }),
    );
  });
});
