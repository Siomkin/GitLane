import { describe, it, expect } from "vitest";
import {
  basename,
  dirname,
  isMarkdownPath,
  normalizeWatchPath,
  pathsFromUriList,
  repoLabel,
} from "./paths";

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

describe("pathsFromUriList", () => {
  it("parses a single file URI to a local path", () => {
    expect(pathsFromUriList("file:///home/me/notes.txt")).toEqual([
      "/home/me/notes.txt",
    ]);
  });

  it("decodes percent-escaped characters", () => {
    expect(pathsFromUriList("file:///home/me/my%20file.txt")).toEqual([
      "/home/me/my file.txt",
    ]);
  });

  it("keeps multiple entries in order and skips comments/blanks", () => {
    const list = "# a comment\r\nfile:///a\r\n\r\nfile:///b\r\n";
    expect(pathsFromUriList(list)).toEqual(["/a", "/b"]);
  });

  it("drops non-file schemes", () => {
    expect(pathsFromUriList("https://example.com/x\nfile:///c")).toEqual(["/c"]);
  });

  it("ignores unparseable lines", () => {
    expect(pathsFromUriList("not a uri\nfile:///d")).toEqual(["/d"]);
  });

  it("returns [] for an empty payload", () => {
    expect(pathsFromUriList("")).toEqual([]);
  });
});

describe("normalizeWatchPath", () => {
  it("leaves an ordinary path untouched", () => {
    expect(normalizeWatchPath("/Users/me/repo")).toBe("/Users/me/repo");
  });

  it("trims a trailing separator so it routes/sequences like the un-slashed form", () => {
    expect(normalizeWatchPath("/Users/me/repo/")).toBe("/Users/me/repo");
    expect(normalizeWatchPath("C:\\repo\\")).toBe("C:\\repo");
  });

  it("preserves a lone filesystem-root separator", () => {
    expect(normalizeWatchPath("/")).toBe("/");
  });
});
