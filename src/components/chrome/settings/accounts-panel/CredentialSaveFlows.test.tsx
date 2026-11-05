import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import type { RemoteInfo, RepoSummary } from "@/lib/api";
import { emptyIpcInvoke } from "@/test/ipcFixtures";
import { useAccounts } from "@/store/accounts";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { AccountsPanel } from "./AccountsPanel";
import { CredentialEntryForm } from "./provider-connect/credential-entry";
import { GithubTokenForm } from "./provider-connect/GithubTokenForm";
import { TransportCredentialCard } from "./TransportCredentialCard";

const path = "repo-under-test";
const summary: RepoSummary = { path, workdir: path, headBranch: "main", headOid: "abc", detached: false, unborn: false, isWorktree: false };
const origin: RemoteInfo = {
  name: "origin",
  fetchUrl: "https://Siomkin@github.com/siomkin/repo.git",
  pushUrl: "https://Siomkin@github.com/siomkin/repo.git",
  isDefault: true,
};
const shadowed = {
  kind: "auth",
  code: "credentialShadowed",
  message: "Git returned a saved credential for @x-access-token instead of @Siomkin.",
  credentialUsername: "x-access-token",
};

/** `cmd` → value (resolved), CommandError-shaped object (rejected), or a
 * function of the call count and args. Everything else answers empty. */
function ipc(overrides: Record<string, unknown>) {
  const calls: Record<string, number> = {};
  invokeMock.mockImplementation((cmd: string, args: unknown) => {
    if (!(cmd in overrides)) return emptyIpcInvoke(cmd);
    calls[cmd] = (calls[cmd] ?? 0) + 1;
    const answer = overrides[cmd];
    const value = typeof answer === "function" ? (answer as (n: number, a: unknown) => unknown)(calls[cmd], args) : answer;
    return value && typeof value === "object" && "kind" in value ? Promise.reject(value) : Promise.resolve(value);
  });
}

const confirmNow = () => {
  const confirm = useUi.getState().confirm;
  expect(confirm).not.toBeNull();
  confirm!.onConfirm();
};

beforeEach(() => {
  localStorage.clear();
  invokeMock.mockReset();
  invokeMock.mockImplementation(emptyIpcInvoke);
  useRepo.setState({ summary, remotes: [origin] });
  useAccounts.setState({ accounts: [], providerTokens: {}, forgeAuth: [], accountsError: null, repoBindingKey: null });
  useUi.setState({ confirm: null, accountsConnectIntent: null, accountsConnectReason: null });
});

