import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { summary } from "@/test/repoFixtures";
import { repoApi } from "./repo";

/** The server's `open_repo` answer, reached through `remote_invoke`. */
function serverReports(path: string) {
  invokeMock.mockImplementation(async (cmd: string, args: { command?: string }) =>
    cmd === "remote_invoke" && args.command === "open_repo"
      ? { ...summary, path, workdir: path }
      : null,
  );
}

beforeEach(() => invokeMock.mockReset());

describe("openRepo on a remote repository", () => {
  it("returns the server's absolute paths as locators on the same host", async () => {
    serverReports("/srv/app");
    const opened = await repoApi.openRepo("ssh://devbox/srv/app");
    expect(opened.path).toBe("ssh://devbox/srv/app");
    expect(opened.workdir).toBe("ssh://devbox/srv/app");
  });

  it("rejects a server path without a leading slash instead of re-homing the tab", async () => {
    serverReports("@evil.example/srv/x");
    await expect(repoApi.openRepo("ssh://devbox/srv/app")).rejects.toThrow(/not absolute/);
  });
});
