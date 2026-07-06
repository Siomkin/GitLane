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
  });
  useUi.setState({ githubSignin: null, confirm: null });
});

// Provider-first navigation: a persistent provider list, one page per provider.
describe("AccountsPanel (provider pages)", () => {
  it("lists every provider with a status line, GitHub selected by default", () => {
    render(<AccountsPanel />);
    const nav = screen.getByRole("navigation", { name: "Providers" });
    expect(nav).toBeInTheDocument();
    // Status lines: GitHub connected count; GitLab CLI probe result.
    expect(screen.getByText("1 account connected")).toBeInTheDocument();
    expect(screen.getByText("glab CLI not installed")).toBeInTheDocument();
    // The GitHub page shows the connected account card.
    expect(screen.getByText("@octocat")).toBeInTheDocument();
  });

  it("adding a GitHub account opens the device sign-in dialog", () => {
    render(<AccountsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Add another account" }));
    expect(useUi.getState().githubSignin).toEqual({ host: "github.com" });
  });

  it("selecting a non-GitHub provider shows its connect page", () => {
    render(<AccountsPanel />);
    fireEvent.click(screen.getByRole("button", { name: /GitLab CLI not installed|GitLab/ }));
    expect(screen.getByText("Connect GitLab")).toBeInTheDocument();
  });

  it("shows sign out for an authenticated GitLab provider", () => {
    useAccounts.setState({ forgeAuth: [gitlabSignedIn] });
    render(<AccountsPanel />);

    fireEvent.click(screen.getByRole("button", { name: /Signed in via glab|GitLab/ }));
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    expect(useUi.getState().confirm?.title).toBe("Sign out of GitLab?");
  });

  it("frames accounts as auth-only (identity lives in Identities)", () => {
    render(<AccountsPanel />);
    expect(screen.getByText(/Who your commits are authored as\s+is separate/)).toBeInTheDocument();
  });

  it("marks a manual Bitbucket credential as saved after git credential approve succeeds", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "approve_https_credential") return { username: "ada", helper: "osxkeychain" };
      return [];
    });
    useAccounts.setState({ forgeAuth: [gitlabMissing, bitbucketManual] });
    render(<AccountsPanel />);

    fireEvent.click(screen.getByRole("button", { name: /No CLI — manual setup|Bitbucket/ }));
    fireEvent.change(screen.getByPlaceholderText("HTTPS username"), { target: { value: "ada" } });
    fireEvent.change(screen.getByPlaceholderText("Token / password"), { target: { value: "secret-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Save credential" }));

    await waitFor(() => expect(screen.getByText("Credential saved for @ada")).toBeInTheDocument());
    expect(screen.getByText("@ada")).toBeInTheDocument();
    expect(localStorage.getItem("gitlane.forgeCredentials")).toContain('"username":"ada"');
    expect(localStorage.getItem("gitlane.forgeCredentials")).not.toContain("secret-token");
  });
});
