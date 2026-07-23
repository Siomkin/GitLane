import { describe, expect, it } from "vitest";
import {
  anchoredIgnorePath,
  escapeIgnoreLiteral,
  ignoreExtension,
  ignorePatternChoices,
  parentFolderIgnorePattern,
} from "./ignorePatterns";

describe("escapeIgnoreLiteral", () => {
  it("escapes gitignore glob metacharacters so names match literally", () => {
    expect(escapeIgnoreLiteral("draft[1].txt")).toBe("draft\\[1\\].txt");
    expect(escapeIgnoreLiteral("a*b?c")).toBe("a\\*b\\?c");
    expect(escapeIgnoreLiteral("back\\slash")).toBe("back\\\\slash");
  });

  it("leaves path separators and ordinary names untouched", () => {
    expect(escapeIgnoreLiteral("src/app/main.ts")).toBe("src/app/main.ts");
  });
});

describe("metacharacter escaping in choices", () => {
  it("anchors a bracketed filename as a literal, not a character class", () => {
    expect(anchoredIgnorePath("logs/draft[1].txt")).toBe("/logs/draft\\[1\\].txt");
  });

  it("escapes a metacharacter in the *.ext pattern", () => {
    const choices = ignorePatternChoices("weird.c[1]");
    const ext = choices.find((c) => c.label.startsWith("Ignore all"));
    expect(ext?.pattern).toBe("*.c\\[1\\]");
  });
});

describe("ignoreExtension", () => {
  it("returns the last extension for ordinary files", () => {
    expect(ignoreExtension("mcp.json")).toBe("json");
    expect(ignoreExtension("app.test.ts")).toBe("ts");
  });

  it("skips dotfiles without a further extension", () => {
    expect(ignoreExtension(".env")).toBeNull();
    expect(ignoreExtension(".gitignore")).toBeNull();
  });

  it("skips extension-less names", () => {
    expect(ignoreExtension("Makefile")).toBeNull();
  });
});

describe("anchoredIgnorePath / parentFolderIgnorePattern", () => {
  it("anchors and strips stray slashes", () => {
    expect(anchoredIgnorePath("infra/docker/mcp.json")).toBe("/infra/docker/mcp.json");
    expect(anchoredIgnorePath("/a/b/")).toBe("/a/b");
  });

  it("returns the parent folder pattern when nested", () => {
    expect(parentFolderIgnorePattern("infra/docker/mcp.json")).toBe("/infra/docker/");
    expect(parentFolderIgnorePattern("root.txt")).toBeNull();
  });
});

describe("ignorePatternChoices", () => {
  it("builds file choices with ext, folder, and local exclude", () => {
    const choices = ignorePatternChoices("infra/docker/mcp.json");
    expect(choices.map((c) => c.pattern)).toEqual([
      "/infra/docker/mcp.json",
      "*.json",
      "/infra/docker/",
      "/infra/docker/mcp.json",
    ]);
    expect(choices[3].local).toBe(true);
  });

  it("builds directory choices only", () => {
    const choices = ignorePatternChoices("infra/docker", { dir: true });
    expect(choices).toEqual([
      { label: "Ignore folder “docker/”", pattern: "/infra/docker/", local: false },
      { label: "Ignore folder locally (exclude)", pattern: "/infra/docker/", local: true },
    ]);
  });
});
