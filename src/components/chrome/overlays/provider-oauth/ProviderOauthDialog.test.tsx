import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

// The dialog subscribes to `provider-oauth-progress`; capture the handlers so
// tests can drive the checklist. The IPC boundary is mocked at `invoke` level
// (the canonical pattern), so the real api wrappers and accounts store run.
type Progress = {
  provider: string;
  step: string;
  userCode?: string;
  verificationUri?: string;
  expiresInSecs?: number;
};
const { progressListeners, invokeMock } = vi.hoisted(() => ({
  progressListeners: [] as Array<(e: { payload: Progress }) => void>,
  invokeMock: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_event: string, cb: (e: { payload: Progress }) => void) => {
    progressListeners.push(cb);
    return () => {
      const i = progressListeners.indexOf(cb);
      if (i >= 0) progressListeners.splice(i, 1);
    };
  }),
}));
// Auto-opening the verification/authorize page must not hit jsdom's window.open.
vi.mock("@/lib/openExternal", () => ({ openExternalUrl: vi.fn() }));

import { ProviderOauthDialog } from "./ProviderOauthDialog";
import { openExternalUrl } from "@/lib/openExternal";
import { useUi } from "@/store/ui";
import { useNotifications } from "@/store/notifications";
import { useRepo } from "@/store/repo";
import { useAccounts } from "@/store/accounts";

const result = (over: Record<string, unknown> = {}) => ({
  provider: "gitlab",
  host: "gitlab.com",
  accountId: "42",
  login: "ada",
  transportUsername: "oauth2",
  hasToken: true,
  ...over,
});

const arm = () => {
  let resolveSignin!: (r: unknown) => void;
  let rejectSignin!: (e: Error) => void;
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === "provider_oauth_sign_in")
      return new Promise((resolve, reject) => {
        resolveSignin = resolve;
        rejectSignin = reject;
      });
    if (cmd === "cancel_provider_oauth_sign_in") return undefined;
    return undefined;
  });
  return {
    resolve: (r: unknown) => resolveSignin(r),
    reject: (e: Error) => rejectSignin(e),
  };
};

const openDialog = (over: Record<string, unknown> = {}) =>
  useUi.setState({ providerOauthSignin: { provider: "gitlab", host: "gitlab.com", ...over } as never });

const emit = (payload: Progress) =>
  act(() => {
    for (const cb of [...progressListeners]) cb({ payload });
  });

const statuses = () =>
  Array.from(document.querySelectorAll("[data-status]")).map((el) => el.getAttribute("data-status"));

