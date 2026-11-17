// Worktree paths typed on a remote tab (harden-remote-locator-and-askpass):
// a path without a leading '/' would re-home the tab's locator to another
// user, host or port, so it is refused before the server is asked to act.
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { summary } from "@/test/repoFixtures";
import { useRepo } from "@/store/repo";

const REMOTE = "ssh://devbox/srv/app";
const loadRepo = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue("done");
  loadRepo.mockClear();
  useRepo.setState({
    summary: { ...summary, path: REMOTE, workdir: REMOTE },
    openPaths: [REMOTE],
    loading: false,
    loadRepo,
  });
});

const serverWrites = () =>
  invokeMock.mock.calls.filter(
    ([cmd, args]) =>
      cmd === "remote_invoke" &&
      ["add_worktree", "move_branch_to_worktree"].includes((args as { command: string }).command),
  );

describe("worktree paths typed on a remote tab", () => {
  it("refuses a relative path before creating the worktree", async () => {
    await expect(useRepo.getState().createWorktreeAt("wt/feature", "main", "feature")).rejects.toThrow(
      /not absolute/,
    );
    expect(serverWrites()).toHaveLength(0);
    expect(loadRepo).not.toHaveBeenCalled();
  });

  it("refuses a relative destination before moving the branch", async () => {
    await expect(
      useRepo.getState().moveBranchToWorktree("feature", REMOTE, "@other.example/srv/x", false),
    ).rejects.toThrow(/not absolute/);
    expect(serverWrites()).toHaveLength(0);
    expect(useRepo.getState().loading).toBe(false);
  });

  it("opens an absolute path as a locator on the same host", async () => {
    await useRepo.getState().createWorktreeAt("/srv/wt", "main", "feature");
    expect(serverWrites()).toHaveLength(1);
    expect(loadRepo).toHaveBeenCalledWith("ssh://devbox/srv/wt");
  });
});
