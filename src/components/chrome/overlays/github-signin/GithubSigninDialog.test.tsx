import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

// The dialog subscribes to `github-signin-progress`; capture the handlers so
// tests can drive the checklist. The IPC boundary is mocked at `invoke` level
// (the canonical pattern — see src/test/README.md), so the real api wrappers,
// zod schemas, and accounts store all run.
const { progressListeners, invokeMock } = vi.hoisted(() => ({
  progressListeners: [] as Array<
    (e: { payload: { step: string; code?: string; url?: string } }) => void
  >,
  invokeMock: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    async (
      _event: string,
      cb: (e: { payload: { step: string; code?: string; url?: string } }) => void,
    ) => {
      progressListeners.push(cb);
      return () => {
        const i = progressListeners.indexOf(cb);
        if (i >= 0) progressListeners.splice(i, 1);
      };
    },
  ),
}));

import { GithubSigninDialog } from "./GithubSigninDialog";
import { useAccounts } from "@/store/accounts";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { useNotifications } from "@/store/notifications";

const ghAccount = (login: string) => ({
  provider: "gh",
  host: "github.com",
  accountId: "1001",
  login,
  username: login,
  name: login,
  email: `${login}@users.noreply.github.com`,
  id: 1001,
  active: true,
  healthy: true,
  healthError: "",
});

/** Wire the IPC mock: a controllable github_sign_in plus quiet defaults. */
const arm = (accounts: unknown[] = [ghAccount("octocat")]) => {
  let resolveSignin!: (r: { host: string; login: string }) => void;
  let rejectSignin!: (e: Error) => void;
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === "github_sign_in")
      return new Promise((resolve, reject) => {
        resolveSignin = resolve;
        rejectSignin = reject;
      });
    if (cmd === "cancel_github_sign_in") return undefined;
    if (cmd === "github_accounts") return accounts;
    if (cmd === "list_pull_requests") return [];
    return undefined;
  });
  return {
    resolve: (r: { host: string; login: string }) => resolveSignin(r),
    reject: (e: Error) => rejectSignin(e),
  };
};

const openDialog = () => useUi.setState({ githubSignin: { host: "github.com" } });

const emit = (payload: { step: string; code?: string; url?: string }) =>
  act(() => {
    for (const cb of [...progressListeners]) cb({ payload });
  });

const statuses = () =>
  Array.from(document.querySelectorAll("[data-status]")).map((el) =>
    el.getAttribute("data-status"),
  );

