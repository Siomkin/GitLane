import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import type { ForgeAuthStatus, RepoSummary } from "@/lib/api";
import { emptyIpcInvoke } from "@/test/ipcFixtures";
import { useAccounts } from "@/store/accounts";
import { useRepo } from "@/store/repo";
import { ForgeConnect } from "./ForgeConnect";

const gitlab: ForgeAuthStatus = {
  provider: "gitlab",
  forge: "GitLab",
  cli: "glab",
  authMethod: "GitLab CLI",
  available: true,
  authenticated: false,
  loginCommand: "glab auth login",
  docsUrl: "https://gitlab.com/gitlab-org/cli",
  notes: "GitLab notes.",
};

const bitbucket: ForgeAuthStatus = {
  provider: "bitbucket",
  forge: "Bitbucket",
  cli: null,
  authMethod: "Git credential helper / GCM or SSH",
  available: false,
  authenticated: null,
  loginCommand: "Use an HTTPS remote with Git Credential Manager.",
  docsUrl: "https://support.atlassian.com/bitbucket-cloud/",
  notes: "",
};

let open: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(emptyIpcInvoke);
  useAccounts.setState({ accounts: [], providerTokens: {}, forgeAuth: [] });
  useRepo.setState({ remotes: [] });
  open = vi.spyOn(window, "open").mockReturnValue(null);
});

afterEach(() => open.mockRestore());

const opened = () => open.mock.calls.map((call: unknown[]) => call[0]);

const show = (status: ForgeAuthStatus, accountLoading = false) =>
  render(<ForgeConnect status={status} accountLoading={accountLoading} refresh={<button type="button">Refresh</button>} />);
const choose = (name: string) => fireEvent.click(screen.getByRole("radio", { name }));
const panelTitle = () => screen.getByRole("heading", { level: 3 }).textContent;
/** The method's own badge, not the keychain storage option's "Recommended". */
const methodBadge = () => within(screen.getByRole("heading", { level: 3 }).parentElement!).queryByText("Recommended");
const storeIn = (name: RegExp) => fireEvent.click(screen.getByRole("radio", { name }));
const summary: RepoSummary = { path: "repo", workdir: "repo", headBranch: "main", headOid: "abc", detached: false, unborn: false, isWorktree: false };
const openRemote = (url: string) =>
  useRepo.setState({ summary, remotes: [{ name: "origin", fetchUrl: url, pushUrl: url, isDefault: true }] });
const azure: ForgeAuthStatus = {
  ...gitlab,
  provider: "azure-devops",
  forge: "Azure DevOps",
  cli: "az",
  authMethod: "Azure CLI",
  docsUrl: "https://learn.microsoft.com/azure/devops/",
};

