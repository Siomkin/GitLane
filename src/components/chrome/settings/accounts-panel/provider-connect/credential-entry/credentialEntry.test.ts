import { describe, it, expect } from "vitest";
import { canSubmit, hostFieldInitiallyEditable, resolveHost } from "./credentialEntry";

describe("resolveHost", () => {
  it("prefers an explicitly fixed host over the provider default", () => {
    expect(resolveHost("gitlab", "git.corp.io")).toBe("git.corp.io");
    expect(resolveHost("gitlab")).toBe("gitlab.com");
    expect(resolveHost("bitbucket", null)).toBe("bitbucket.org");
  });

  it("is empty for forges with no hosted default", () => {
    expect(resolveHost("gitea")).toBe("");
    expect(resolveHost("forgejo")).toBe("");
  });
});

describe("hostFieldInitiallyEditable", () => {
  it("shows the host input from the start only when there is nothing to show", () => {
    expect(hostFieldInitiallyEditable("gitea")).toBe(true);
    expect(hostFieldInitiallyEditable("forgejo")).toBe(true);
    expect(hostFieldInitiallyEditable("gitlab")).toBe(false);
    expect(hostFieldInitiallyEditable("bitbucket")).toBe(false);
  });

  it("locks the host when it is fixed by the caller", () => {
    expect(hostFieldInitiallyEditable("gitea", "git.corp.io")).toBe(false);
    expect(hostFieldInitiallyEditable("gitlab", "git.corp.io")).toBe(false);
  });
});

describe("canSubmit", () => {
  const base = { host: "gitlab.com", path: "", username: "ada", password: "tok" };

  it("requires host, username, and token; path stays optional", () => {
    expect(canSubmit(base)).toBe(true);
    expect(canSubmit({ ...base, path: "group/repo" })).toBe(true);
    expect(canSubmit({ ...base, host: " " })).toBe(false);
    expect(canSubmit({ ...base, username: "" })).toBe(false);
    expect(canSubmit({ ...base, password: "" })).toBe(false);
  });
});
