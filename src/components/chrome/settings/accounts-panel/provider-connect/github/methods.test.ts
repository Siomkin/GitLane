import { describe, expect, it } from "vitest";
import { GITHUB_METHODS, githubCapabilities, initialMethod } from "./methods";

describe("Connect GitHub methods", () => {
  it("lists CLI, Access token and SSH key in switch order", () => {
    expect(GITHUB_METHODS.map((m) => m.label)).toEqual(["GitHub CLI", "Access token", "SSH key"]);
  });

  it("opens on the token method from a failure, GitHub CLI otherwise", () => {
    expect(initialMethod("authFailure")).toBe("token");
    expect(initialMethod("permission")).toBe("token");
    expect(initialMethod(null)).toBe("cli");
    expect(initialMethod(undefined)).toBe("cli");
  });

  it("gives every method the same four capability tiles", () => {
    for (const method of GITHUB_METHODS) {
      expect(githubCapabilities(method.value).map((c) => c.label)).toEqual(["Fetch, pull", "Push", "Pull requests", "Stored by"]);
    }
    expect(githubCapabilities("cli")[2]).toMatchObject({ value: "Yes", tone: "yes" });
    expect(githubCapabilities("token")[2]).toMatchObject({ value: "Needs GitHub CLI", tone: "muted" });
    expect(githubCapabilities("token")[1].value).toBe("With write access");
  });

  it("says the token is stored where the user chose", () => {
    expect(githubCapabilities("token", "keychain")[3].value).toBe("GitLane (keychain)");
    expect(githubCapabilities("token", "helper")[3].value).toBe("Your helper");
  });
});
