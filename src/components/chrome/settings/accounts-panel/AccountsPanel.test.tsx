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

  it("offers only GitHub, GitLab, and Bitbucket in the picker", () => {
    useAccounts.setState({ forgeAuth: [gitlabMissing, bitbucketManual] });
    render(<AccountsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Add a provider" }));

    expect(screen.getByRole("button", { name: /GitHub/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /GitLab/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Bitbucket/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Azure/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Gitea/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Forgejo/ })).toBeNull();
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

  it("consumes a queued connect intent: lands on that provider's connect view once", () => {
    useAccounts.setState({ forgeAuth: [gitlabMissing, bitbucketManual] });
    useUi.setState({ accountsConnectIntent: "bitbucket" });
    render(<AccountsPanel />);

    // Straight onto the Bitbucket connect page, no picker click needed…
    expect(screen.getByText("Connect Bitbucket")).toBeInTheDocument();
    // …and the intent is consumed so a later plain open starts at the list.
    expect(useUi.getState().accountsConnectIntent).toBeNull();
  });

  it("keeps the credential form to two fields: host is static with Edit, path scope behind Advanced", () => {
    useAccounts.setState({ forgeAuth: [gitlabMissing, bitbucketManual] });
    render(<AccountsPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Add a provider" }));
    fireEvent.click(screen.getByRole("button", { name: /Bitbucket/ }));

    // Two inputs by default; the host is a fact, not a field, and the Bitbucket
    // API-token username convention is prefilled.
    expect(screen.getByPlaceholderText("HTTPS username")).toHaveValue("x-bitbucket-api-token-auth");
    expect(screen.getByPlaceholderText("Token / password")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Host")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Path scope (optional)")).not.toBeInTheDocument();
    // The host shows as a static fact (also mentioned in the token help copy).
    expect(screen.getAllByText("bitbucket.org").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByPlaceholderText("Host")).toHaveValue("bitbucket.org");

    // Path scope is a Git-helper concept; it lives behind Advanced on that
    // destination (Bitbucket defaults to the keychain, so switch first).
    fireEvent.click(screen.getByRole("button", { name: "Git helper" }));
    fireEvent.click(screen.getByRole("button", { name: "Advanced…" }));
    expect(screen.getByPlaceholderText("Path scope (optional)")).toBeInTheDocument();
  });

  it("defaults a PR-capable forge to the keychain and stores the token there", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "save_provider_token") return { stored: true };
      return [];
    });
    useAccounts.setState({ forgeAuth: [gitlabMissing, bitbucketManual] });
    render(<AccountsPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Add a provider" }));
    fireEvent.click(screen.getByRole("button", { name: /Bitbucket/ }));

    // Keychain is the default destination for Bitbucket (it's what powers PRs),
    // so the primary action stores in the keychain rather than the Git helper.
    fireEvent.change(screen.getByPlaceholderText("HTTPS username"), { target: { value: "ada" } });
    fireEvent.change(screen.getByPlaceholderText("Token / password"), { target: { value: "secret-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Store in keychain" }));

    // The keychain state surfaces as the "Pull requests ready" confirmation, and
    // the token is recorded (non-secret) in the provider-token map.
    await waitFor(() => expect(screen.getByText(/Pull requests ready/)).toBeInTheDocument());
    expect(invokeMock).toHaveBeenCalledWith(
      "save_provider_token",
      expect.objectContaining({ provider: "bitbucket", host: "bitbucket.org", login: "ada" }),
    );
    expect(localStorage.getItem("gitlane.providerTokens")).toContain('"provider":"bitbucket"');
    expect(localStorage.getItem("gitlane.providerTokens")).not.toContain("secret-token");
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
    // The Git helper (transport-only) path is the non-default destination now.
    fireEvent.click(screen.getByRole("button", { name: "Git helper" }));
    fireEvent.change(screen.getByPlaceholderText("HTTPS username"), { target: { value: "ada" } });
    fireEvent.change(screen.getByPlaceholderText("Token / password"), { target: { value: "secret-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Save credential" }));

    await waitFor(() => expect(screen.getByText("Signed in as @ada")).toBeInTheDocument());
    expect(localStorage.getItem("gitlane.forgeCredentials")).toContain('"username":"ada"');
    expect(localStorage.getItem("gitlane.forgeCredentials")).not.toContain("secret-token");
  });
});