describe("ProviderOauthDialog", () => {
  beforeEach(() => {
    progressListeners.length = 0;
    invokeMock.mockReset();
    vi.mocked(openExternalUrl).mockClear();
    useUi.setState({ providerOauthSignin: null });
    useNotifications.setState({ toasts: [] });
    useRepo.setState({ summary: null });
    useAccounts.setState({ providerTokens: {} });
    localStorage.clear();
  });

  it("runs the GitLab device flow: code arrives, checklist ticks, success", async () => {
    const signin = arm();
    openDialog();
    render(<ProviderOauthDialog />);

    fireEvent.click(screen.getByRole("button", { name: "Sign in to GitLab" }));
    await waitFor(() => expect(progressListeners.length).toBe(1));
    expect(screen.getByText("Requesting a one-time code…")).toBeInTheDocument();
    expect(statuses()).toEqual(["pending", "pending", "pending", "pending"]);

    emit({
      provider: "gitlab",
      step: "device_code",
      userCode: "WXYZ-1234",
      verificationUri: "https://gitlab.com/device",
    });
    expect(screen.getByText("WXYZ-1234")).toBeInTheDocument();
    expect(statuses()).toEqual(["done", "active", "pending", "pending"]);
    // The verification page is opened for the user, once.
    expect(openExternalUrl).toHaveBeenCalledWith("https://gitlab.com/device");

    emit({ provider: "gitlab", step: "polling" });
    emit({ provider: "gitlab", step: "authorized" });
    expect(statuses()).toEqual(["done", "done", "done", "active"]);

    await act(async () => signin.resolve(result()));
    await waitFor(() => expect(screen.getByText("Signed in as @ada")).toBeInTheDocument());
  });

  it("ignores progress from a different provider's flow", async () => {
    const signin = arm();
    openDialog();
    render(<ProviderOauthDialog />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in to GitLab" }));
    await waitFor(() => expect(progressListeners.length).toBe(1));

    emit({ provider: "bitbucket", step: "authorized" }); // stray — must be ignored
    expect(statuses()).toEqual(["pending", "pending", "pending", "pending"]);
    await act(async () => signin.resolve(result()));
  });

  it("cancel returns to configure and cancels the backend flow", async () => {
    const signin = arm();
    openDialog();
    render(<ProviderOauthDialog />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in to GitLab" }));
    await waitFor(() => expect(progressListeners.length).toBe(1));

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Sign in to GitLab" })).toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith("cancel_provider_oauth_sign_in");
    // The eventual rejection stays a cancel, not an error screen.
    await act(async () => signin.reject(new Error("killed")));
    expect(screen.queryByText("Sign-in didn’t finish")).toBeNull();
  });

  it("rolls back the keychain token when the flow finishes after a cancel (late cancel)", async () => {
    const signin = arm();
    openDialog();
    render(<ProviderOauthDialog />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in to GitLab" }));
    await waitFor(() => expect(progressListeners.length).toBe(1));

    // Cancel while in-flight, then the backend flow actually completes and has
    // already persisted a token — the late success must be rolled back.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await act(async () => signin.resolve(result()));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("delete_provider_token", {
        provider: "gitlab",
        host: "gitlab.com",
        accountId: "42",
      }),
    );
    // No orphaned metadata, and no success screen — back at configure.
    await waitFor(() => expect(useAccounts.getState().providerTokens).toEqual({}));
    expect(screen.getByRole("button", { name: "Sign in to GitLab" })).toBeInTheDocument();
    expect(screen.queryByText("Signed in as @ada")).toBeNull();
  });

  it("late cancel leaves a manageable account when the rollback delete fails", async () => {
    // If the rollback's keychain delete fails, the metadata must stay — a
    // visible, sign-out-able KeychainAccountCard beats an invisible orphan.
    let resolveSignin!: (r: unknown) => void;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "provider_oauth_sign_in") return new Promise((r) => (resolveSignin = r));
      if (cmd === "delete_provider_token") return Promise.reject(new Error("keychain locked"));
      return Promise.resolve(undefined);
    });
    openDialog();
    render(<ProviderOauthDialog />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in to GitLab" }));
    await waitFor(() => expect(progressListeners.length).toBe(1));

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await act(async () => resolveSignin(result()));

    // The delete failed, so the account stays recorded and manageable.
    await waitFor(() => expect(Object.values(useAccounts.getState().providerTokens)).toHaveLength(1));
    expect(Object.values(useAccounts.getState().providerTokens)[0]).toMatchObject({
      accountId: "42",
      login: "ada",
    });
  });

  it("late cancel restores a bound remote's prior account (un-pins the sentinel)", async () => {
    // A remote that already authenticates as @alice. An OAuth sign-in bound to it
    // pins the sentinel (oauth2) mid-flow; a late cancel must put @alice back —
    // not leave the remote pinned to a token that was just rolled back.
    useRepo.setState({
      summary: { path: "/repo" } as never,
      remotes: [
        {
          name: "origin",
          fetchUrl: "https://alice@gitlab.com/o/r.git",
          pushUrl: "https://alice@gitlab.com/o/r.git",
          isDefault: true,
        } as never,
      ],
    });
    const setUsername: Array<string | null> = [];
    let resolveSignin!: (r: unknown) => void;
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "provider_oauth_sign_in") return new Promise((r) => (resolveSignin = r));
      if (cmd === "set_remote_username") {
        setUsername.push((args?.username as string | null) ?? null);
        return Promise.resolve("ok");
      }
      if (cmd === "list_remotes") return Promise.resolve(useRepo.getState().remotes);
      return Promise.resolve(undefined);
    });

    openDialog({ remote: "origin" });
    render(<ProviderOauthDialog />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in to GitLab" }));
    await waitFor(() => expect(progressListeners.length).toBe(1));

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await act(async () => resolveSignin(result()));

    // The flow pinned the sentinel, then the cancel restored @alice.
    await waitFor(() => expect(setUsername).toEqual(["oauth2", "alice"]));
    // And the keychain token was rolled back — no orphaned account.
    expect(invokeMock).toHaveBeenCalledWith("delete_provider_token", {
      provider: "gitlab",
      host: "gitlab.com",
      accountId: "42",
    });
    await waitFor(() => expect(useAccounts.getState().providerTokens).toEqual({}));
  });

  it("Bitbucket uses the PKCE checklist (no code box) and opens the authorize page", async () => {
    const signin = arm();
    openDialog({ provider: "bitbucket", host: "bitbucket.org" });
    render(<ProviderOauthDialog />);

    fireEvent.click(screen.getByRole("button", { name: "Sign in to Bitbucket" }));
    await waitFor(() => expect(progressListeners.length).toBe(1));
    // PKCE has three rows and no one-time code box.
    expect(statuses()).toEqual(["pending", "pending", "pending"]);
    expect(screen.queryByText("Requesting a one-time code…")).toBeNull();

    emit({
      provider: "bitbucket",
      step: "browser",
      verificationUri: "https://bitbucket.org/site/oauth2/authorize?x",
    });
    expect(openExternalUrl).toHaveBeenCalledWith("https://bitbucket.org/site/oauth2/authorize?x");
    expect(statuses()).toEqual(["active", "pending", "pending"]);

    emit({ provider: "bitbucket", step: "waiting" });
    expect(statuses()).toEqual(["done", "active", "pending"]);

    await act(async () =>
      signin.resolve(
        result({
          provider: "bitbucket",
          host: "bitbucket.org",
          login: "grace",
          transportUsername: "x-token-auth",
          accountId: "{uuid}",
        }),
      ),
    );
    await waitFor(() => expect(screen.getByText("Signed in as @grace")).toBeInTheDocument());
  });
});
