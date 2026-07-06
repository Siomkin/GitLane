import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the IPC boundary so provider-token actions run headlessly. `vi.hoisted`
// makes `invokeMock` exist before `vi.mock` (hoisted) references it.
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { useRepo } from "./repo";
import { useAccounts } from "./accounts";
import type { RemoteInfo } from "../lib/api";

const gitlabRemote: RemoteInfo = {
  name: "origin",
  fetchUrl: "https://alice@gitlab.com/group/repo.git",
  pushUrl: "https://alice@gitlab.com/group/repo.git",
  isDefault: true,
};

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
  localStorage.clear();
  // A clean account store: no gh accounts, no stored tokens.
  useAccounts.setState({ accounts: [], forgeAuth: [], providerTokens: {} });
  useRepo.setState({ remotes: [gitlabRemote] });
});

describe("provider-token transport auth (GL-132)", () => {
  it("falls back to the credential helper when no token is stored", () => {
    const auth = useAccounts.getState().transportAuthForRemote("origin");
    expect(auth).toMatchObject({
      mode: "credentialHelper",
      provider: "gitlab",
      credentialHost: "gitlab.com",
      username: "alice",
    });
    // No GitLane-owned locator when the helper owns the credential.
    expect(auth?.providerAccountId ?? null).toBeNull();
  });

  it("saveRemoteProviderToken pins the username so a bare-URL remote uses the token (review #1)", async () => {
    // A bare URL with no @user — the common case. Before the fix, storing a
    // token left transport on the credential helper because there was no account
    // selector in the URL.
    const bare: RemoteInfo = {
      name: "origin",
      fetchUrl: "https://gitlab.com/group/repo.git",
      pushUrl: "https://gitlab.com/group/repo.git",
      isDefault: true,
    };
    useRepo.setState({
      summary: { path: "/repo", workdir: "/repo", headBranch: "main", headOid: null, detached: false },
      remotes: [bare],
    });
    // No account selector yet → nothing to authenticate as.
    expect(useAccounts.getState().transportAuthForRemote("origin")).toBeNull();

    // After pinning, the reloaded remote carries @alice in its URL.
    const pinned: RemoteInfo = {
      ...bare,
      fetchUrl: "https://alice@gitlab.com/group/repo.git",
      pushUrl: "https://alice@gitlab.com/group/repo.git",
    };
    invokeMock.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === "list_remotes" ? [pinned] : undefined),
    );

    await useAccounts.getState().saveRemoteProviderToken("origin", "alice", "glpat-secret");

    // Token stored in the keychain AND the username pinned into the URL.
    expect(invokeMock).toHaveBeenCalledWith(
      "save_provider_token",
      expect.objectContaining({ provider: "gitlab", host: "gitlab.com", login: "alice" }),
    );
    expect(invokeMock).toHaveBeenCalledWith("set_remote_username", {
      path: "/repo",
      name: "origin",
      username: "alice",
    });
    // Now transport actually selects the keychain token.
    expect(useAccounts.getState().transportAuthForRemote("origin")).toMatchObject({
      mode: "providerToken",
      provider: "gitlab",
      username: "alice",
      providerAccountId: "alice",
    });
  });

  it("selects providerToken mode once a keychain token is stored", async () => {
    await useAccounts.getState().saveProviderToken("gitlab", "gitlab.com", "alice", "glpat-secret");

    const auth = useAccounts.getState().transportAuthForRemote("origin");
    expect(auth).toMatchObject({
      mode: "providerToken",
      provider: "gitlab",
      host: "gitlab.com",
      credentialHost: "gitlab.com",
      username: "alice",
      // Non-secret keychain locator — never the token.
      providerAccountId: "alice",
    });
    // The ref that crosses IPC carries no token material.
    expect(JSON.stringify(auth)).not.toContain("glpat-secret");
  });

  it("stores the token in the keychain via IPC and keeps no secret in state", async () => {
    await useAccounts.getState().saveProviderToken("gitlab", "gitlab.com", "alice", "glpat-secret");

    expect(invokeMock).toHaveBeenCalledWith("save_provider_token", {
      provider: "gitlab",
      host: "gitlab.com",
      accountId: "alice",
      login: "alice",
      token: "glpat-secret",
    });
    // The persisted metadata + store state never contain the token.
    expect(JSON.stringify(useAccounts.getState().providerTokens)).not.toContain("glpat-secret");
    expect(localStorage.getItem("gitlane.providerTokens")).not.toContain("glpat-secret");
    expect(useAccounts.getState().hasProviderToken("gitlab.com", "alice")).toBe(true);
  });

  it("sign-out deletes the keychain token (distinct from forgetting a helper credential)", async () => {
    await useAccounts.getState().saveProviderToken("gitlab", "gitlab.com", "alice", "glpat-secret");
    invokeMock.mockClear();

    await useAccounts.getState().signOutProviderToken("gitlab", "gitlab.com", "alice");

    expect(invokeMock).toHaveBeenCalledWith("delete_provider_token", {
      provider: "gitlab",
      host: "gitlab.com",
      accountId: "alice",
    });
    // The token is gone → transport reverts to the credential helper.
    expect(useAccounts.getState().hasProviderToken("gitlab.com", "alice")).toBe(false);
    expect(useAccounts.getState().transportAuthForRemote("origin")?.mode).toBe("credentialHelper");
  });

  it("selects providerToken for a self-hosted Gitea remote (GL-137)", async () => {
    const gitea: RemoteInfo = {
      name: "origin",
      fetchUrl: "https://bob@gitea.example.test:8443/team/app.git",
      pushUrl: "https://bob@gitea.example.test:8443/team/app.git",
      isDefault: true,
    };
    useRepo.setState({ remotes: [gitea] });
    await useAccounts.getState().saveProviderToken("gitea", "gitea.example.test:8443", "bob", "tok");

    expect(useAccounts.getState().transportAuthForRemote("origin")).toMatchObject({
      mode: "providerToken",
      provider: "gitea",
      // Custom port preserved in the credential authority (GL-137).
      credentialHost: "gitea.example.test:8443",
      username: "bob",
      providerAccountId: "bob",
    });
  });

  it("selects providerToken for an Azure DevOps remote (GL-136)", async () => {
    const azure: RemoteInfo = {
      name: "origin",
      fetchUrl: "https://contoso@dev.azure.com/contoso/proj/_git/repo",
      pushUrl: "https://contoso@dev.azure.com/contoso/proj/_git/repo",
      isDefault: true,
    };
    useRepo.setState({ remotes: [azure] });
    await useAccounts.getState().saveProviderToken("azure-devops", "dev.azure.com", "contoso", "pat");

    expect(useAccounts.getState().transportAuthForRemote("origin")).toMatchObject({
      mode: "providerToken",
      provider: "azure-devops",
      credentialHost: "dev.azure.com",
      username: "contoso",
    });
  });

  it("reconciles away metadata whose keychain secret vanished externally (review #4)", async () => {
    await useAccounts.getState().saveProviderToken("gitlab", "gitlab.com", "alice", "glpat-secret");
    expect(useAccounts.getState().hasProviderToken("gitlab.com", "alice")).toBe(true);

    // Backend reports the keychain no longer has the token (deleted outside GitLane).
    invokeMock.mockImplementation((cmd: string) =>
      Promise.resolve(
        cmd === "provider_token_status"
          ? { provider: "gitlab", host: "gitlab.com", accountId: "alice", login: "alice", hasToken: false }
          : undefined,
      ),
    );

    await useAccounts.getState().reconcileProviderTokens();

    expect(useAccounts.getState().hasProviderToken("gitlab.com", "alice")).toBe(false);
    // Transport reverts to the credential helper for the (still @alice) remote.
    expect(useAccounts.getState().transportAuthForRemote("origin")?.mode).toBe("credentialHelper");
  });

  it("keeps metadata when the keychain status check throws (review #4, no false prune)", async () => {
    await useAccounts.getState().saveProviderToken("gitlab", "gitlab.com", "alice", "glpat-secret");
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "provider_token_status" ? Promise.reject("keychain locked") : Promise.resolve(undefined),
    );

    await useAccounts.getState().reconcileProviderTokens();

    // A transient error must never drop a still-valid entry.
    expect(useAccounts.getState().hasProviderToken("gitlab.com", "alice")).toBe(true);
  });

  it("forget-credential erases a Git-helper credential without touching the keychain token", async () => {
    await useAccounts.getState().saveProviderToken("gitlab", "gitlab.com", "alice", "glpat-secret");
    invokeMock.mockClear();

    await useAccounts
      .getState()
      .forgetHttpsCredential("gitlab.com", null, "alice", "gitlab");

    // It hits `reject_https_credential`, NOT `delete_provider_token`.
    expect(invokeMock).toHaveBeenCalledWith("reject_https_credential", {
      credentialHost: "gitlab.com",
      path: null,
      username: "alice",
    });
    expect(invokeMock).not.toHaveBeenCalledWith(
      "delete_provider_token",
      expect.anything(),
    );
    // The GitLane-owned keychain token is untouched.
    expect(useAccounts.getState().hasProviderToken("gitlab.com", "alice")).toBe(true);
  });
});
