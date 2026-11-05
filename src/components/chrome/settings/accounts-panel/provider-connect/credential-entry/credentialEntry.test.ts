import { describe, it, expect } from "vitest";
import { canSubmit, githubPasswordWarning, hostFieldInitiallyEditable, resolveHost } from "./credentialEntry";

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

describe("githubPasswordWarning", () => {
  it("warns for a github.com secret without a token prefix", () => {
    expect(githubPasswordWarning("github.com", "hunter2")).toMatch(/personal access token/);
    expect(githubPasswordWarning(" GitHub.com ", "hunter2")).not.toBeNull();
  });

  it("accepts every GitHub token prefix", () => {
    for (const prefix of ["ghp_", "github_pat_", "gho_", "ghu_", "ghs_"]) {
      expect(githubPasswordWarning("github.com", `${prefix}abc`)).toBeNull();
    }
  });

  it("stays quiet for other hosts and an empty secret", () => {
    expect(githubPasswordWarning("ghe.corp.example", "0123456789abcdef0123456789abcdef01234567")).toBeNull();
    expect(githubPasswordWarning("gitlab.com", "hunter2")).toBeNull();
    expect(githubPasswordWarning("github.com", "")).toBeNull();
  });

  it("never blocks saving", () => {
    expect(canSubmit({ host: "github.com", path: "", username: "siomkin", password: "hunter2" })).toBe(true); // ggignore: test fixture
  });
});
