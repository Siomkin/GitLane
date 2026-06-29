import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
const openUrl = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));

import type { ForgeAuthStatus } from "@/lib/api";
import { useAccounts, type Account } from "@/store/accounts";
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
const bitbucketManual: ForgeAuthStatus = {
  provider: "bitbucket",
  forge: "Bitbucket",
  cli: null,
  authMethod: "API token or git credential helper",
  available: false,
  authenticated: null,
  loginCommand: "Create a Bitbucket API token.",
  docsUrl: "https://support.atlassian.com/bitbucket-cloud/docs/api-tokens/",
  notes: "Auth metadata only.",
};

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue([]);
  openUrl.mockReset();
  useAccounts.setState({
    accounts: [ghAccount],
    accountsLoading: false,
    accountsError: null,
    forgeAuth: [gitlabMissing, bitbucketManual],
    forgeAuthError: null,
    forgeAccountsLoading: [],
  });
});

describe("AccountsPanel (add-account model)", () => {
  it("frames accounts as optional and shows connected GitHub with PRs enabled", () => {
    render(<AccountsPanel />);
    expect(screen.getByText(/enable pull requests/i)).toBeInTheDocument();
    expect(screen.getByText("@octocat")).toBeInTheDocument();
    expect(screen.getByText("PRs enabled")).toBeInTheDocument();
  });

  it("does not render a permanent card for un-added providers (GitLab only appears via Add account)", () => {
    render(<AccountsPanel />);
    // GitLab is not shown until the user opens the picker.
    expect(screen.queryByText("GitLab")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Add account/ }));
    expect(screen.getByText("GitLab")).toBeInTheDocument();
    expect(screen.getByText("Bitbucket")).toBeInTheDocument();
  });

  it("shows the install step for a provider whose CLI is missing", () => {
    // In jsdom (non-Tauri) external links fall back to window.open.
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    render(<AccountsPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Add account/ }));
    fireEvent.click(screen.getByText("GitLab"));
    expect(screen.getByText("Install the glab CLI")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Install glab" }));
    expect(openSpy).toHaveBeenCalledWith("https://gitlab.com/gitlab-org/cli", "_blank", "noopener");
    openSpy.mockRestore();
  });

  it("shows the actionable API-token walkthrough for Bitbucket", () => {
    render(<AccountsPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Add account/ }));
    fireEvent.click(screen.getByText("Bitbucket"));
    expect(screen.getByText("Connect with an API token")).toBeInTheDocument();
    // Concrete steps: the credential-helper command and the prompt fields.
    expect(screen.getByText("git config --global credential.helper osxkeychain")).toBeInTheDocument();
    expect(screen.getByText("your API token")).toBeInTheDocument();
  });

  it("leads with an Add-account empty state when there are no accounts", () => {
    useAccounts.setState({ accounts: [] });
    render(<AccountsPanel />);
    expect(screen.getByText("No accounts yet")).toBeInTheDocument();
  });

  it("lists an authenticated provider with its real account as an auth-only card", () => {
    const gitlabAuthed: ForgeAuthStatus = {
      provider: "gitlab",
      forge: "GitLab",
      cli: "glab",
      authMethod: "GitLab CLI",
      available: true,
      authenticated: true,
      loginCommand: "glab auth login",
      docsUrl: "https://gitlab.com/gitlab-org/cli",
      notes: "PR features are not implemented for GitLab.",
      account: { username: "ada", name: "Ada Lovelace" },
    };
    useAccounts.setState({ accounts: [], forgeAuth: [gitlabAuthed] });
    render(<AccountsPanel />);
    // Signed-in GitLab appears as connected (auth-only) with the real username.
    expect(screen.queryByText("No accounts yet")).not.toBeInTheDocument();
    expect(screen.getByText("@ada")).toBeInTheDocument();
    expect(screen.getByText("Auth only — no PRs")).toBeInTheDocument();
  });

  it("shows the forge card immediately with an identity skeleton while it resolves", () => {
    const gitlabAuthed: ForgeAuthStatus = {
      provider: "gitlab",
      forge: "GitLab",
      cli: "glab",
      authMethod: "GitLab CLI",
      available: true,
      authenticated: true,
      loginCommand: "glab auth login",
      docsUrl: "https://gitlab.com/gitlab-org/cli",
      notes: "PR features are not implemented for GitLab.",
      // No account yet — whoami still in flight.
    };
    useAccounts.setState({ accounts: [], forgeAuth: [gitlabAuthed], forgeAccountsLoading: ["gitlab"] });
    render(<AccountsPanel />);
    // The card is visible right away (auth known) with a loading identity.
    expect(screen.getByText("GitLab")).toBeInTheDocument();
    expect(screen.getByText("Resolving account…")).toBeInTheDocument();
  });

  it("shows a resolving state in the connect screen while the whoami is in flight", () => {
    const gitlabAuthed: ForgeAuthStatus = {
      provider: "gitlab",
      forge: "GitLab",
      cli: "glab",
      authMethod: "GitLab CLI",
      available: true,
      authenticated: true,
      loginCommand: "glab auth login",
      docsUrl: "https://gitlab.com/gitlab-org/cli",
      notes: "PR features are not implemented for GitLab.",
    };
    useAccounts.setState({ accounts: [], forgeAuth: [gitlabAuthed], forgeAccountsLoading: ["gitlab"] });
    render(<AccountsPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Add account/ }));
    fireEvent.click(screen.getByText("GitLab"));
    expect(screen.getByText("Signed in — resolving account…")).toBeInTheDocument();
  });

  it("shows an email/UPN identity (Azure) as-is, not as a double-@ handle", () => {
    const azureAuthed: ForgeAuthStatus = {
      provider: "azure-devops",
      forge: "Azure DevOps",
      cli: "az",
      authMethod: "Azure CLI",
      available: true,
      authenticated: true,
      loginCommand: "az login && az devops login",
      docsUrl: "https://learn.microsoft.com/cli/azure/install-azure-cli",
      notes: "Azure DevOps PR features are not implemented.",
      account: { username: "alex@contoso.com" },
    };
    useAccounts.setState({ accounts: [], forgeAuth: [azureAuthed] });
    render(<AccountsPanel />);
    expect(screen.getByText("alex@contoso.com")).toBeInTheDocument();
    expect(screen.queryByText("@alex@contoso.com")).not.toBeInTheDocument();
  });
});
