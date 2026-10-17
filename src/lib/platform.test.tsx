// The DOM test environments are pinned to a Linux user agent (vitest.config.ts),
// so platform branches, and the coverage they produce, don't depend on the host
// running the suite.
import { describe, expect, it } from "vitest";

import { isLinux, isMac, isWindows } from "./platform";

describe("platform under test", () => {
  it("reads as Linux on every host", () => {
    expect({ isMac, isWindows, isLinux }).toEqual({ isMac: false, isWindows: false, isLinux: true });
  });
});
