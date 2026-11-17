import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { worktreesApi } from "./worktrees";

/** The server's `list_worktrees` answer, reached through `remote_invoke`. */
function serverLists(...paths: string[]) {
  invokeMock.mockImplementation(async (cmd: string, args: { command?: string }) =>
    cmd === "remote_invoke" && args.command === "list_worktrees"
      ? paths.map((path, i) => ({
          name: `wt${i}`,
          path,
          branch: null,
          head: null,
          isMain: i === 0,
          bare: false,
          prunable: false,
          locked: false,
        }))
      : null,
  );
}

beforeEach(() => invokeMock.mockReset());

describe("listWorktrees on a remote repository", () => {
  it("returns the server's absolute paths as locators on the same host", async () => {
    serverLists("/srv/app", "/srv/wt");
    const list = await worktreesApi.listWorktrees("ssh://devbox/srv/app");
    expect(list.map((w) => w.path)).toEqual(["ssh://devbox/srv/app", "ssh://devbox/srv/wt"]);
  });

  it("rejects a worktree path without a leading slash instead of reaching another port", async () => {
    serverLists("/srv/app", ":2222/srv/wt");
    await expect(worktreesApi.listWorktrees("ssh://devbox/srv/app")).rejects.toThrow(/not absolute/);
  });
});
