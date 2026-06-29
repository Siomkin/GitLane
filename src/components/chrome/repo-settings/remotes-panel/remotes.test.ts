import { describe, expect, it } from "vitest";
import { detectRemoteUrl, validateRemoteUrl } from "./remotes";

describe("detectRemoteUrl", () => {
  it("parses https GitHub URLs (with and without .git)", () => {
    expect(detectRemoteUrl("https://github.com/Siomkin/GitLane.git")).toMatchObject({
      valid: true,
      host: "github.com",
      path: "Siomkin/GitLane",
      provider: "github",
    });
    expect(detectRemoteUrl("https://github.com/Siomkin/GitLane").provider).toBe("github");
  });

  it("parses scp-style SSH URLs and classifies the provider", () => {
    expect(detectRemoteUrl("git@gitlab.com:siomkin/gitlane.git")).toMatchObject({
      valid: true,
      host: "gitlab.com",
      provider: "gitlab",
    });
    expect(detectRemoteUrl("git@bitbucket.org:team/app.git").provider).toBe("bitbucket");
  });

  it("detects Azure DevOps hosts", () => {
    expect(detectRemoteUrl("https://dev.azure.com/org/proj/_git/repo").provider).toBe("azure");
  });

  it("flags unrecognised but valid hosts as 'other'", () => {
    expect(detectRemoteUrl("https://git.internal.example/team/app.git").provider).toBe("other");
  });

  it("rejects empty and malformed URLs", () => {
    expect(detectRemoteUrl("")).toMatchObject({ empty: true, valid: false });
    expect(detectRemoteUrl("not a url")).toMatchObject({ empty: false, valid: false });
    expect(detectRemoteUrl("https://github.com/only-owner")).toMatchObject({ valid: false });
  });
});

describe("validateRemoteUrl", () => {
  it("is neutral (not savable) when empty", () => {
    expect(validateRemoteUrl("")).toMatchObject({ level: "neutral", ok: false });
  });

  it("is bad (not savable) when invalid", () => {
    expect(validateRemoteUrl("nope")).toMatchObject({ level: "bad", ok: false });
  });

  it("is ok for GitHub (PRs enabled) and savable", () => {
    const v = validateRemoteUrl("https://github.com/Siomkin/GitLane.git");
    expect(v).toMatchObject({ level: "ok", ok: true });
    expect(v.message).toMatch(/pull requests enabled/);
  });

  it("warns for valid non-GitHub remotes but still allows saving", () => {
    const v = validateRemoteUrl("git@gitlab.com:siomkin/gitlane.git");
    expect(v).toMatchObject({ level: "warn", ok: true });
    expect(v.message).toMatch(/pull requests unavailable/);
  });
});
