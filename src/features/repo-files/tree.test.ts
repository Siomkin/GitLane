import { describe, expect, it } from "vitest";
import { buildFileRows, filterFiles } from "./tree";

const paths = [
  ".gitignore",
  "README.md",
  "src/app/App.tsx",
  "src/app/main.tsx",
  "src/lib/util.ts",
  "docs/guide.md",
];

describe("buildFileRows", () => {
  it("starts with top-level directories (collapsed) before root files, both sorted", () => {
    const rows = buildFileRows(paths, {});
    expect(rows.map((r) => r.key)).toEqual(["docs", "src", ".gitignore", "README.md"]);
    expect(rows.filter((r) => r.kind === "dir").every((r) => r.kind === "dir" && !r.expanded)).toBe(
      true,
    );
  });

  it("expands a directory to reveal its children at the next depth", () => {
    const rows = buildFileRows(paths, { src: true });
    const keys = rows.map((r) => r.key);
    expect(keys).toEqual([
      "docs",
      "src",
      "src/app",
      "src/lib",
      ".gitignore",
      "README.md",
    ]);
    const app = rows.find((r) => r.key === "src/app")!;
    expect(app.depth).toBe(1);
  });

  it("collapses single-child directory chains into one header", () => {
    const rows = buildFileRows(["a/b/c/file.ts", "top.ts"], {});
    const dir = rows.find((r) => r.kind === "dir")!;
    // The chain key is the full path so expansion state survives regrouping.
    expect(dir.key).toBe("a/b/c");
    expect(dir.kind === "dir" && dir.label).toBe("a/b/c");
    const opened = buildFileRows(["a/b/c/file.ts", "top.ts"], { "a/b/c": true });
    expect(opened.map((r) => r.key)).toEqual(["a/b/c", "a/b/c/file.ts", "top.ts"]);
  });

  it("lists files under their expanded parent with basenames", () => {
    const rows = buildFileRows(paths, { src: true, "src/app": true });
    const leaf = rows.find((r) => r.key === "src/app/App.tsx");
    expect(leaf).toMatchObject({ kind: "file", name: "App.tsx", depth: 2 });
  });
});

describe("filterFiles", () => {
  it("matches case-insensitively on the full path", () => {
    expect(filterFiles(paths, "APP")).toEqual(["src/app/App.tsx", "src/app/main.tsx"]);
    expect(filterFiles(paths, "src/lib")).toEqual(["src/lib/util.ts"]);
  });

  it("returns nothing for an empty or whitespace query", () => {
    expect(filterFiles(paths, "")).toEqual([]);
    expect(filterFiles(paths, "   ")).toEqual([]);
  });
});
