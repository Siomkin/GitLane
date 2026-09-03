// The backend caches its git / gh / glab / origin probes until told otherwise.
// These tests pin that the stores tell it *before* the operation that may
// depend on a freshly installed tool — the "install gh after launch, then retry
// the PR list / add an account" scenario of the `ipc/commands` spec.
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { ForgeKind, type RepoForge, type RepoSummary } from "@/lib/api";
import { useAccounts, type Account } from "./accounts";
import { usePulls } from "./pulls";
import { useRepo } from "./repo";
import { refreshToolProbes } from "./toolProbes";

const summary: RepoSummary = {
  path: "/repo",
  workdir: "/repo",
  headBranch: "main",
  headOid: "abc",
  detached: false,
};
const github: RepoForge = {
  hasRemote: true,
  kind: ForgeKind.GitHub,
  forge: "GitHub",
  host: "github.com",
  webUrl: "https://github.com/o/r",
};
const account: Account = {
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

const commands = () => invokeMock.mock.calls.map(([cmd]) => cmd as string);

/** `first` was invoked, and before `second`. */
function expectInvokedBefore(first: string, second: string) {
  const order = commands();
  const a = order.indexOf(first);
  const b = order.indexOf(second);
  expect(a, `${first} not invoked in ${order.join(", ")}`).toBeGreaterThanOrEqual(0);
  expect(b, `${second} not invoked in ${order.join(", ")}`).toBeGreaterThanOrEqual(0);
  expect(a, `${first} must run before ${second}`).toBeLessThan(b);
}

beforeEach(() => {
  localStorage.clear();
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (cmd: string) => {
    if (["list_pull_requests", "repository_stacks", "github_accounts"].includes(cmd)) return [];
    if (cmd === "github_sign_in") return { host: "github.com", login: "octocat" };
    return null;
  });
  usePulls.getState().reset();
  useRepo.setState({ summary, forge: github, remotes: [] });
  useAccounts.setState({ accounts: [account], providerTokens: {} });
});

describe("refreshToolProbes", () => {
  it("is best-effort: a backend failure resolves so the caller's operation still runs", async () => {
    invokeMock.mockRejectedValueOnce(new Error("no such command"));
    await expect(refreshToolProbes()).resolves.toBeUndefined();
    expect(commands()).toEqual(["refresh_tool_probes"]);
  });
});

describe("PR-list retry re-probes the CLIs first", () => {
  it("invokes refresh_tool_probes before list_pull_requests", async () => {
    await usePulls.getState().refreshPullRequests();
    expectInvokedBefore("refresh_tool_probes", "list_pull_requests");
  });

  it("still loads the list when the refresh itself fails", async () => {
    invokeMock.mockRejectedValueOnce(new Error("boom"));
    await usePulls.getState().refreshPullRequests();
    expect(commands()).toContain("list_pull_requests");
    expect(usePulls.getState().prError).toBeNull();
  });
});

describe("account add/remove re-probe the CLIs first", () => {
  it("GitHub sign-in", async () => {
    await useAccounts.getState().signInGithub("github.com");
    expectInvokedBefore("refresh_tool_probes", "github_sign_in");
  });

  it("GitHub sign-out", async () => {
    await useAccounts.getState().signOutGithub(account);
    expectInvokedBefore("refresh_tool_probes", "github_sign_out");
  });

  it("provider token sign-in", async () => {
    await useAccounts.getState().saveProviderToken("gitlab", "gitlab.com", "alice", "token");
    expectInvokedBefore("refresh_tool_probes", "save_provider_token");
  });

  it("provider token sign-out", async () => {
    await useAccounts.getState().signOutProviderToken("gitlab", "gitlab.com", "alice");
    expectInvokedBefore("refresh_tool_probes", "delete_provider_token");
  });

  it("the Accounts panel's explicit forge refresh, but not the passive load", async () => {
    await useAccounts.getState().loadForgeAuth();
    expect(commands()).not.toContain("refresh_tool_probes");
    invokeMock.mockClear();
    await useAccounts.getState().loadForgeAuth(true);
    expectInvokedBefore("refresh_tool_probes", "forge_auth_statuses");
  });
});
