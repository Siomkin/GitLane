import { afterEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { remotesApi } from "./remotes";
import { repoApi } from "./repo";
import { worktreesApi } from "./worktrees";

afterEach(() => invokeMock.mockReset());

const LOCATOR = "ssh://devbox/srv/app";

describe("paths from a repository opened over SSH", () => {
  it("open_repo's host paths come back as locators", async () => {
    invokeMock.mockResolvedValueOnce({
      path: "/srv/app-wt",
      workdir: "/srv/app-wt/",
      headBranch: "main",
      headOid: "abc",
      detached: false,
      unborn: false,
      isWorktree: true,
      mainPath: "/srv/app",
    });
    const summary = await repoApi.openRepo("ssh://devbox/srv/app-wt");
    expect(invokeMock).toHaveBeenCalledWith("remote_invoke", {
      command: "open_repo",
      args: { path: "ssh://devbox/srv/app-wt" },
    });
    expect(summary.path).toBe("ssh://devbox/srv/app-wt");
    expect(summary.workdir).toBe("ssh://devbox/srv/app-wt/");
    expect(summary.mainPath).toBe(LOCATOR);
  });

  it("a local open_repo is untouched", async () => {
    const local = {
      path: "/r",
      workdir: "/r/",
      headBranch: null,
      headOid: null,
      detached: false,
      unborn: true,
      isWorktree: false,
    };
    invokeMock.mockResolvedValueOnce(local);
    await expect(repoApi.openRepo("/r")).resolves.toEqual(local);
  });

  it("worktree paths come back as locators on the same host", async () => {
    invokeMock.mockResolvedValueOnce([
      { name: "app", path: "/srv/app", branch: "main", isMain: true, bare: false, prunable: false, locked: false },
      { name: "wt", path: "/srv/wt", branch: "feat", isMain: false, bare: false, prunable: false, locked: false },
    ]);
    const worktrees = await worktreesApi.listWorktrees(LOCATOR);
    expect(worktrees.map((w) => w.path)).toEqual([LOCATOR, "ssh://devbox/srv/wt"]);
  });

  it("recents never probe a remote repository on this disk", async () => {
    invokeMock.mockResolvedValueOnce([
      { path: "/local", exists: false, branch: null, isWorktree: false, mainPath: null },
    ]);
    const status = await repoApi.recentsStatus(["/local", LOCATOR]);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("recents_status", { paths: ["/local"] });
    expect(status.map((s) => [s.path, s.exists])).toEqual([
      ["/local", false],
      [LOCATOR, true],
    ]);
  });

  it("a remote repository has no forge and never asks for one", async () => {
    await expect(remotesApi.repoForge(LOCATOR)).resolves.toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("only remote recents means no backend call at all", async () => {
    const status = await repoApi.recentsStatus([LOCATOR]);
    expect(invokeMock).not.toHaveBeenCalled();
    expect(status).toHaveLength(1);
  });
});
