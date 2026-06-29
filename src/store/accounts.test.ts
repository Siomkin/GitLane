import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import type { RepoSummary } from "../lib/api";
import { useRepo } from "./repo";
import { useAccounts, type Account } from "./accounts";

const path = "repo-under-test";
const summary: RepoSummary = { path, workdir: path, headBranch: "main", headOid: "abc", detached: false };

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
};

const identityCmds = (calls: unknown[][]) =>
  calls.filter(([cmd]) => cmd === "set_repo_identity" || cmd === "clear_repo_identity");

beforeEach(() => {
  localStorage.clear();
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(null);
  useRepo.setState({ summary });
  useAccounts.setState({ accounts: [account], repoAccountId: null, repoAccountRef: null, repoIdentity: null });
});

describe("setRepoAccount — Tier 2 binding never touches commit identity", () => {
  it("binds the account without writing user.name/user.email", async () => {
    await useAccounts.getState().setRepoAccount(account.id);
    expect(useAccounts.getState().repoAccountId).toBe(account.id);
    expect(useAccounts.getState().repoAccountRef).toEqual(account.ref);
    // The decoupled path must not write or clear the commit identity.
    expect(identityCmds(invokeMock.mock.calls)).toHaveLength(0);
  });

  it("unbinding (null) does not clear the applied profile's identity", async () => {
    await useAccounts.getState().setRepoAccount(account.id);
    invokeMock.mockClear();
    await useAccounts.getState().setRepoAccount(null);
    expect(useAccounts.getState().repoAccountId).toBeNull();
    expect(identityCmds(invokeMock.mock.calls)).toHaveLength(0);
  });
});
