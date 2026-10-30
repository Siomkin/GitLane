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

  it("never turns a server-supplied path into a locator for another host", () => {
    expect(withLocator("ssh://devbox/srv/app", "ssh://evil/x")).toBe("ssh://devboxssh://evil/x");
  });

  it("labels a remote repository by its directory name", () => {
    expect(repoLabel("ssh://devbox/srv/app")).toBe("app");
  });
});
