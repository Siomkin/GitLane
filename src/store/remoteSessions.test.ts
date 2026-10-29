import { describe, expect, it } from "vitest";
import { remoteSessionOf, useRemoteSessions } from "./remoteSessions";

describe("remoteSessions", () => {
  it("keeps the latest state per host", () => {
    const { apply } = useRemoteSessions.getState();
    apply({ origin: "ssh://devbox", state: "connecting" });
    apply({ origin: "ssh://devbox", state: "installing", progress: { stage: "uploading", percent: 40 } });
    apply({ origin: "ssh://ci", state: "connected" });

    const state = useRemoteSessions.getState();
    expect(remoteSessionOf("ssh://devbox")(state)).toEqual({
      state: "installing",
      progress: { stage: "uploading", percent: 40 },
    });
    expect(remoteSessionOf("ssh://ci")(state)?.state).toBe("connected");
    expect(remoteSessionOf("ssh://other")(state)).toBeUndefined();
  });
});
