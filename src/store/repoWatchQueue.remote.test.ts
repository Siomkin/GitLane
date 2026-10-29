import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { useNotifications } from "./notifications";
import { watchRepo } from "./repoWatchQueue";

const notices = () => useNotifications.getState().toasts.filter((t) => t.title.startsWith("Live updates are off"));

beforeEach(() => {
  invokeMock.mockReset();
  useNotifications.setState({ toasts: [] });
});

describe("watching a remote repository", () => {
  it("tells the user once per host when the server cannot watch", async () => {
    invokeMock.mockRejectedValue({ kind: "git", message: "inotify watch limit reached" });
    await watchRepo("ssh://watchhost/srv/a");
    await watchRepo("ssh://watchhost/srv/b");
    expect(notices()).toHaveLength(1);
    expect(notices()[0].title).toBe("Live updates are off for watchhost");
    expect(notices()[0].body).toContain("inotify watch limit reached");
  });

  it("stays quiet for an unreachable host and for local repositories", async () => {
    invokeMock.mockRejectedValue({ kind: "remoteUnavailable", message: "lost" });
    await watchRepo("ssh://downhost/srv/a");
    invokeMock.mockRejectedValue({ kind: "git", message: "local failure" });
    await watchRepo("/local/repo");
    expect(notices()).toHaveLength(0);
  });
});
