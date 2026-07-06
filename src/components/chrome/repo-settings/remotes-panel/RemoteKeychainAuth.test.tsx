import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

// The component only reads/dispatches the account store; no IPC of its own, but
// the store module pulls in the api layer, so stub the IPC boundary.
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { useAccounts } from "@/store/accounts";
import type { ForgeAuthProvider } from "@/lib/api";
import { RemoteKeychainAuth } from "./RemoteKeychainAuth";

type SaveFn = (remote: string, login: string, token: string) => Promise<void>;
type SignOutFn = (provider: ForgeAuthProvider, credentialHost: string, login: string) => Promise<void>;
type ForgetFn = (
  credentialHost: string,
  path: string | null,
  username: string,
  provider?: ForgeAuthProvider,
) => Promise<void>;

const remote = (over: Partial<{ name: string; fetchUrl: string; pushUrl: string }> = {}) => ({
  name: "origin",
  fetchUrl: "https://gitlab.com/group/repo.git",
  pushUrl: "https://gitlab.com/group/repo.git",
  ...over,
});

const bound = (url: string) => remote({ fetchUrl: url, pushUrl: url });

let saveRemoteProviderToken: Mock<SaveFn>;
let signOutProviderToken: Mock<SignOutFn>;
let forgetHttpsCredential: Mock<ForgetFn>;

beforeEach(() => {
  invokeMock.mockReset();
  saveRemoteProviderToken = vi.fn<SaveFn>().mockResolvedValue(undefined);
  signOutProviderToken = vi.fn<SignOutFn>().mockResolvedValue(undefined);
  forgetHttpsCredential = vi.fn<ForgetFn>().mockResolvedValue(undefined);
  useAccounts.setState({
    providerTokens: {},
    saveRemoteProviderToken,
    signOutProviderToken,
    forgetHttpsCredential,
  });
});

const tokenEntry = (over: Record<string, unknown> = {}) => ({
  provider: "gitlab" as ForgeAuthProvider,
  credentialHost: "gitlab.com",
  accountId: "alice",
  login: "alice",
  savedAt: 0,
  ...over,
});

describe("RemoteKeychainAuth", () => {
  it("renders nothing for an SSH remote (auth is the SSH key)", () => {
    const { container } = render(<RemoteKeychainAuth remote={bound("git@gitlab.com:group/repo.git")} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing for a GitHub remote (gh owns that auth)", () => {
    const { container } = render(<RemoteKeychainAuth remote={bound("https://github.com/me/repo.git")} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing for an unclassified host (no keychain provider)", () => {
    const { container } = render(<RemoteKeychainAuth remote={bound("https://git.internal.example/team/app.git")} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("stores a token via the remote-scoped action for a classified non-GitHub remote", async () => {
    render(<RemoteKeychainAuth remote={remote()} />);

    // A bare URL has no username, so the store button stays disabled until both
    // fields are filled.
    const store = screen.getByRole("button", { name: "Store in keychain" });
    expect(store).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText("Account username"), { target: { value: "alice" } });
    fireEvent.change(screen.getByPlaceholderText("Personal access token"), {
      target: { value: "glpat-secret" },
    });
    expect(store).toBeEnabled();
    fireEvent.click(store);

    // Remote-scoped: pins @alice into the URL AND stores the token (the fix for
    // the earlier high-severity finding).
    await waitFor(() =>
      expect(saveRemoteProviderToken).toHaveBeenCalledWith("origin", "alice", "glpat-secret"),
    );
  });

  it("shows the signed-in state and signs out when a token is stored", async () => {
    // The URL carries @alice, so the component resolves the stored token.
    useAccounts.setState({ providerTokens: { any: tokenEntry() } });
    render(<RemoteKeychainAuth remote={bound("https://alice@gitlab.com/group/repo.git")} />);

    expect(screen.getByText("@alice")).toBeInTheDocument();
    // The store form is replaced by the signed-in row.
    expect(screen.queryByPlaceholderText("Personal access token")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() =>
      expect(signOutProviderToken).toHaveBeenCalledWith("gitlab", "gitlab.com", "alice"),
    );
  });

  it("forgets a saved Git-helper credential (distinct verb) at host scope for GitLab", async () => {
    render(<RemoteKeychainAuth remote={bound("https://alice@gitlab.com/group/repo.git")} />);
    fireEvent.click(screen.getByRole("button", { name: "Forget saved credential" }));
    // GitLab scopes by host (null path), and it's reject_https_credential — not a
    // keychain sign-out.
    await waitFor(() =>
      expect(forgetHttpsCredential).toHaveBeenCalledWith("gitlab.com", null, "alice", "gitlab"),
    );
    expect(signOutProviderToken).not.toHaveBeenCalled();
  });

  it("forgets an Azure credential at org scope (GL-136)", async () => {
    render(
      <RemoteKeychainAuth remote={bound("https://contoso@dev.azure.com/contoso/proj/_git/repo")} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Forget saved credential" }));
    // Azure scopes by org, not the repo path.
    await waitFor(() =>
      expect(forgetHttpsCredential).toHaveBeenCalledWith(
        "dev.azure.com",
        "contoso",
        "contoso",
        "azure-devops",
      ),
    );
  });
});