describe("ForgeConnect", () => {
  it("opens GitLab on its CLI and shows only the chosen method's fields", () => {
    show(gitlab);

    expect(screen.getByRole("radio", { name: "GitLab CLI" })).toHaveAttribute("aria-checked", "true");
    expect(panelTitle()).toBe("GitLab CLI");
    expect(methodBadge()).toBeInTheDocument();
    expect(screen.getByText("glab auth login")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("HTTPS username")).toBeNull();
    expect(screen.getAllByRole("radio").map((r) => r.textContent)).toEqual(["GitLab CLI", "Access token", "SSH key"]);

    choose("Access token");
    expect(panelTitle()).toBe("Access token");
    expect(screen.getByRole("radio", { name: /GitLane, in your system keychain/ })).toBeChecked();
    expect(screen.getByLabelText("GitLab username")).toBeInTheDocument();
    expect(screen.queryByText("glab auth login")).toBeNull();
    expect(methodBadge()).toBeNull();
    storeIn(/My Git credential helper/);
    expect(screen.getByPlaceholderText("HTTPS username")).toBeInTheDocument();
    expect(screen.queryByLabelText("GitLab username")).toBeNull();

    choose("SSH key");
    expect(panelTitle()).toBe("SSH key");
    expect(screen.queryByPlaceholderText("HTTPS username")).toBeNull();
    expect(screen.getByRole("button", { name: /Add an SSH key on GitLab/ })).toBeInTheDocument();

    // Refresh, Learn more and the provider's notes stay under every method.
    expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Learn more" }));
    expect(opened()).toContain(gitlab.docsUrl);
    expect(screen.getByText("GitLab notes.")).toBeInTheDocument();
  });

  it("opens Bitbucket, which has no CLI, on Access token in the keychain", () => {
    show(bitbucket);

    expect(screen.queryByRole("radio", { name: /CLI/ })).toBeNull();
    expect(screen.getByRole("radio", { name: "Access token" })).toHaveAttribute("aria-checked", "true");
    expect(methodBadge()).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /GitLane, in your system keychain/ })).toBeChecked();
    expect(screen.getByLabelText("Bitbucket username")).toHaveValue("x-bitbucket-api-token-auth");
    expect(screen.getByText("With pull request access")).toBeInTheDocument();
    expect(screen.getByText("GitLane (keychain)")).toBeInTheDocument();
    expect(screen.getByText(/API token with scopes, created in your Atlassian account/)).toBeInTheDocument();
    // No stable token page known here: the provider's docs instead.
    fireEvent.click(screen.getByRole("button", { name: /Bitbucket token docs/ }));
    expect(opened()).toContain(bitbucket.docsUrl);

    storeIn(/My Git credential helper/);
    expect(screen.getByText(/Bitbucket documents GCM as an HTTPS alternative to SSH/)).toBeInTheDocument();
    expect(screen.getByText("https://username@bitbucket.org/workspace/repo.git")).toBeInTheDocument();
    expect(screen.getByText("Needs an API credential")).toBeInTheDocument();
    expect(screen.getByText("Your helper")).toBeInTheDocument();
  });

  it("saves a GitLab token in the keychain, then checks the remote with it", async () => {
    openRemote("https://gitlab.example.com/group/proj.git");
    show(gitlab);
    choose("Access token");

    // The token page is on the remote's own (self-managed) host.
    fireEvent.click(screen.getByRole("button", { name: /Personal access tokens/ }));
    expect(opened()).toContain("https://gitlab.example.com/-/user_settings/personal_access_tokens");
    expect(screen.getByText("read_repository")).toBeInTheDocument();
    expect(screen.getByText("write_repository")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("GitLab username"), { target: { value: "ada" } });
    fireEvent.change(screen.getByLabelText("Access token"), { target: { value: "glpat-x" } });
    fireEvent.click(screen.getByRole("button", { name: "Save token" }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "check_remote_access",
        expect.objectContaining({ auth: expect.objectContaining({ mode: "providerToken", provider: "gitlab" }) }),
      ),
    );
    expect(invokeMock).toHaveBeenCalledWith(
      "save_provider_token",
      expect.objectContaining({ provider: "gitlab", host: "gitlab.example.com", login: "ada" }),
    );
    expect(invokeMock).not.toHaveBeenCalledWith("approve_https_credential", expect.anything());
    // Generic wording only: the open repository's names stay off screen.
    expect(screen.queryByText(/group\/proj/)).toBeNull();
    expect(screen.queryByText(/\bproj\b/)).toBeNull();
  });

  it("hands the token to the credential helper when the user picks it", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "approve_https_credential" ? Promise.resolve({ username: "ada", helper: "osxkeychain" }) : emptyIpcInvoke(cmd),
    );
    show(gitlab);
    choose("Access token");
    storeIn(/My Git credential helper/);

    fireEvent.change(screen.getByPlaceholderText("HTTPS username"), { target: { value: "ada" } });
    fireEvent.change(screen.getByPlaceholderText("Token / password"), { target: { value: "glpat-x" } });
    fireEvent.click(screen.getByRole("button", { name: "Save credential" }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("approve_https_credential", expect.objectContaining({ credentialHost: "gitlab.com", username: "ada" })),
    );
    expect(invokeMock).not.toHaveBeenCalledWith("save_provider_token", expect.anything());
  });

  it("offers Azure DevOps the credential helper only, and says why", () => {
    show(azure);
    expect(screen.getAllByRole("radio").map((r) => r.textContent)).toEqual(["Azure CLI", "Access token", "SSH key"]);
    choose("Access token");

    expect(screen.queryByRole("radio", { name: /GitLane, in your system keychain/ })).toBeNull();
    expect(screen.queryByRole("radio", { name: /My Git credential helper/ })).toBeNull();
    expect(screen.getByText(/GitLane keeps its own tokens for GitHub, GitLab and Bitbucket only/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText("HTTPS username")).toBeInTheDocument();
    expect(screen.getByText("Your helper")).toBeInTheDocument();
    expect(screen.getByText(/Read and write access to repositories/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Azure DevOps token docs/ }));
    expect(opened()).toContain(azure.docsUrl);
  });

  it("tells a CLI that isn't installed from one that isn't signed in", () => {
    const { unmount } = show({ ...gitlab, available: false, authenticated: null });
    expect(screen.getByText(/isn’t installed yet — a setup step/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Install glab" }));
    expect(opened()).toContain(gitlab.docsUrl);
    unmount();

    show(gitlab);
    expect(screen.getByText("Run the login command in a terminal, then press Refresh.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Install glab" })).toBeNull();
  });

  it("shows a signed-in CLI with its account and drops the Recommended badge", () => {
    show({ ...gitlab, authenticated: true, account: { username: "ada" } });

    expect(screen.getByText("Signed in as @ada")).toBeInTheDocument();
    expect(screen.getByText(/Pull requests for GitLab work through the/)).toBeInTheDocument();
    expect(
      screen.getByText((_, node) => node?.tagName.toLowerCase() === "p" && (node.textContent?.includes("Signed in via glab as @ada") ?? false)),
    ).toBeInTheDocument();
    expect(screen.queryByText("Recommended")).toBeNull();
  });

  it("says the account is resolving, or names the CLI, before the whoami lands", () => {
    const { unmount } = show({ ...gitlab, authenticated: true }, true);
    expect(screen.getByText("Signed in — resolving account…")).toBeInTheDocument();
    unmount();

    show({ ...gitlab, authenticated: true });
    expect(screen.getByText("Signed in to glab")).toBeInTheDocument();
  });

  it("words a signed-in provider without pull requests, or without a CLI", () => {
    const { unmount } = show({ ...gitlab, provider: "gitea", forge: "Gitea", cli: "tea", authMethod: "tea CLI", authenticated: true });
    expect(screen.getByText(/Pull requests aren’t available for Gitea in GitLane yet/)).toBeInTheDocument();
    unmount();

    show({ ...bitbucket, authenticated: true, account: { username: "ada" } });
    expect(screen.getByText(/Pull requests still need a provider API credential path/)).toBeInTheDocument();
  });

  it("leads with the most recent keychain token for this provider", () => {
    useAccounts.setState({
      providerTokens: {
        old: { provider: "bitbucket", credentialHost: "bitbucket.org", accountId: "old", login: "old", savedAt: 1 },
        new: { provider: "bitbucket", credentialHost: "bitbucket.example", accountId: "ada", login: "ada", savedAt: 2 },
        other: { provider: "gitlab", credentialHost: "gitlab.com", accountId: "x", login: "x", savedAt: 3 },
      },
    });
    show(bitbucket);

    expect(screen.getByText("Pull requests ready — @ada")).toBeInTheDocument();
    expect(screen.getByText("bitbucket.example")).toBeInTheDocument();
    expect(methodBadge()).toBeNull();
  });
});
