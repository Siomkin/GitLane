import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { commitsApi } from "./commits";
import type { SquashCommitsRequest } from "./types";

beforeEach(() => invokeMock.mockReset());

describe("bundled write request validation", () => {
  it("rejects a squash request missing parentOid before invoke", async () => {
    const request = {
      expectedOid: "abc",
      summary: "folded",
      description: "",
      identity: { mode: "notCaptured" },
    } as SquashCommitsRequest;

    await expect(commitsApi.squashCommits("/r", request)).rejects.toThrow(/parentOid/);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