describe("CredentialEntryForm (Git Credential Manager / helper)", () => {
  it("shows the backend's message inline and keeps the token", async () => {
    ipc({ approve_https_credential: { kind: "auth", code: "noCredentialHelper", message: "No Git credential helper is configured on this computer." } });
    render(<CredentialEntryForm provider="github" usernameHint="Siomkin" />);

    fireEvent.change(screen.getByPlaceholderText(/Personal access token/), { target: { value: "ghp_new" } });
    fireEvent.click(screen.getByRole("button", { name: "Save credential" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("No Git credential helper is configured");
    expect(screen.getByPlaceholderText(/Personal access token/)).toHaveValue("ghp_new");
  });

  it("forgets the username another helper returned, then saves again", async () => {
    ipc({ approve_https_credential: (n: number) => (n === 1 ? shadowed : { username: "Siomkin", helper: "Memory cache" }) });
    render(<CredentialEntryForm provider="github" usernameHint="Siomkin" />);

    fireEvent.change(screen.getByPlaceholderText(/Personal access token/), { target: { value: "ghp_new" } });
    fireEvent.click(screen.getByRole("button", { name: "Save credential" }));
    fireEvent.click(await screen.findByRole("button", { name: "Forget @x-access-token and save again" }));
    confirmNow();

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("reject_https_credential", {
        credentialHost: "github.com",
        path: null,
        username: "x-access-token",
      }),
    );
    await waitFor(() =>
      expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "approve_https_credential")).toHaveLength(2),
    );
    expect(await screen.findByText(/accepted it/)).toBeInTheDocument();
  });

  it("warns about a password on github.com but keeps Save enabled", () => {
    render(<CredentialEntryForm provider="github" usernameHint="Siomkin" />);

    fireEvent.change(screen.getByPlaceholderText(/Personal access token/), { target: { value: "hunter2" } });

    expect(screen.getByText(/doesn't look like a GitHub token/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save credential" })).toBeEnabled();
    expect(screen.getByText(/exact username in the remote URL, including case/)).toBeInTheDocument();
  });
});

describe("GithubTokenForm", () => {
  it("prefills the remote's username, saves a GitLane token and reports the check", async () => {
    render(<GithubTokenForm />);
    expect(screen.getByLabelText("GitHub username")).toHaveValue("Siomkin");

    fireEvent.change(screen.getByLabelText("Personal access token"), { target: { value: "ghp_new" } });
    fireEvent.click(screen.getByRole("button", { name: "Save token" }));

    expect(await screen.findByText(/accepted it/)).toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith("save_provider_token", expect.objectContaining({ provider: "github", host: "github.com" }));
    expect(screen.getByLabelText("Personal access token")).toHaveValue("");
  });

  it("removes a token the remote refuses and keeps it in the field", async () => {
    ipc({ check_remote_access: { kind: "auth", code: "credentialsMissing", message: "Authentication failed" } });
    render(<GithubTokenForm />);

    fireEvent.change(screen.getByLabelText("Personal access token"), { target: { value: "ghp_bad" } });
    fireEvent.click(screen.getByRole("button", { name: "Save token" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("did not accept this token");
    expect(invokeMock).toHaveBeenCalledWith("delete_provider_token", expect.objectContaining({ provider: "github" }));
    expect(screen.getByLabelText("Personal access token")).toHaveValue("ghp_bad");
  });

  it("offers the credential helper when the keychain is unavailable", async () => {
    ipc({ save_provider_token: { kind: "internal", code: "keychain", message: "Could not save the token to the keychain" } });
    render(<GithubTokenForm />);

    fireEvent.change(screen.getByLabelText("Personal access token"), { target: { value: "ghp_new" } });
    fireEvent.click(screen.getByRole("button", { name: "Save token" }));
    expect(await screen.findByText(/could not store the token in your system keychain/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save with Git credential helper instead" }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("approve_https_credential", expect.objectContaining({ password: "ghp_new" })), // ggignore: test fixture
    );
  });

  it("saves for a GitHub Enterprise Server host the user enters", async () => {
    const ghes = "https://ada@github.corp.example/team/repo.git";
    useRepo.setState({ summary, remotes: [{ ...origin, fetchUrl: ghes, pushUrl: ghes }] });
    render(<GithubTokenForm />);

    fireEvent.change(screen.getByLabelText("GitHub host"), { target: { value: "github.corp.example" } });
    fireEvent.change(screen.getByLabelText("GitHub username"), { target: { value: "ada" } });
    fireEvent.change(screen.getByLabelText("Personal access token"), { target: { value: "tok" } });
    fireEvent.click(screen.getByRole("button", { name: "Save token" }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("save_provider_token", expect.objectContaining({ host: "github.corp.example", login: "ada" })),
    );
    // Checked against the GHES remote with the new token.
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "check_remote_access",
        expect.objectContaining({ auth: expect.objectContaining({ mode: "providerToken", credentialHost: "github.corp.example" }) }),
      ),
    );
  });

  it("shows a failed forget inline instead of a hidden toast", async () => {
    ipc({
      save_provider_token: { kind: "internal", code: "keychain", message: "keychain" },
      approve_https_credential: shadowed,
      reject_https_credential: { kind: "git", message: "GCM could not erase" },
    });
    render(<GithubTokenForm />);

    fireEvent.change(screen.getByLabelText("Personal access token"), { target: { value: "ghp_new" } });
    fireEvent.click(screen.getByRole("button", { name: "Save token" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save with Git credential helper instead" }));
    fireEvent.click(await screen.findByRole("button", { name: "Forget @x-access-token and save again" }));
    confirmNow();

    expect(await screen.findByText(/could not forget the saved credential for @x-access-token/)).toBeInTheDocument();
  });

  it("says neither storage is available, without terminal commands", async () => {
    ipc({
      save_provider_token: { kind: "internal", code: "keychain", message: "keychain" },
      approve_https_credential: { kind: "auth", code: "noCredentialHelper", message: "No Git credential helper is configured on this computer." },
    });
    render(<GithubTokenForm />);

    fireEvent.change(screen.getByLabelText("Personal access token"), { target: { value: "ghp_new" } });
    fireEvent.click(screen.getByRole("button", { name: "Save token" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save with Git credential helper instead" }));

    expect(await screen.findByText(/neither secure storage nor a Git credential helper/)).toBeInTheDocument();
    expect(screen.getByText(/SSH key/)).toBeInTheDocument();
  });
});

describe("TransportCredentialCard", () => {
  const account = {
    provider: "github" as const,
    credentialHost: "github.com",
    credentialPath: null,
    login: "Siomkin",
    remoteName: "origin",
  };

  it("shows the backend's message and forgets the returned username, not the remote's", async () => {
    ipc({ approve_https_credential: shadowed, list_remotes: [origin] });
    render(<TransportCredentialCard account={account} />);

    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    fireEvent.change(screen.getByPlaceholderText(/Personal access token/), { target: { value: "ghp_new" } });
    fireEvent.click(screen.getByRole("button", { name: "Save credential" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("@x-access-token instead of @Siomkin");
    expect(screen.queryByText(/Credential was not saved/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Forget @x-access-token and save again" }));
    confirmNow();
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("reject_https_credential", expect.objectContaining({ username: "x-access-token" })),
    );
  });

  it("keeps the card's own Forget on the remote's username", () => {
    render(<TransportCredentialCard account={account} />);

    fireEvent.click(screen.getByRole("button", { name: "Forget" }));
    confirmNow();

    expect(invokeMock).toHaveBeenCalledWith("reject_https_credential", expect.objectContaining({ username: "Siomkin" }));
  });
});

describe("GitHub connect view", () => {
  it("opens from Fix authentication on the token form with no terminal instructions", () => {
    useUi.setState({ accountsConnectIntent: "github", accountsConnectReason: "authFailure" });
    render(<AccountsPanel />);

    const cards = screen.getAllByText(/^(Personal access token|GitHub CLI)$/).map((el) => el.textContent);
    expect(cards[0]).toBe("Personal access token");
    expect(screen.queryByText("Prefer the terminal?")).toBeNull();
    expect(screen.queryByText(/gh auth login/)).toBeNull();
  });

  it("offers Create a token on GitHub's token page", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    try {
      useUi.setState({ accountsConnectIntent: "github" });
      render(<AccountsPanel />);

      fireEvent.click(screen.getByRole("button", { name: "Create a token" }));

      expect(open).toHaveBeenCalledWith("https://github.com/settings/tokens", "_blank", "noopener");
    } finally {
      open.mockRestore();
    }
  });

  it("lists a saved GitHub token with a way to remove it", () => {
    useAccounts.setState({
      providerTokens: {
        "github.com\u0000siomkin": { provider: "github", credentialHost: "github.com", accountId: "siomkin", login: "siomkin", savedAt: 0 },
      },
    });
    render(<AccountsPanel />);

    expect(screen.getByText("@siomkin")).toBeInTheDocument();
  });
});
