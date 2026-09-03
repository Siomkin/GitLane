import { afterEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { providersApi } from "./providers";
import { isCommandError } from "./invoke";

afterEach(() => invokeMock.mockReset());

describe("providersApi.refreshToolProbes", () => {
  it("invokes the refresh command with no arguments and resolves void", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await expect(providersApi.refreshToolProbes()).resolves.toBeUndefined();
    // A no-argument command reaches the transport as a one-argument call —
    // that is what `generate_handler!` registers it as.
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock.mock.calls[0]).toEqual(["refresh_tool_probes"]);
  });

  it("rejects with a CommandError like every other wrapper", async () => {
    invokeMock.mockRejectedValueOnce({ kind: "internal", message: "boom" });
    await expect(providersApi.refreshToolProbes()).rejects.toSatisfy(isCommandError);
  });
});
