import { describe, expect, it } from "vitest";
import { isRemoteLocator, remoteHost, remoteOrigin, repoLabel, withLocator } from "./paths";

describe("remote locators", () => {
  it("recognises ssh:// locators only", () => {
    expect(isRemoteLocator("ssh://devbox/srv/app")).toBe(true);
    expect(isRemoteLocator("/srv/app")).toBe(false);
    expect(isRemoteLocator("C:\\repos\\app")).toBe(false);
  });

  it("splits out the origin and host", () => {
    expect(remoteOrigin("ssh://me@devbox:2222/srv/app")).toBe("ssh://me@devbox:2222");
    expect(remoteHost("ssh://me@devbox:2222/srv/app")).toBe("me@devbox");
    expect(remoteHost("ssh://devbox/srv/app")).toBe("devbox");
  });

  it("turns server paths back into locators on the same host", () => {
    expect(withLocator("ssh://devbox/srv/app", "/srv/wt")).toBe("ssh://devbox/srv/wt");
    expect(withLocator("ssh://devbox/srv/app", "ssh://devbox/srv/wt")).toBe("ssh://devbox/srv/wt");
    expect(withLocator("/local/app", "/local/wt")).toBe("/local/wt");
  });

  it("refuses a server-supplied locator for another host", () => {
    expect(() => withLocator("ssh://devbox/srv/app", "ssh://evil/x")).toThrow();
  });

  it("never re-homes a locator when a server path lacks the leading slash", () => {
    // Each suffix, glued onto "ssh://devbox", would read as another user, host or port.
    for (const serverPath of ["@evil.example/srv/x", ".evil.example/srv/x", ":2222/srv/x", ""]) {
      expect(() => withLocator("ssh://devbox/srv/app", serverPath)).toThrow();
    }
  });

  it("labels a remote repository by its directory name", () => {
    expect(repoLabel("ssh://devbox/srv/app")).toBe("app");
  });
});
