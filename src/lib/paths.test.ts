import { describe, it, expect } from "vitest";
import { basename, dirname, repoLabel } from "./paths";

describe("basename", () => {
  it("returns the last segment", () => {
    expect(basename("src/lib/paths.ts")).toBe("paths.ts");
  });

  it("returns the input when there is no slash", () => {
    expect(basename("README.md")).toBe("README.md");
  });

  it("returns '' for a trailing slash", () => {
    expect(basename("src/lib/")).toBe("");
  });
});

describe("dirname", () => {
  it("returns the directory portion with a trailing slash", () => {
    expect(dirname("src/lib/paths.ts")).toBe("src/lib/");
  });

  it("returns '' when the path has no directory", () => {
    expect(dirname("README.md")).toBe("");
  });

  it("handles a single nested directory", () => {
    expect(dirname("src/App.tsx")).toBe("src/");
  });
});

describe("repoLabel", () => {
  it("uses the final path segment", () => {
    expect(repoLabel("/Users/me/code/GitLane")).toBe("GitLane");
  });

  it("ignores a trailing slash", () => {
    expect(repoLabel("/Users/me/code/GitLane/")).toBe("GitLane");
  });

  it("falls back to 'Repository' for an empty path", () => {
    expect(repoLabel("")).toBe("Repository");
  });
});