describe("GithubSigninDialog", () => {
  beforeEach(() => {
    progressListeners.length = 0;
    invokeMock.mockReset();
    useUi.setState({ githubSignin: null });
    useNotifications.setState({ toasts: [] });
    useAccounts.setState({ accounts: [] });
    useRepo.setState({ summary: null });
  });

  it("runs the device flow: code arrives, checklist ticks, success offers nothing without a repo", async () => {
    const signin = arm();
    openDialog();
    render(<GithubSigninDialog />);

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(progressListeners.length).toBe(1));
    // Before any milestone every row is pending — nothing may claim the code
    // was copied while we're still requesting it.
    expect(screen.getByText("Requesting a one-time code…")).toBeInTheDocument();
    expect(statuses()).toEqual(["pending", "pending", "pending", "pending"]);

    emit({ step: "code", code: "1A2B-3C4D", url: "https://github.com/login/device" });
    expect(screen.getByText("1A2B-3C4D")).toBeInTheDocument();
    expect(statuses()).toEqual(["done", "active", "pending", "pending"]);

    emit({ step: "browser" });
    emit({ step: "authorized" });
    expect(statuses()).toEqual(["done", "done", "done", "active"]);

    await act(async () => signin.resolve({ host: "github.com", login: "octocat" }));
    // No open repo in this test, so the success screen has no bind offer.
    await waitFor(() => expect(screen.getByText(/Signed in as/)).toBeInTheDocument());
    expect(screen.getByText("@octocat")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Use for this repo" })).toBeNull();
  });

  it("cancel returns to configure immediately and kills the child", async () => {
    const signin = arm();
    openDialog();
    render(<GithubSigninDialog />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(progressListeners.length).toBe(1));

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    // Back on configure without waiting for the killed child's rejection…
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith("cancel_github_sign_in");
    // …and the eventual rejection stays a cancel, not an error screen.
    await act(async () => signin.reject(new Error("killed")));
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.queryByText("Sign-in didn’t finish")).toBeNull();
  });

  it("a cancel racing the authorization lands as a toast, never the success screen", async () => {
    const signin = arm();
    openDialog();
    render(<GithubSigninDialog />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(progressListeners.length).toBe(1));

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    // The kill was too late — the backend still resolves successfully. The
    // account exists now, so the user must hear that, just not as a success
    // screen they already dismissed.
    await act(async () => signin.resolve({ host: "github.com", login: "octocat" }));
    expect(screen.queryByText(/Signed in as/)).toBeNull();
    await waitFor(() =>
      expect(useNotifications.getState().toasts.slice(-1)[0]?.title).toBe("Signed in as @octocat — the account was added."),
    );
  });

  it("starts a single run on a rapid double-click", async () => {
    const signin = arm();
    openDialog();
    render(<GithubSigninDialog />);

    const button = screen.getByRole("button", { name: "Sign in" });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() =>
      expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "github_sign_in")).toHaveLength(1),
    );
    await act(async () => signin.resolve({ host: "github.com", login: "octocat" }));
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "github_sign_in")).toHaveLength(1);
  });

  it("shows the success screen under StrictMode's dev double-mount", async () => {
    // main.tsx wraps the app in <React.StrictMode>, whose simulated
    // unmount+remount must not leave the run hook believing the dialog is
    // closed (a cleanup-only `mounted` effect would divert every success to a
    // toast and leave the checklist spinning on "Account added" forever).
    const signin = arm();
    openDialog();
    render(
      <React.StrictMode>
        <GithubSigninDialog />
      </React.StrictMode>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(progressListeners.length).toBeGreaterThan(0));

    await act(async () => signin.resolve({ host: "github.com", login: "octocat" }));
    await waitFor(() => expect(screen.getByText(/Signed in as/)).toBeInTheDocument());
    expect(useNotifications.getState().toasts).toHaveLength(0);
  });

  it("offers and performs the repo bind when a repo is open and the login resolves", async () => {
    const signin = arm();
    const setRepoAccount = vi.fn().mockResolvedValue(undefined);
    // An open repo enables the bind offer; stub the bind action so we assert it's
    // called with the resolved account's id (loadAccounts populated the list).
    useRepo.setState({ summary: { path: "/work/repo" } as never });
    useAccounts.setState({ setRepoAccount });
    openDialog();
    render(<GithubSigninDialog />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(progressListeners.length).toBeGreaterThan(0));

    await act(async () => signin.resolve({ host: "github.com", login: "octocat" }));
    const bind = await screen.findByRole("button", { name: "Use for this repo" });
    fireEvent.click(bind);
    await waitFor(() => expect(setRepoAccount).toHaveBeenCalledTimes(1));
    // Bound to the exact account id from the refreshed list, then dialog closes.
    const boundId = useAccounts
      .getState()
      .accounts.find((a) => a.login === "octocat")?.id;
    expect(setRepoAccount).toHaveBeenCalledWith(boundId);
    expect(useUi.getState().githubSignin).toBeNull();
  });

  it("suppresses the bind offer when the login could not be resolved", async () => {
    // Two accounts on the host — an unresolved login must not fall back to
    // either of them (it could bind the wrong one).
    const signin = arm([ghAccount("octocat"), { ...ghAccount("work-bot"), active: false }]);
    openDialog();
    render(<GithubSigninDialog />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(progressListeners.length).toBe(1));

    await act(async () => signin.resolve({ host: "github.com", login: "" }));
    await waitFor(() => expect(screen.getByText("Signed in to github.com")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Use for this repo" })).toBeNull();
  });

  it("closing from inside Settings closes only the sign-in dialog", () => {
    arm();
    useUi.setState({ settingsOpen: true, githubSignin: { host: "github.com" } });
    render(<GithubSigninDialog />);

    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));

    expect(useUi.getState().githubSignin).toBeNull();
    expect(useUi.getState().settingsOpen).toBe(true);
  });
});
