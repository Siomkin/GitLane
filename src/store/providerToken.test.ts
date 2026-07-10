import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the IPC boundary so provider-token actions run headlessly. `vi.hoisted`
// makes `invokeMock` exist before `vi.mock` (hoisted) references it.
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { useRepo } from "./repo";
import { pickProviderTokenForHost, useAccounts, type StoredProviderToken } from "./accounts";
import { ForgeKind, type RemoteInfo, type RepoForge } from "../lib/api";

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

  it("activates a stored keychain token by host on a bare remote URL — no binding needed (GL-139)", () => {
    // The OAuth activation path the review flagged: token stored, remote URL has
    // NO username, yet transport must still find and use the keychain token.
    const bare: RemoteInfo = {
      name: "origin",
      fetchUrl: "https://gitlab.com/group/repo.git",
      pushUrl: "https://gitlab.com/group/repo.git",
      isDefault: true,
    };
    useRepo.setState({ remotes: [bare] });
    useAccounts.setState({
      providerTokens: {
        "gitlab-oauth": {
          provider: "gitlab",
          credentialHost: "gitlab.com",
          accountId: "42",
          login: "ada",
          transportUsername: "oauth2",
          savedAt: 0,
        },
      },
    });

    expect(useAccounts.getState().transportAuthForRemote("origin")).toMatchObject({
      mode: "providerToken",
      provider: "gitlab",
      credentialHost: "gitlab.com",
      // git is answered as the sentinel, not the human handle.
      username: "oauth2",
      providerAccountId: "42",
    });
  });

  it("prefers the OAuth token over a PAT when both exist for a host (deterministic)", () => {
    const bare: RemoteInfo = {
      name: "origin",
      fetchUrl: "https://gitlab.com/g/r.git",
      pushUrl: "https://gitlab.com/g/r.git",
      isDefault: true,
    };
    useRepo.setState({ remotes: [bare] });
    useAccounts.setState({
      providerTokens: {
        // A PAT saved more recently than the OAuth token — OAuth must still win.
        pat: { provider: "gitlab", credentialHost: "gitlab.com", accountId: "alice", login: "alice", savedAt: 2 },
        oauth: {
          provider: "gitlab",
          credentialHost: "gitlab.com",
          accountId: "42",
          login: "ada",
          transportUsername: "oauth2",
          savedAt: 1,
        },
      },
    });

    expect(useAccounts.getState().transportAuthForRemote("origin")).toMatchObject({
      mode: "providerToken",
      username: "oauth2",
      providerAccountId: "42",
    });
  });

  it("re-signing OAuth as a different account on the same host deletes the orphan first (GL-139)", async () => {
    const results = [
      { provider: "gitlab", host: "gitlab.com", accountId: "1", login: "ada", transportUsername: "oauth2", hasToken: true },
      { provider: "gitlab", host: "gitlab.com", accountId: "2", login: "bob", transportUsername: "oauth2", hasToken: true },
    ];
    let call = 0;
    invokeMock.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === "provider_oauth_sign_in" ? results[call++] : undefined),
    );

    await useAccounts.getState().signInProviderOauth("gitlab", "gitlab.com");
    await useAccounts.getState().signInProviderOauth("gitlab", "gitlab.com");

    // Account A's keychain token is deleted before B overwrites the sentinel-keyed
    // metadata — otherwise A's token is orphaned (no card, reconcile can't find it).
    expect(invokeMock).toHaveBeenCalledWith("delete_provider_token", {
      provider: "gitlab",
      host: "gitlab.com",
      accountId: "1",
    });
    const tokens = Object.values(useAccounts.getState().providerTokens);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ accountId: "2", login: "bob" });
  });

  it("rolls back the replacement when the old token's delete fails — no orphan (GL-139)", async () => {
    const A = { provider: "gitlab", host: "gitlab.com", accountId: "1", login: "ada", transportUsername: "oauth2", hasToken: true };
    const B = { provider: "gitlab", host: "gitlab.com", accountId: "2", login: "bob", transportUsername: "oauth2", hasToken: true };
    let signIn = 0;
    invokeMock.mockImplementation((cmd: string, args: unknown) => {
      if (cmd === "provider_oauth_sign_in") return Promise.resolve([A, B][signIn++]);
      // Deleting account A's token fails; the rollback delete of B succeeds.
      if (cmd === "delete_provider_token")
        return (args as { accountId: string }).accountId === "1"
          ? Promise.reject(new Error("keychain locked"))
          : Promise.resolve(undefined);
      return Promise.resolve(undefined);
    });

    await useAccounts.getState().signInProviderOauth("gitlab", "gitlab.com");
    await expect(useAccounts.getState().signInProviderOauth("gitlab", "gitlab.com")).rejects.toThrow(
      /previous token/,
    );

    // A stays signed in (metadata + token intact); B's just-written token is
    // rolled back — so there is no orphan and no phantom B card.
    const tokens = Object.values(useAccounts.getState().providerTokens);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ accountId: "1", login: "ada" });
    expect(invokeMock).toHaveBeenCalledWith("delete_provider_token", {
      provider: "gitlab",
      host: "gitlab.com",
      accountId: "2",
    });
  });

  it("signInProviderOauth binds the remote to the OAuth sentinel, not the handle (GL-139)", async () => {
    // An OAuth token authenticates git as `oauth2` (GitLab), not the human handle.
    const oauthResult = {
      provider: "gitlab",
      host: "gitlab.com",
      accountId: "42",
      login: "ada",
      transportUsername: "oauth2",
      hasToken: true,
    };
    // After binding, the remote's URL username becomes the sentinel.
    const rebound: RemoteInfo = {
      name: "origin",
      fetchUrl: "https://oauth2@gitlab.com/group/repo.git",
      pushUrl: "https://oauth2@gitlab.com/group/repo.git",
      isDefault: true,
    };
    useRepo.setState({
      summary: { path: "/repo", workdir: "/repo", headBranch: "main", headOid: null, detached: false },
      remotes: [gitlabRemote],
    });
    invokeMock.mockImplementation((cmd: string) =>
      Promise.resolve(
        cmd === "provider_oauth_sign_in" ? oauthResult : cmd === "list_remotes" ? [rebound] : undefined,
      ),
    );

    await useAccounts.getState().signInProviderOauth("gitlab", "gitlab.com", "origin");

    // The sentinel is pinned into the URL — the git-native selector — not @ada.
    expect(invokeMock).toHaveBeenCalledWith("set_remote_username", {
      path: "/repo",
      name: "origin",
      username: "oauth2",
    });
    // Recorded under the sentinel, with the provider account id as the keychain
    // locator and the human handle kept for display.
    expect(useAccounts.getState().hasProviderToken("gitlab.com", "oauth2")).toBe(true);
    const auth = useAccounts.getState().transportAuthForRemote("origin");
    expect(auth).toMatchObject({
      mode: "providerToken",
      provider: "gitlab",
      username: "oauth2",
      providerAccountId: "42",
    });

    // Sign-out by the sentinel deletes the keychain entry by its provider id.
    invokeMock.mockClear();
    invokeMock.mockResolvedValue(undefined);
    await useAccounts.getState().signOutProviderToken("gitlab", "gitlab.com", "oauth2");
    expect(invokeMock).toHaveBeenCalledWith("delete_provider_token", {
      provider: "gitlab",
      host: "gitlab.com",
      accountId: "42",
    });
    expect(useAccounts.getState().hasProviderToken("gitlab.com", "oauth2")).toBe(false);
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

describe("pickProviderTokenForHost", () => {
  const tok = (over: Partial<Record<string, unknown>>) => ({
    provider: "gitlab",
    credentialHost: "gitlab.com",
    accountId: "x",
    login: "x",
    savedAt: 0,
    ...over,
  });

  it("prefers an OAuth token over a more recent PAT, matching host case-insensitively", () => {
    const tokens = {
      pat: tok({ accountId: "pat", login: "pat", credentialHost: "GitLab.com", savedAt: 9 }),
      oauth: tok({ accountId: "oauth", login: "ada", transportUsername: "oauth2", savedAt: 1 }),
      elsewhere: tok({ accountId: "bb", credentialHost: "bitbucket.org", savedAt: 100 }),
    } as never;
    expect(pickProviderTokenForHost(tokens, "gitlab.com")?.accountId).toBe("oauth");
    expect(pickProviderTokenForHost(tokens, "nope.example")).toBeUndefined();
  });

  it("prefers the most recent among PATs when no OAuth token exists", () => {
    const tokens = {
      older: tok({ accountId: "older", savedAt: 1 }),
      newer: tok({ accountId: "newer", savedAt: 2 }),
    } as never;
    expect(pickProviderTokenForHost(tokens, "gitlab.com")?.accountId).toBe("newer");
  });

  it("scopes to the requested provider so a co-hosted token isn't cross-picked (GL-141)", () => {
    const tokens = {
      bb: tok({ provider: "bitbucket", credentialHost: "bitbucket.org", accountId: "bb", savedAt: 2 }),
      other: tok({ provider: "gitea", credentialHost: "bitbucket.org", accountId: "gitea", savedAt: 9 }),
    } as never;
    // Without a provider filter the newer gitea token would win; scoped to
    // "bitbucket" it must pick the Bitbucket one.
    expect(pickProviderTokenForHost(tokens, "bitbucket.org", "bitbucket")?.accountId).toBe("bb");
    expect(pickProviderTokenForHost(tokens, "bitbucket.org", "gitea")?.accountId).toBe("gitea");
    // No filter → host-only match keeps the previous behaviour (newest wins).
    expect(pickProviderTokenForHost(tokens, "bitbucket.org")?.accountId).toBe("gitea");
  });
});

describe("prAccountRef for Bitbucket (GL-141)", () => {
  const bbForge: RepoForge = {
    hasRemote: true,
    kind: ForgeKind.Bitbucket,
    forge: "Bitbucket",
    host: "bitbucket.org",
    webUrl: "https://bitbucket.org/team/app",
  };
  const bbRemote: RemoteInfo = {
    name: "origin",
    fetchUrl: "https://bitbucket.org/team/app.git",
    pushUrl: "https://bitbucket.org/team/app.git",
    isDefault: true,
  };
  const store = (token?: StoredProviderToken) => {
    useRepo.setState({ forge: bbForge, remotes: [bbRemote] });
    useAccounts.setState({
      providerTokens: token ? { [`bitbucket.org\u0000${token.login}`]: token } : {},
    });
  };

  it("returns null when no Bitbucket token is stored (backend then reports sign-in)", () => {
    store();
    expect(useAccounts.getState().prAccountRef()).toBeNull();
  });

  it("returns a native ref whose login is the OAuth sentinel → backend uses Bearer", () => {
    store({
      provider: "bitbucket",
      credentialHost: "bitbucket.org",
      accountId: "uuid-1",
      login: "ada",
      transportUsername: "x-token-auth",
      savedAt: 1,
    });
    expect(useAccounts.getState().prAccountRef()).toEqual({
      provider: "native",
      host: "bitbucket.org",
      accountId: "uuid-1",
      login: "x-token-auth",
    });
  });

  it("returns a native ref whose login is the username → backend uses Basic (API token)", () => {
    store({
      provider: "bitbucket",
      credentialHost: "bitbucket.org",
      accountId: "alice",
      login: "alice",
      savedAt: 1,
    });
    expect(useAccounts.getState().prAccountRef()).toEqual({
      provider: "native",
      host: "bitbucket.org",
      accountId: "alice",
      login: "alice",
    });
  });
});

// The OAuth browser flow is user-length: the user can switch repos while
// authorizing. The remote pin (and a late-cancel rollback's un-pin) must target
// the repo whose picker started the sign-in, never the repo open when the flow
// happens to return (GL-167).
describe("OAuth remote pin stays on the initiating repo (GL-167)", () => {
  const oauthResult = {
    provider: "gitlab",
    host: "gitlab.com",
    accountId: "42",
    login: "ada",
    transportUsername: "oauth2",
    hasToken: true,
  };
  const repoSummary = { path: "/repo", workdir: "/repo", headBranch: "main", headOid: null, detached: false };
  const otherSummary = { path: "/elsewhere", workdir: "/elsewhere", headBranch: "main", headOid: null, detached: false };

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  it("pins the sentinel into the repo that started the sign-in after a mid-flow switch", async () => {
    useRepo.setState({ summary: repoSummary, remotes: [gitlabRemote] });
    const flow = deferred<typeof oauthResult>();
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "provider_oauth_sign_in" ? flow.promise : Promise.resolve(undefined),
    );

    const run = useAccounts.getState().signInProviderOauth("gitlab", "gitlab.com", "origin");
    useRepo.setState({ summary: otherSummary, remotes: [] });
    flow.resolve(oauthResult);
    await run;

    // Pinned into the initiating repo's remote, and no refresh of the new repo.
    expect(invokeMock).toHaveBeenCalledWith("set_remote_username", {
      path: "/repo",
      name: "origin",
      username: "oauth2",
    });
    expect(invokeMock).not.toHaveBeenCalledWith("list_remotes", expect.anything());
    // The account metadata itself is app-global and survives the switch.
    expect(useAccounts.getState().hasProviderToken("gitlab.com", "oauth2")).toBe(true);
  });

  it("rolls back the pin against the repo the sign-in pinned, not the current one", async () => {
    useRepo.setState({ summary: repoSummary, remotes: [gitlabRemote] });
    const flow = deferred<typeof oauthResult>();
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "provider_oauth_sign_in" ? flow.promise : Promise.resolve(undefined),
    );
    const run = useAccounts.getState().signInProviderOauth("gitlab", "gitlab.com", "origin");
    useRepo.setState({ summary: otherSummary, remotes: [] });
    flow.resolve(oauthResult);
    await run;

    invokeMock.mockClear();
    invokeMock.mockResolvedValue(undefined);
    await useAccounts.getState().rollbackProviderOauthSignIn("gitlab", oauthResult, "origin", "alice");

    // The un-pin restores the prior account on the repo the sign-in modified…
    expect(invokeMock).toHaveBeenCalledWith("set_remote_username", {
      path: "/repo",
      name: "origin",
      username: "alice",
    });
    // …the keychain entry is removed, and the current repo is not refreshed.
    expect(invokeMock).toHaveBeenCalledWith("delete_provider_token", {
      provider: "gitlab",
      host: "gitlab.com",
      accountId: "42",
    });
    expect(invokeMock).not.toHaveBeenCalledWith("list_remotes", expect.anything());
    expect(useAccounts.getState().hasProviderToken("gitlab.com", "oauth2")).toBe(false);
  });

  it("skips the un-pin when the rollback is not for the sign-in that pinned", async () => {
    // The recorded pin is keyed by the signed-in account, not just the remote
    // name — a rollback for a DIFFERENT account (a caller outside the dialog's
    // own late-cancel path) must not strip the pinned repo's remote.
    useRepo.setState({ summary: repoSummary, remotes: [gitlabRemote] });
    invokeMock.mockImplementation((cmd: string) =>
      Promise.resolve(
        cmd === "provider_oauth_sign_in" ? oauthResult : cmd === "list_remotes" ? [gitlabRemote] : undefined,
      ),
    );
    await useAccounts.getState().signInProviderOauth("gitlab", "gitlab.com", "origin");

    invokeMock.mockClear();
    invokeMock.mockResolvedValue(undefined);
    await useAccounts
      .getState()
      .rollbackProviderOauthSignIn("gitlab", { ...oauthResult, accountId: "99" }, "origin", "alice");

    // No un-pin — the pin belongs to account 42's sign-in — while the token
    // removal (keyed by the stored entry) still proceeds.
    expect(invokeMock).not.toHaveBeenCalledWith("set_remote_username", expect.anything());
    expect(invokeMock).toHaveBeenCalledWith("delete_provider_token", {
      provider: "gitlab",
      host: "gitlab.com",
      accountId: "42",
    });
  });

  it("skips the un-pin when the sign-in never pinned a remote", async () => {
    // No repo open at sign-in time → nothing was pinned; a rollback must not
    // strip the username from an unrelated repo's same-named remote.
    useRepo.setState({ summary: null, remotes: [] });
    invokeMock.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === "provider_oauth_sign_in" ? oauthResult : undefined),
    );
    await useAccounts.getState().signInProviderOauth("gitlab", "gitlab.com", "origin");
    expect(invokeMock).not.toHaveBeenCalledWith("set_remote_username", expect.anything());

    useRepo.setState({ summary: otherSummary, remotes: [gitlabRemote] });
    invokeMock.mockClear();
    invokeMock.mockResolvedValue(undefined);
    await useAccounts.getState().rollbackProviderOauthSignIn("gitlab", oauthResult, "origin", "alice");

    expect(invokeMock).not.toHaveBeenCalledWith("set_remote_username", expect.anything());
    expect(invokeMock).toHaveBeenCalledWith("delete_provider_token", {
      provider: "gitlab",
      host: "gitlab.com",
      accountId: "42",
    });
  });
});
