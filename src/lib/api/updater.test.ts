import { afterEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { listReleaseNotes } from "./updater";

afterEach(() => invokeMock.mockReset());

describe("listReleaseNotes", () => {
  it("passes the range and channel and accepts null fields", async () => {
    const notes = {
      releases: [{ version: "2.4.3", name: null, publishedAt: null, body: null, url: "https://github.com/x" }],
      hasMore: false,
    };
    invokeMock.mockResolvedValueOnce(notes);
    await expect(listReleaseNotes("2.4.1", "2.4.3", false)).resolves.toEqual(notes);
    expect(invokeMock).toHaveBeenCalledWith("list_release_notes", {
      currentVersion: "2.4.1",
      offeredVersion: "2.4.3",
      beta: false,
    });
  });

  it("rejects a payload without hasMore", async () => {
    invokeMock.mockResolvedValueOnce({ releases: [] });
    await expect(listReleaseNotes("2.4.1", "2.4.3", false)).rejects.toThrow();
  });
});
