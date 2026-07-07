import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
const openUrl = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));

import type { ForgeAuthStatus } from "@/lib/api";
import { useAccounts, type Account } from "@/store/accounts";
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
  authMethod: "API token or git credential helper",
  available: false,
  authenticated: null,
  loginCommand: "Create a Bitbucket API token",
  docsUrl: "https://support.atlassian.com/bitbucket-cloud/docs/api-tokens/",
  notes: "Bitbucket has no bundled CLI probe in GitLane yet.",
};

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
  useUi.setState({ githubSignin: null, confirm: null });
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

  it("Add a provider → GitHub opens the device sign-in dialog", () => {
    render(<AccountsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Add a provider" }));
    fireEvent.click(screen.getByRole("button", { name: /GitHub/ }));
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(useUi.getState().githubSignin).toEqual({ host: "github.com" });
  });

  it("Add a provider → GitLab shows its connect page", () => {
    render(<AccountsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Add a provider" }));
    fireEvent.click(screen.getByRole("button", { name: /GitLab/ }));
    expect(screen.getByText("Connect GitLab")).toBeInTheDocument();
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

  it("shows a connected forge card with sign out for an authenticated GitLab", () => {
    // Isolate the forge card: no GitHub account (whose card also has a Sign out).
    useAccounts.setState({ accounts: [], forgeAuth: [gitlabSignedIn] });
    render(<AccountsPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(useUi.getState().confirm?.title).toBe("Sign out of GitLab?");
  });

  it("saves a manual Bitbucket credential via git credential approve", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "approve_https_credential") return { username: "ada", helper: "osxkeychain" };
      return [];
    });
    useAccounts.setState({ forgeAuth: [gitlabMissing, bitbucketManual] });
    render(<AccountsPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Add a provider" }));
    fireEvent.click(screen.getByRole("button", { name: /Bitbucket/ }));
    fireEvent.change(screen.getByPlaceholderText("HTTPS username"), { target: { value: "ada" } });
    fireEvent.change(screen.getByPlaceholderText("Token / password"), { target: { value: "secret-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Save credential" }));

    await waitFor(() => expect(screen.getByText("Signed in as @ada")).toBeInTheDocument());
    expect(localStorage.getItem("gitlane.forgeCredentials")).toContain('"username":"ada"');
    expect(localStorage.getItem("gitlane.forgeCredentials")).not.toContain("secret-token");
  });
});
