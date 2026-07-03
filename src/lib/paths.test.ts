import { describe, it, expect } from "vitest";
import { basename, dirname, isMarkdownPath, repoLabel } from "./paths";

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

describe("isMarkdownPath", () => {
  it("matches .md and .markdown, case-insensitively", () => {
    expect(isMarkdownPath("README.md")).toBe(true);
    expect(isMarkdownPath("docs/guide.markdown")).toBe(true);
    expect(isMarkdownPath("NOTES.MD")).toBe(true);
  });

  it("rejects other extensions and md elsewhere in the name", () => {
    expect(isMarkdownPath("src/App.tsx")).toBe(false);
    expect(isMarkdownPath("archive.md.bak")).toBe(false);
    expect(isMarkdownPath("md")).toBe(false);
  });
});
