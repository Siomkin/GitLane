// The GL-129 legacy-binding migration. The planner is pure (no IPC/Zustand);
// the shell tests mock the IPC boundary + stores to pin the failure semantics:
// a failed write must NOT collapse the v3 map (the migration retries later).
import { beforeEach, describe, expect, it, vi } from "vitest";

const setRemoteUsername = vi.hoisted(() => vi.fn(async () => {}));
const listRemotes = vi.hoisted(() => vi.fn(async () => {}));
const showToast = vi.hoisted(() => vi.fn());

vi.mock("../lib/api", () => ({ api: { setRemoteUsername } }));
vi.mock("./repo", () => ({ useRepo: { getState: () => ({ listRemotes }) } }));
vi.mock("./ui", () => ({ useUi: { getState: () => ({ showToast }) } }));

import type { GithubAccountRef, RemoteInfo } from "../lib/api";
import { accountKey, type BindableAccount } from "./accountBindings";
import { readBindings, writeBindings } from "./accountsStorage";
import {
  migrateStoredRemoteUsernames,
  planRemoteUsernameMigration,
} from "./accountsMigrations";

const ref: GithubAccountRef = { provider: "gh", host: "github.com", accountId: "1001", login: "alice" };
const alice: BindableAccount = {
  id: accountKey(ref),
  provider: ref.provider,
  host: ref.host,
  accountId: ref.accountId,
  login: ref.login,
  username: ref.login,
  ref,
};

const remote = (over: Partial<RemoteInfo> = {}): RemoteInfo => ({
  name: "origin",
  fetchUrl: "https://github.com/owner/repo.git",
  pushUrl: "https://github.com/owner/repo.git",
  isDefault: true,
  ...over,
});

beforeEach(() => {
  localStorage.clear();
  setRemoteUsername.mockClear();
  setRemoteUsername.mockImplementation(async () => {});
  listRemotes.mockClear();
  showToast.mockClear();
});

describe("planRemoteUsernameMigration", () => {
  it("plans a v2 default-remote write onto a bare HTTPS URL", () => {
    const plan = planRemoteUsernameMigration({ version: 2, ...ref }, [remote()], [alice], "origin");
    expect(plan).toEqual({
      writes: [{ remote: "origin", username: "alice" }],
      collapseV3: false,
      nextEntry: { version: 2, ...ref },
    });
  });

  it("never overwrites a username git config already has", () => {
    const plan = planRemoteUsernameMigration(
      { version: 2, ...ref },
      [remote({ fetchUrl: "https://bob@github.com/owner/repo.git", pushUrl: "https://bob@github.com/owner/repo.git" })],
      [alice],
      "origin",
    );
    expect(plan?.writes).toEqual([]);
  });

  it("skips SSH remotes (accounts ride the SSH key, not the URL)", () => {
    const plan = planRemoteUsernameMigration(
      { version: 2, ...ref },
      [remote({ fetchUrl: "git@github.com:owner/repo.git", pushUrl: "git@github.com:owner/repo.git" })],
      [alice],
      "origin",
    );
    expect(plan?.writes).toEqual([]);
  });

  it("returns null when there is nothing to migrate or it cannot yet resolve", () => {
    expect(planRemoteUsernameMigration(undefined, [remote()], [alice], "origin")).toBeNull();
    expect(planRemoteUsernameMigration({ version: 2, ...ref }, [], [alice], "origin")).toBeNull();
    // v3 before the account list loads → wait, don't guess.
    expect(
      planRemoteUsernameMigration({ version: 3, remotes: { origin: ref } }, [remote()], [], "origin"),
    ).toBeNull();
    // v3 with an unresolved binding → wait, a missing account must not switch identity.
    expect(
      planRemoteUsernameMigration({ version: 3, remotes: { origin: "carol" } }, [remote()], [alice], "origin"),
    ).toBeNull();
  });

  it("collapses a v3 map to the default remote's v2 PR entry", () => {
    const plan = planRemoteUsernameMigration(
      { version: 3, remotes: { origin: ref, fork: { unbound: true } } },
      [remote(), remote({ name: "fork", isDefault: false })],
      [alice],
      "origin",
    );
    expect(plan).toEqual({
      writes: [{ remote: "origin", username: "alice" }],
      collapseV3: true,
      nextEntry: { version: 2, ...ref },
    });
  });
});

describe("migrateStoredRemoteUsernames", () => {
  it("collapses a no-write v3 map without touching git config", async () => {
    // The remote URL already carries the bound login → nothing to write.
    writeBindings({ "/repo": { version: 3, remotes: { origin: ref } } });
    await migrateStoredRemoteUsernames(
      "/repo",
      "/repo",
      { version: 3, remotes: { origin: ref } },
      [remote({ fetchUrl: "https://alice@github.com/owner/repo.git", pushUrl: "https://alice@github.com/owner/repo.git" })],
      [alice],
      "origin",
    );
    expect(setRemoteUsername).not.toHaveBeenCalled();
    expect(readBindings()["/repo"]).toEqual({ version: 2, ...ref });
  });

  it("writes the username, then collapses and refreshes remotes", async () => {
    writeBindings({ "/repo": { version: 3, remotes: { origin: ref } } });
    await migrateStoredRemoteUsernames(
      "/repo",
      "/repo",
      { version: 3, remotes: { origin: ref } },
      [remote()],
      [alice],
      "origin",
    );
    expect(setRemoteUsername).toHaveBeenCalledWith("/repo", "origin", "alice");
    expect(readBindings()["/repo"]).toEqual({ version: 2, ...ref });
    expect(listRemotes).toHaveBeenCalled();
  });

  it("keeps the v3 map when the IPC write fails, so the migration can retry", async () => {
    writeBindings({ "/repo": { version: 3, remotes: { origin: ref } } });
    setRemoteUsername.mockImplementation(async () => {
      throw new Error("git config failed");
    });
    await migrateStoredRemoteUsernames(
      "/repo",
      "/repo",
      { version: 3, remotes: { origin: ref } },
      [remote()],
      [alice],
      "origin",
    );
    expect(readBindings()["/repo"]).toEqual({ version: 3, remotes: { origin: ref } });
    expect(listRemotes).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith("Error: git config failed", "error");
  });
});
