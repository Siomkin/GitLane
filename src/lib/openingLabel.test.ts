import { describe, expect, it } from "vitest";
import { openingLabel } from "./openingLabel";

describe("openingLabel", () => {
  it("names a local repository", () => {
    expect(openingLabel("backend", null)).toBe("Opening backend…");
  });

  it("names the host while connecting", () => {
    expect(openingLabel("api", "devbox", { state: "connecting" })).toBe("Connecting to devbox…");
  });

  it("shows install stage and rounded percent", () => {
    expect(
      openingLabel("api", "devbox", { state: "installing", progress: { stage: "uploading", percent: 61.6 } }),
    ).toBe("Installing GitLane agent — uploading 62%");
    expect(openingLabel("api", "devbox", { state: "installing" })).toBe("Installing GitLane agent on devbox…");
  });

  it("names the host for any other remote state (a dead session can still read connected)", () => {
    expect(openingLabel("api", "devbox", { state: "connected" })).toBe("Opening api on devbox…");
    expect(openingLabel("api", "devbox")).toBe("Opening api on devbox…");
  });
});
